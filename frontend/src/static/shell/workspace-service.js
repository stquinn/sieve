// @ts-check
// workspace-service.js — WorkspaceService: the WIRE OWNER for the workspace
// channel (`GET /api/ws/workspace`), sibling of container-transport.js's per-uuid
// document channels.
//
// THE INVARIANT: ONE socket, MANY tenants. A server-initiated broadcast reaches
// every socket, so a second socket on this key double-fires every invalidation.
//
// A tenant is a WorkspaceTenant: it declares the inbound frame `type` words it
// speaks and receives exactly those. Two tenants claiming one word is a
// ContractViolation at registration. A frame no tenant claims is DROPPED — Go
// may grow vocabulary a build ahead of the frontend.
//
// The plane speaks no vocabulary of its own except `session-scroll`
// (persistScroll below): a frame with a REPLY needs a tenant to hold what is
// waiting for it, and an unanswered uncorrelated frame has no such state.

import { BlockChannel } from '../container/block-channel.js'
import { ContractViolation } from '../contract/sieve-block.js'
import { WsDial } from '../container/ws-dial.js'
import { WorkspaceFrame } from '../generated/protocol.js'

/**
 * An outbound or inbound workspace frame. Shapes are owned by the tenants and by
 * Go's workspace dispatch; this class reads only `type`, the routing key.
 * @typedef {Record<string, any> & {type?: string}} WorkspaceMessage
 */

/**
 * A tenant of the workspace channel — a protocol peer that speaks some of the
 * plane's vocabulary. Structural: CommandService is one.
 * @typedef {object} WorkspaceTenant
 * @property {readonly string[]} frameTypes  the inbound frame `type` words this tenant claims
 * @property {(frame: WorkspaceMessage) => void} onFrame  delivery of a claimed frame
 * @property {() => void} [onConnect]  optional: the socket reached OPEN. Fires on the first connect and on every reconnect alike — a tenant resyncing cannot tell them apart
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
   * workspace per window, so the mount path IS the identity. The dev-server host
   * rewrite is load-bearing — WebKitGTK cannot carry a WebSocket upgrade over the
   * app's custom scheme, so the wire always rides the loopback listener.
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

  /**
   * Claims a tenant's frame vocabulary. Registrations are plane-level, not
   * socket-level: they survive close()/re-open, so a tenant registers once at
   * construction and never re-registers on reconnect.
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

  /**
   * Mints a correlation id for a request/reply exchange on this plane.
   * Correlation is a PLANE convention, so tenants must not invent their own.
   * `c-` + a UUID rather than a counter: the Go JobEngine may still hold a queued
   * job keyed by an id from a PRIOR page session, and a resetting counter would
   * let a cancel or result land on the wrong job.
   * @returns {string}
   */
  newCorrelationId() {
    const c = typeof crypto !== 'undefined' ? crypto : null
    if (c && typeof c.randomUUID === 'function') return 'c-' + c.randomUUID()
    const rand = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0')
    return 'c-' + rand() + rand() + '-' + Date.now().toString(16)
  }

  /**
   * Opens the workspace channel if it is not already open. IDEMPOTENT — a second
   * caller joins the live wire rather than replacing it. send() calls this
   * lazily, so nothing opens a socket merely by existing.
   *
   * THE SERVER SPEAKS FIRST on this wire: a fresh socket is sent the jobs
   * snapshot before it asks for anything, so a tenant must be registered before
   * the socket opens.
   */
  open() {
    if (this.#channel) return
    this.#channel = new BlockChannel(
      (url) => this.#socketFactory(url, WsDial.protocols()),
      this.#wsUrl,
      {
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
   * scroll}). Fire-and-forget and unanswered. It names its tab because the
   * workspace channel is not bound to a document.
   * @param {string} tabId @param {number} scroll  the pixel offset from the top
   */
  persistScroll(tabId, scroll) {
    if (!tabId) return
    this.send({ type: WorkspaceFrame.SESSION_SCROLL, id: tabId, scroll: scroll })
  }

  /**
   * Delivers an inbound frame to the tenant claiming its `type`. A throwing
   * tenant is isolated: the wire and its siblings survive.
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
   * Tells every tenant that declares an interest that the socket is up. Each is
   * told ONCE however many frame words it claims.
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
