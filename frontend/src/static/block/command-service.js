// @ts-check
// command-service.js — CommandService: JS protocol peer for workspace commands.
// Wraps session-channel WebSocket transport for slash-command discovery,
// resolution, dispatch, and cancellation.

import { BlockChannel } from './block-channel.js'

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
 * @property {(url: string) => WebSocket} [socketFactory]
 * @property {() => string} [wsUrl]
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

export class CommandService {
  /** @type {(url: string) => WebSocket} */ #socketFactory
  /** @type {() => string} */ #wsUrl
  /** @type {CommandDescriptor[]} */ #commands
  /** @type {BlockChannel|null} */ #channel = null
  /** @type {Map<string, (res: CommandResult) => void>} correlationId -> onResult */ #correlations = new Map()

  /**
   * @param {CommandServiceOptions} [options]
   */
  constructor(options = {}) {
    this.#socketFactory = options.socketFactory || ((url) => new WebSocket(url))
    this.#wsUrl = options.wsUrl || (() => CommandService.#defaultUrl())
    this.#commands = options.commands || (typeof window !== 'undefined' && /** @type {any} */ (window).__sieveCommands) || []
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

  static #defaultUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    let host = location.host
    if (typeof window !== 'undefined' && /** @type {any} */ (window).__sieveDevServerPort) {
      host = '127.0.0.1:' + /** @type {any} */ (window).__sieveDevServerPort
    }
    return proto + '//' + host + '/api/ws?session=1'
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
   * Opens the session channel for command dispatch & result listening.
   * @param {import('./block-channel.js').ChannelDelegate} [delegate]
   */
  openChannel(delegate) {
    if (this.#channel) this.#channel.close()

    const channelDelegate = delegate || {
      applyServerOp: () => {},
      onFlushAck: () => {},
      onMessage: () => {},
      resolveInsertIndex: () => 0
    }

    this.#channel = new BlockChannel(
      this.#socketFactory,
      this.#wsUrl,
      {
        applyServerOp: (msg) => channelDelegate.applyServerOp(msg),
        onFlushAck: (msg) => channelDelegate.onFlushAck(msg),
        onMessage: (msg) => {
          if (msg.type === 'command-result' && msg.correlationId) {
            this.#handleResult(msg)
            return
          }
          channelDelegate.onMessage(msg)
        },
        resolveInsertIndex: (id) => channelDelegate.resolveInsertIndex(id)
      },
      () => {}
    )
  }

  /**
   * @param {Record<string, any>} msg
   */
  #handleResult(msg) {
    const cid = msg.correlationId
    const cb = this.#correlations.get(cid)
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

  /**
   * Dispatches a command over the session channel.
   * @param {string} commandName
   * @param {string} text
   * @param {Record<string, any>} context
   * @param {(res: CommandResult) => void} [onResult]
   * @returns {DispatchHandle}
   */
  dispatch(commandName, text, context, onResult) {
    if (!this.#channel) {
      this.openChannel()
    }
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

    if (this.#channel) {
      this.#channel.send(frame)
    }

    return {
      correlationId: cid,
      onResult: (fn) => {
        listeners.add(fn)
      },
      cancel: () => {
        this.#correlations.delete(cid)
        listeners.clear()
        if (this.#channel) {
          this.#channel.send({ type: 'command-cancel', correlationId: cid })
        }
      }
    }
  }

  /**
   * Closes the session channel.
   */
  closeChannel() {
    if (this.#channel) {
      this.#channel.close()
      this.#channel = null
    }
    this.#correlations.clear()
  }
}
