// @ts-check
// command-service.js — CommandService: JS protocol peer for workspace commands
// — slash-command discovery, resolution, dispatch, and cancellation.
//
// A TENANT of the session channel, not its owner (issue #74 P1): the socket
// belongs to WorkspaceService, which this class joins at construction by
// claiming the `command-result` frame word. Everything below the vocabulary
// line — correlation-id → callback tracking, the terminal-status sweep, the
// command/command-cancel envelopes — stays here; everything at or below the
// wire (URL, socket, reconnect, inbound demux) is the plane's. See
// workspace-service.js's header for why ownership had to move.

import { ContractViolation } from './sieve-block.js'

/**
 * @typedef {object} CommandDescriptor
 * @property {string} name
 * @property {string} description
 * @property {string} [family] Namespace/discovery bucket ('ai' | 'util'). Optional:
 *   older enumerations without it resolve fine and dispatch on the tolerant floor.
 * @property {string} [resultKind] Advisory block kind the command expects to return
 *   ('ai-block' | 'command-result'). Carried through only; no UI behaviour yet.
 */

/**
 * @typedef {object} CommandBlockResult
 * @property {string} kind
 * @property {Record<string, any>} attrs
 */

/**
 * @typedef {object} CommandResult
 * @property {string} correlationId
 * @property {string} cmd
 * @property {'PENDING'|'COMPLETE'|'ERROR'} status
 * @property {CommandBlockResult} [block]
 * @property {string} [error]
 */

/**
 * @typedef {object} CommandServiceOptions
 * @property {CommandDescriptor[]} [commands]
 */

/**
 * The handle returned by dispatch(): a correlation id, a listener-subscribe
 * verb, and a cancel verb. The badge lifecycle (command-badges.js) tracks a
 * dispatch by this handle, NOT by a CommandResult.
 * @typedef {object} DispatchHandle
 * @property {string} correlationId
 * @property {(fn: (res: CommandResult) => void) => void} onResult
 * @property {() => void} cancel
 */

/** The inbound frame vocabulary this tenant claims on the plane (frozen: it is
 *  handed out by the frameTypes getter). */
const COMMAND_FRAMES = Object.freeze(['command-result'])

export class CommandService {
  /** @type {import('./workspace-service.js').WorkspaceService} the session-channel wire owner */ #workspace
  /** @type {CommandDescriptor[]} */ #commands
  /** @type {Map<string, (res: CommandResult) => void>} correlationId -> onResult */ #correlations = new Map()

  /**
   * @param {import('./workspace-service.js').WorkspaceService} workspace
   *   — the session-channel wire owner (injected by the composition root).
   * @param {CommandServiceOptions} [options]
   */
  constructor(workspace, options = {}) {
    if (!workspace || typeof workspace.send !== 'function' || typeof workspace.registerTenant !== 'function') {
      throw new ContractViolation('CommandService requires a WorkspaceService')
    }
    this.#workspace = workspace
    this.#commands = options.commands || (typeof window !== 'undefined' && /** @type {any} */ (window).__sieveCommands) || []
    // Join the plane at construction: a tenant that dispatches before it can
    // hear the answer is the silent-dead-UI shape this refactor exists to
    // prevent. Registration is plane-level, so it outlives socket churn.
    this.#workspace.registerTenant(this)
  }

  // ── WorkspaceTenant contract (the plane calls these; nothing else does) ─────

  /** @returns {readonly string[]} */
  get frameTypes() { return COMMAND_FRAMES }

  /**
   * Inbound `command-result` delivery from the plane. Fans the frame out to the
   * dispatch handle's listeners and sweeps the correlation on a terminal status.
   * Unknown correlation ids are dropped (a result for a cancelled or
   * prior-session dispatch).
   * @param {Record<string, any>} msg
   */
  onFrame(msg) {
    const cid = msg && msg.correlationId
    const cb = cid ? this.#correlations.get(cid) : null
    if (!cb) return

    const res = /** @type {CommandResult} */ ({
      correlationId: cid,
      cmd: msg.cmd,
      status: msg.status,
      block: msg.block,
      error: msg.error
    })

    cb(res)

    if (res.status === 'COMPLETE' || res.status === 'ERROR') {
      this.#correlations.delete(cid)
    }
  }

  // Collision-resistant correlation id. `c-` + a UUID so an id minted in one
  // page session can never collide with one from a PRIOR session — the Go
  // JobEngine may still hold a queued job keyed by an old id after a reload, and
  // a resetting counter ('c-1', 'c-2', …) would let Cancel/result correlation
  // land on the wrong job. crypto.randomUUID is the primary; the Math.random
  // fallback keeps the non-secure/test env working (uniqueness, not crypto
  // strength, is what the correlation needs).
  static #newCid() {
    const c = typeof crypto !== 'undefined' ? crypto : null
    if (c && typeof c.randomUUID === 'function') return 'c-' + c.randomUUID()
    const rand = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0')
    return 'c-' + rand() + rand() + '-' + Date.now().toString(16)
  }

  /**
   * Returns registered command descriptors available for autocomplete/hinting.
   * @returns {CommandDescriptor[]}
   */
  list() {
    return this.#commands
  }

  /**
   * Resolves a user input string to a command descriptor + remaining args, or null.
   * Input must start with `/`. Matching is case-insensitive.
   * @param {string} input
   * @returns {{ cmd: CommandDescriptor, args: string } | null}
   */
  resolve(input) {
    if (!input || !input.startsWith('/')) return null
    const line = input.slice(1).trimStart()
    const spaceIdx = line.indexOf(' ')
    const name = (spaceIdx >= 0 ? line.slice(0, spaceIdx) : line).toLowerCase()
    const args = spaceIdx >= 0 ? line.slice(spaceIdx + 1).trim() : ''

    const cmd = this.#commands.find((c) => c.name.toLowerCase() === name)
    if (!cmd) return null
    return { cmd: cmd, args: args }
  }

  /**
   * Dispatches a command over the session channel. The plane opens the wire
   * lazily on the first send.
   * @param {string} commandName
   * @param {string} text
   * @param {Record<string, any>} context
   * @param {(res: CommandResult) => void} [onResult]
   * @returns {DispatchHandle}
   */
  dispatch(commandName, text, context, onResult) {
    const cid = CommandService.#newCid()

    /** @type {Set<(res: CommandResult) => void>} */
    const listeners = new Set()
    if (onResult) listeners.add(onResult)

    this.#correlations.set(cid, (res) => {
      listeners.forEach((fn) => fn(res))
    })

    // Family is the descriptor's own namespace declaration, not a hardcoded
    // assumption: look it up and send it so Go can integrity-check the invocation.
    // Missing descriptor / no family → omit it (empty), matching Go's tolerant floor.
    const descriptor = this.#commands.find((c) => c.name.toLowerCase() === commandName.toLowerCase())
    const frame = {
      type: 'command',
      family: (descriptor && descriptor.family) || '',
      cmd: commandName,
      args: { text: text },
      correlationId: cid,
      context: context || {}
    }

    this.#workspace.send(frame)

    return {
      correlationId: cid,
      onResult: (fn) => {
        listeners.add(fn)
      },
      cancel: () => {
        this.#correlations.delete(cid)
        listeners.clear()
        this.#workspace.send({ type: 'command-cancel', correlationId: cid })
      }
    }
  }
}
