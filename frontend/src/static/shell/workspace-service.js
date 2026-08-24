// @ts-check
// workspace-service.js — WorkspaceService: the WIRE OWNER for the workspace
// channel (`GET /api/ws/workspace`), the sibling of container-transport.js's per-uuid
// document channels.
//
// THE INVARIANT: ONE socket, MANY tenants. A second socket on the same workspace
// key is exactly the shape that produced silent-dead-UI on document channels
// (ownership guard 6e2ccfc, claim-on-write b8c209e) — Go answers a correlated
// frame to the socket that asked, but a server-initiated broadcast reaches every
// socket, so two would double-fire every invalidation as well.
//
// A tenant is a WorkspaceTenant: it declares the inbound frame `type` words it
// speaks and receives exactly those. The routing table is a claim registry, not
// a broadcast — two tenants claiming one word is a ContractViolation at
// registration, not a coin flip at delivery. A frame no tenant claims is
// dropped: the plane is open-ended by design (Go may grow vocabulary a build
// ahead of the frontend), so an unclaimed word is news, not an error.
//
// The plane speaks NO vocabulary of its own with one exception, and the rule
// behind it is worth stating because it decides where the next frame goes: a
// frame with a REPLY needs somewhere to keep what is waiting for it, and that
// somewhere is a tenant. An unanswered, uncorrelated frame has no such state, so
// a tenant for it would be a class with one method and no fields. `session-scroll`
// (persistScroll below) is the only such frame today.
//
// ONE instance, constructed in the Workspace composition root and handed to its
// tenants by constructor injection (idiomatic-js §5 — never window.*).

import { BlockChannel } from '../container/block-channel.js'
import { ContractViolation } from '../contract/sieve-block.js'
import { WsDial } from '../container/ws-dial.js'
import { WorkspaceFrame } from '../generated/protocol.js'

/**
 * An outbound or inbound workspace frame. Shapes are owned by the tenants and by
 * Go's workspace dispatch (`requesthandlers/ws_handler.go`); this class reads only
 * `type`, which is the routing key. Named WorkspaceMessage, not WorkspaceFrame,
 * because the generated `WorkspaceFrame` this module imports is the enum of type
 * WORDS — one name for both would make every annotation ambiguous.
 * @typedef {Record<string, any> & {type?: string}} WorkspaceMessage
 */

/**
 * A tenant of the workspace channel — a protocol peer that speaks some of the
 * plane's vocabulary. Structural, per idiomatic-js §2a: CommandService is one.
 * @typedef {object} WorkspaceTenant
 * @property {readonly string[]} frameTypes  the inbound frame `type` words this tenant claims
 * @property {(frame: WorkspaceMessage) => void} onFrame  delivery of a claimed frame
 * @property {() => void} [onConnect]  optional: the socket reached OPEN. Fires on the first connect and on every reconnect alike — a tenant resyncing cannot tell them apart, and a reconnect is precisely when it missed the most
 */

/**
 * @typedef {object} WorkspaceServiceOptions
 * @property {(url: string, protocols?: string[]) => WebSocket} [socketFactory]
 *   — injected for tests; defaults to `new WebSocket(url, protocols)`
 * @property {() => string} [wsUrl]
 *   — injected for tests; defaults to the /api/ws/workspace URL
 */

export class WorkspaceService {
  /** @type {(url: string, protocols?: string[]) => WebSocket} */ #socketFactory
  /** @type {() => string} */ #wsUrl
  /** @type {BlockChannel|null} the ONE workspace channel (null = not yet opened / closed) */ #channel = null
  /** @type {Map<string, WorkspaceTenant>} frame type → the ONE tenant claiming it */ #tenants = new Map()

  /** @param {WorkspaceServiceOptions} [options] the test seams (empty in prod) */
  constructor(options = {}) {
    this.#socketFactory = options.socketFactory || ((url, protocols) => new WebSocket(url, protocols))
    this.#wsUrl = options.wsUrl || (() => WorkspaceService.#defaultUrl())
  }

  /**
   * The production workspace-channel URL. It takes no parameters: there is one
   * workspace per window, so the mount path IS the identity.
   *
   * The dev-server host rewrite is load-bearing: WebKitGTK cannot carry a
   * WebSocket upgrade over the app's custom scheme, so the wire always rides the
   * loopback listener.
   * @returns {string}
   */
  static #defaultUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    let host = location.host
    if (typeof window !== 'undefined' && /** @type {any} */ (window).__sieveDevServerPort) {
      host = '127.0.0.1:' + /** @type {any} */ (window).__sieveDevServerPort
    }
    return proto + '//' + host + '/api/ws/workspace'
  }

  // ── Tenancy ────────────────────────────────────────────────────────────────

  /**
   * Claims a tenant's frame vocabulary on the plane. Registrations are
   * plane-level, not socket-level: they survive close()/re-open, so a tenant
   * registers once at construction and never re-registers on reconnect.
   * @param {WorkspaceTenant} tenant
   * @returns {() => void} unregister (releases the claimed types)
   */
  registerTenant(tenant) {
    if (!tenant || typeof tenant.onFrame !== 'function') {
      throw new ContractViolation('WorkspaceService.registerTenant: tenant must implement onFrame(frame)')
    }
    const types = tenant.frameTypes || []
    if (types.length === 0) {
      throw new ContractViolation('WorkspaceService.registerTenant: tenant must declare at least one frame type')
    }
    // Validate the WHOLE vocabulary before claiming any of it: a conflict must
    // leave the table untouched, never half-claimed by a rejected tenant.
    for (const type of types) {
      if (this.#tenants.has(type)) {
        throw new ContractViolation('WorkspaceService.registerTenant: frame type already claimed: ' + type)
      }
    }
    for (const type of types) this.#tenants.set(type, tenant)
    return () => {
      for (const type of types) {
        if (this.#tenants.get(type) === tenant) this.#tenants.delete(type)
      }
    }
  }

  // ── Correlation ────────────────────────────────────────────────────────────

  /**
   * Mints a correlation id for a request/reply exchange on this plane.
   *
   * IT LIVES HERE, NOT ON A TENANT: correlation is a PLANE convention (Go's
   * `replyTo` answers every correlated workspace frame requester-affinely,
   * whatever the frame word), so commands and mentions must not each invent
   * their own scheme. `c-` + a UUID so an id minted in one page session can
   * never collide with one from a PRIOR session — the Go JobEngine may still
   * hold a queued job keyed by an old id after a reload, and a resetting counter
   * ('c-1', 'c-2', …) would let a cancel/result land on the wrong job.
   * crypto.randomUUID is the primary; the Math.random fallback keeps the
   * non-secure/test env working (uniqueness, not crypto strength, is the need).
   * @returns {string}
   */
  newCorrelationId() {
    const c = typeof crypto !== 'undefined' ? crypto : null
    if (c && typeof c.randomUUID === 'function') return 'c-' + c.randomUUID()
    const rand = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0')
    return 'c-' + rand() + rand() + '-' + Date.now().toString(16)
  }

  // ── Channel lifecycle ──────────────────────────────────────────────────────

  /**
   * Opens the workspace channel if it is not already open. IDEMPOTENT — this is
   * the one-socket invariant: unlike a per-uuid document channel there is
   * nothing to take over, so a second caller joins the live wire rather than
   * replacing it. send() calls this lazily, so nothing opens a socket merely by
   * existing.
   *
   * THE SERVER SPEAKS FIRST on this wire: a fresh socket is sent the jobs
   * snapshot before it asks for anything. A tenant must therefore be registered
   * before the socket opens, which is why every tenant registers in its own
   * constructor rather than on first use.
   */
  open() {
    if (this.#channel) return
    this.#channel = new BlockChannel(
      // The channel owns the socket's LIFE; dialling it — url and credential
      // alike — is the wire owner's business, so it is bound here.
      (url) => this.#socketFactory(url, WsDial.protocols()),
      this.#wsUrl,
      {
        // The workspace channel carries no document traffic: everything inbound
        // the transport does not settle itself is a tenant frame.
        onMessage: (msg) => this.#route(msg),
        onOpen: () => this.#announceConnect(),
      },
      () => {},
    )
  }

  /** Closes the workspace channel (no reconnect). Tenant claims are kept. */
  close() {
    if (!this.#channel) return
    this.#channel.close()
    this.#channel = null
  }

  /**
   * Puts a frame on the workspace channel, opening it lazily. Frames sent before
   * the socket is OPEN are queued by the channel and replayed on connect.
   * @param {WorkspaceMessage} frame
   */
  send(frame) {
    this.open()
    if (this.#channel) this.#channel.send(frame)
  }

  /**
   * Persists one tab's scroll offset (frame frozen: {type:'session-scroll', id,
   * scroll}). Fire-and-forget and unanswered — this is caret-class view state,
   * not a shared UI change, so there is nothing to await and nothing to swap.
   *
   * It names its tab because the workspace channel is not bound to a document:
   * the tab may be any tab, open document or not.
   * @param {string} tabId @param {number} scroll  the pixel offset from the top
   */
  persistScroll(tabId, scroll) {
    if (!tabId) return
    this.send({ type: WorkspaceFrame.SESSION_SCROLL, id: tabId, scroll: scroll })
  }

  // ── Inbound routing ────────────────────────────────────────────────────────

  /**
   * Delivers an inbound frame to the tenant claiming its `type`. Unclaimed (or
   * type-less) frames are dropped — see the header on why that is not an error.
   * A throwing tenant is isolated: the wire and its siblings survive.
   * @param {WorkspaceMessage} frame
   */
  #route(frame) {
    const type = frame && frame.type
    const tenant = type ? this.#tenants.get(type) : null
    if (!tenant) {
      console.debug('[workspace-service] no tenant for frame type, dropped', type)
      return
    }
    try {
      tenant.onFrame(frame)
    } catch (e) {
      console.error('[workspace-service] tenant threw handling ' + type, e)
    }
  }

  /**
   * Tells every tenant that declares an interest that the socket is up, so it can
   * resync whatever it may have missed while it was down. Each tenant is told
   * ONCE however many frame words it claims (the table keys on words, tenants
   * repeat across them), and a throwing tenant is isolated like an inbound one.
   */
  #announceConnect() {
    for (const tenant of new Set(this.#tenants.values())) {
      if (!tenant.onConnect) continue
      try {
        tenant.onConnect()
      } catch (e) {
        console.error('[workspace-service] tenant threw on connect', e)
      }
    }
  }
}
