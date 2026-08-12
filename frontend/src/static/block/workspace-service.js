// @ts-check
// workspace-service.js — WorkspaceService: the WIRE OWNER for the workspace
// command plane's session channel (`/api/ws?session=1`, Go's `__session__`
// sentinel), the sibling of block-service.js's per-uuid document channels.
//
// Issue #74 P1 moved this ownership OFF CommandService. While slash commands
// were the channel's only tenant, "the command service owns the socket" and
// "the session channel has an owner" were the same sentence; `@`-mentions
// (#74 P3, mention-query/mention-result) are the second tenant and the first
// non-command one, which separates them. The alternative — a second socket on
// the same session key — is exactly the shape that produced silent-dead-UI on
// document channels (ownership guard 6e2ccfc, claim-on-write b8c209e). Hence
// the invariant this class exists to hold: ONE socket, MANY tenants.
//
// A tenant is a WorkspaceTenant: it declares the inbound frame `type` words it
// speaks and receives exactly those. The routing table is a claim registry, not
// a broadcast — two tenants claiming one word is a ContractViolation at
// registration, not a coin flip at delivery. A frame no tenant claims is
// dropped: the plane is open-ended by design (Go may grow vocabulary a build
// ahead of the frontend), so an unclaimed word is news, not an error.
//
// ONE instance, constructed in the Workspace composition root and handed to its
// tenants by constructor injection (idiomatic-js §5 — never window.*).

import { BlockChannel } from './block-channel.js'
import { ContractViolation } from './sieve-block.js'

/**
 * An outbound or inbound session frame. Shapes are owned by the tenants and by
 * Go's session dispatch (`requesthandlers/ws_handler.go`); this class reads only
 * `type`, which is the routing key.
 * @typedef {Record<string, any> & {type?: string}} WorkspaceFrame
 */

/**
 * A tenant of the session channel — a protocol peer that speaks some of the
 * plane's vocabulary. Structural, per idiomatic-js §2a: CommandService is one.
 * @typedef {object} WorkspaceTenant
 * @property {readonly string[]} frameTypes  the inbound frame `type` words this tenant claims
 * @property {(frame: WorkspaceFrame) => void} onFrame  delivery of a claimed frame
 */

/**
 * @typedef {object} WorkspaceServiceOptions
 * @property {(url: string) => WebSocket} [socketFactory]
 *   — injected for tests; defaults to `new WebSocket(url)`
 * @property {() => string} [wsUrl]
 *   — injected for tests; defaults to the /api/ws?session=1 URL
 */

export class WorkspaceService {
  /** @type {(url: string) => WebSocket} */ #socketFactory
  /** @type {() => string} */ #wsUrl
  /** @type {BlockChannel|null} the ONE session channel (null = not yet opened / closed) */ #channel = null
  /** @type {Map<string, WorkspaceTenant>} frame type → the ONE tenant claiming it */ #tenants = new Map()

  /** @param {WorkspaceServiceOptions} [options] the test seams (empty in prod) */
  constructor(options = {}) {
    this.#socketFactory = options.socketFactory || ((url) => new WebSocket(url))
    this.#wsUrl = options.wsUrl || (() => WorkspaceService.#defaultUrl())
  }

  /** @returns {string} the production session-channel URL */
  static #defaultUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    let host = location.host
    if (typeof window !== 'undefined' && /** @type {any} */ (window).__sieveDevServerPort) {
      host = '127.0.0.1:' + /** @type {any} */ (window).__sieveDevServerPort
    }
    return proto + '//' + host + '/api/ws?session=1'
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
   * `replyTo` answers every correlated session frame requester-affinely,
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
   * Opens the session channel if it is not already open. IDEMPOTENT — this is
   * the one-socket invariant: unlike a per-uuid document channel there is
   * nothing to take over, so a second caller joins the live wire rather than
   * replacing it. send() calls this lazily, so nothing opens a socket merely by
   * existing (parity with the pre-#74 behaviour, where the socket appeared on
   * the first dispatch).
   */
  open() {
    if (this.#channel) return
    this.#channel = new BlockChannel(
      this.#socketFactory,
      this.#wsUrl,
      {
        // The session channel carries no document traffic: no render-back ops,
        // no flush acks, no index math. Everything inbound is a tenant frame.
        applyServerOp: () => {},
        onFlushAck: () => {},
        onMessage: (msg) => this.#route(msg),
        resolveInsertIndex: () => 0,
      },
      () => {},
    )
  }

  /** Closes the session channel (no reconnect). Tenant claims are kept. */
  close() {
    if (!this.#channel) return
    this.#channel.close()
    this.#channel = null
  }

  /**
   * Puts a frame on the session channel, opening it lazily. Frames sent before
   * the socket is OPEN are queued by the channel and replayed on connect.
   * @param {WorkspaceFrame} frame
   */
  send(frame) {
    this.open()
    if (this.#channel) this.#channel.send(frame)
  }

  // ── Inbound routing ────────────────────────────────────────────────────────

  /**
   * Delivers an inbound frame to the tenant claiming its `type`. Unclaimed (or
   * type-less) frames are dropped — see the header on why that is not an error.
   * A throwing tenant is isolated: the wire and its siblings survive.
   * @param {WorkspaceFrame} frame
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
}
