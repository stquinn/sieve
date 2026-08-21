// @ts-check
// command-service.js — CommandService: JS protocol peer for workspace commands
// — slash-command discovery, resolution, dispatch, and cancellation.
//
// A TENANT of the workspace channel, not its owner: the socket belongs to
// WorkspaceService, which this class joins at construction by claiming the
// `command-result` frame word. Everything below the vocabulary line —
// correlation-id → callback tracking, the terminal-status sweep, the
// command/command-cancel envelopes — stays here; everything at or below the
// wire (URL, socket, reconnect, inbound demux) is the plane's.

import { ContractViolation } from './sieve-block.js'
import { WorkspaceFrame, CommandFamily, CommandWords } from '../generated/protocol.js'

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
const COMMAND_FRAMES = Object.freeze([WorkspaceFrame.COMMAND_RESULT])

/**
 * The AI filing verbs, as Go registers them in the `ai` family. Sourced from the
 * generated CommandWords so a rename on the Go side cannot drift silently: the
 * only thing a mismatch would produce is an ERROR result nobody is watching for.
 */
const FILING_VERBS = Object.freeze([
  CommandWords[CommandFamily.AI].FILE,
  CommandWords[CommandFamily.AI].METADATA,
  CommandWords[CommandFamily.AI].KEEP_AND_FILE,
])

export class CommandService {
  /** @type {import('./workspace-service.js').WorkspaceService} the workspace-channel wire owner */ #workspace
  /** @type {CommandDescriptor[]} */ #commands
  /** @type {Map<string, (res: CommandResult) => void>} correlationId -> onResult */ #correlations = new Map()

  /**
   * @param {import('./workspace-service.js').WorkspaceService} workspace
   *   — the workspace-channel wire owner (injected by the composition root).
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
   * Dispatches a command over the workspace channel. The plane opens the wire
   * lazily on the first send.
   * @param {string} commandName
   * @param {string} text
   * @param {Record<string, any>|null} context
   *   — the lens-authored context, or null when there is none (an empty object
   *   goes on the wire either way; the frame assembly below is what decides).
   * @param {(res: CommandResult) => void} [onResult]
   * @param {Array<{uri: string, title?: string}>} [attachments]
   *   — the composer's attachment manifest for THIS invocation. See the frame
   *   assembly below for why it is not folded into `context`.
   * @returns {DispatchHandle}
   */
  dispatch(commandName, text, context, onResult, attachments) {
    const cid = this.#workspace.newCorrelationId()

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
    // `attachments` is a TOP-LEVEL SIBLING of `context`, never a key inside it.
    // Go's commandEnvelope reads it as its own field and its Context.Attachments
    // is `json:"-"`, so an attachments key smuggled into the lens-authored
    // context JSON is silently ignored — context is lens-authored, attachments
    // are composer-authored, and the wire keeps them apart on purpose.
    const frame = {
      type: WorkspaceFrame.COMMAND,
      family: (descriptor && descriptor.family) || '',
      cmd: commandName,
      args: { text: text },
      correlationId: cid,
      context: context || {},
      attachments: attachments || []
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
        this.#workspace.send({ type: WorkspaceFrame.COMMAND_CANCEL, correlationId: cid })
      }
    }
  }

  /**
   * Asks the AI to file a document — the `ai` family's three verbs, which the
   * document's own menu invokes without the user ever typing a slash.
   *
   * It is a NAMED VERB rather than a raw dispatch call because the document is
   * the whole argument and it travels in an easily-mistyped place: `docUuid`
   * inside the lens-authored context, which is where Go's FilingCommand.Build
   * reads it and where an omission is a refusal the caller never sees (filing
   * produces no result block, so nothing appears either way). Both mistakes fail
   * loudly here instead.
   * @param {'file'|'metadata'|'keep-and-file'} verb
   * @param {string} docUuid  the document to file
   * @param {(res: CommandResult) => void} [onResult]
   * @returns {DispatchHandle}
   */
  dispatchFiling(verb, docUuid, onResult) {
    if (FILING_VERBS.indexOf(verb) < 0) {
      throw new ContractViolation('CommandService.dispatchFiling: unknown filing verb: ' + verb)
    }
    if (!docUuid) {
      throw new ContractViolation('CommandService.dispatchFiling: /' + verb + ' needs a document')
    }
    return this.dispatch(verb, '', { docUuid: docUuid }, onResult)
  }
}
