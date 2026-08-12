// @ts-check
// trigger-providers.js — the composer's TRIGGER PROVIDER family (#74 P4).
//
// One popover (trigger-popover.js) owns the shared half — keyboard model,
// positioning, scroll-into-view (#63), blur, the token-under-caret scan. A
// provider owns the trigger-specific half and nothing else:
//
//   trigger            the character that opens it
//   acceptsBoundary()  what must sit BEFORE the trigger for it to count
//   acceptsPrefix()    how far PAST the trigger its token may run
//   search(prefix)     candidates — an array (synchronous) or a promise of one
//   render(item)       the row's content
//   accept(item, …)    what accepting DOES
//
// THE TWO PREDICATES ARE ONE PER SIDE OF THE TRIGGER, and each trigger overrides
// exactly one of them — that symmetry is why the scanner has no if-branch in it:
//   • `/` overrides the BOUNDARY rule (a command is a whole-line verb, so only
//     position 0 counts) and keeps the default span (a token ends at whitespace);
//   • `@` keeps the default boundary (start of text or after whitespace, so
//     `me@example` is an address) and overrides the SPAN, because a document
//     title is several words: `@sprite sheet an` is still one token.
//
// `@` also CANNOT ENUMERATE AT BOOT — the library is unbounded, so search() is a
// debounced round-trip returning a promise, where the command list is a
// boot-shipped array returned synchronously.
//
// Nothing here speaks transport: MentionProvider holds a MentionService (the
// session-plane tenant) and calls one verb on it (#49 — the UI stays
// transport-blind).

import { ContractViolation } from '../block/sieve-block.js'

/**
 * The token the caret currently sits in — minted by TriggerPopover.scanToken,
 * frozen because a provider reads it and never edits it.
 * @typedef {object} TriggerToken
 * @property {TriggerProvider} provider  the provider claiming this token's trigger
 * @property {number} start   index of the trigger character
 * @property {number} end     the caret (exclusive end of the token)
 * @property {string} prefix  what the user has typed since the trigger
 */

// ── The abstract provider ────────────────────────────────────────────────────

export class TriggerProvider {
  /** The character that opens this provider's picker. @returns {string} */
  get trigger() {
    throw new ContractViolation(`${this.constructor.name} must declare a trigger`)
  }

  /**
   * Does a trigger at `start`, preceded by `before`, actually open this picker?
   * The DEFAULT is the mid-text rule — a trigger at the start of the text or
   * after whitespace — because that is the general case; `/` is the restrictive
   * one and overrides.
   * @param {string} before  the character before the trigger ('' at index 0)
   * @param {number} _start  the trigger's index
   * @returns {boolean}
   */
  acceptsBoundary(before, _start) { return before === '' || /\s/.test(before) }

  /**
   * Is `prefix` — everything typed since the trigger — still part of this
   * provider's token? This is TOKEN STICKINESS, and it is a trait rather than a
   * rule in the scanner: the DEFAULT is that a token ends at the first
   * whitespace (one word, which is what a command name is), and a provider whose
   * candidates are named in several words overrides it.
   * @param {string} prefix  the text between the trigger and the caret
   * @returns {boolean}
   */
  acceptsPrefix(prefix) { return !/\s/.test(prefix) }

  /**
   * The candidates for `prefix` — an ARRAY for a provider that can enumerate
   * locally, or a PROMISE of one for a provider that must ask Go. The popover
   * renders a synchronous answer synchronously (that is what keeps `/`
   * byte-identical) and guards an async one against being overtaken.
   * @param {string} _prefix
   * @returns {any[]|Promise<any[]>}
   */
  search(_prefix) {
    throw new ContractViolation(`${this.constructor.name} must implement search(prefix)`)
  }

  /**
   * The row content for one candidate. Use renderRow() for the house look.
   * @param {any} _item
   * @returns {Node}
   */
  render(_item) {
    throw new ContractViolation(`${this.constructor.name} must implement render(item)`)
  }

  /**
   * Apply an accepted candidate. Providers call replaceToken() for the text edit
   * and then do whatever else acceptance means to them (a mention also attaches).
   * @param {any} _item @param {TriggerToken} _token @param {HTMLTextAreaElement} _textarea
   */
  accept(_item, _token, _textarea) {
    throw new ContractViolation(`${this.constructor.name} must implement accept(item, token, textarea)`)
  }

  // ── Shared behaviour (on the type that owns the token contract) ────────────

  /**
   * Substitutes `text` for the token under the caret and leaves the caret one
   * character past it. The trailing gap is REUSED, not duplicated: a completion
   * accepted mid-sentence ("How does @au| handle this?") must not leave a double
   * space behind it, while one accepted at the end of the line still gets the
   * separator that lets the next word be typed straight away.
   * @protected
   * @param {HTMLTextAreaElement} textarea @param {TriggerToken} token @param {string} text
   */
  replaceToken(textarea, token, text) {
    const value = textarea.value
    const after = value.slice(token.end)
    const gap = /^\s/.test(after) ? '' : ' '
    textarea.value = value.slice(0, token.start) + text + gap + after
    textarea.focus()
    const caret = token.start + text.length + 1
    textarea.setSelectionRange(caret, caret)
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }))
  }

  /**
   * The house row: a bold leading label and a dim trailing detail. Shared so the
   * two triggers are visually ONE picker rather than two that happen to overlap.
   * @protected
   * @param {string} label @param {string} [detail]
   * @returns {DocumentFragment}
   */
  renderRow(label, detail) {
    const frag = document.createDocumentFragment()

    const nameEl = document.createElement('span')
    nameEl.className = 'command-hint__name'
    nameEl.style.cssText = 'font-family: var(--theme-monoFont, monospace); font-weight: 600; color: var(--theme-accentPrimary, #7aa2f7);'
    nameEl.textContent = label

    const descEl = document.createElement('span')
    descEl.className = 'command-hint__desc'
    descEl.style.cssText = 'font-size: 12px; opacity: 0.75; margin-left: 12px;'
    descEl.textContent = detail || ''

    frag.appendChild(nameEl)
    frag.appendChild(descEl)
    return frag
  }
}

// ── `/` — slash commands ─────────────────────────────────────────────────────

/**
 * @typedef {object} CommandLister
 * @property {() => Array<{name: string, description?: string}>} list
 */

export class SlashCommandProvider extends TriggerProvider {
  /** @type {CommandLister} */ #commands

  /** @param {CommandLister} commandService the boot-shipped command enumeration */
  constructor(commandService) {
    super()
    if (!commandService || typeof commandService.list !== 'function') {
      throw new ContractViolation('SlashCommandProvider requires a command lister')
    }
    this.#commands = commandService
  }

  get trigger() { return '/' }

  /** A command is a whole-line verb: only a slash at position 0 opens it.
   *  @param {string} _before @param {number} start @returns {boolean} */
  acceptsBoundary(_before, start) { return start === 0 }

  /** The command list ships as boot state — enumerable locally, so SYNCHRONOUS.
   *  @param {string} prefix @returns {Array<{name: string, description?: string}>} */
  search(prefix) {
    const p = (prefix || '').toLowerCase()
    return (this.#commands.list() || []).filter((c) => c.name.toLowerCase().startsWith(p))
  }

  /** @param {{name: string, description?: string}} cmd @returns {Node} */
  render(cmd) { return this.renderRow('/' + cmd.name, cmd.description) }

  /** @param {{name: string}} cmd @param {TriggerToken} token @param {HTMLTextAreaElement} textarea */
  accept(cmd, token, textarea) { this.replaceToken(textarea, token, '/' + cmd.name) }
}

// ── `@` — document mentions ──────────────────────────────────────────────────

/**
 * @typedef {object} CandidateSource
 * @property {(q: string, limit?: number) => Promise<import('../block/mention-service.js').MentionCandidate[]>} search
 */

/**
 * @typedef {object} MentionProviderOptions
 * @property {number} [debounceMs]
 *   — the typing-cadence window. It lives HERE and
 *   not in MentionService: the service round-trips what it is asked, the
 *   provider is the thing watching a keyboard.
 * @property {number} [limit]
 */

/** Long enough to skip the middle of a word, short enough to feel live. */
const DEFAULT_DEBOUNCE_MS = 120

/**
 * The runaway backstop. A sticky token stops itself the moment a query comes
 * back dry (the popover abandons it), so these bounds only ever bite the token
 * that KEEPS matching — a common word in a long sentence. They are what
 * guarantees an unaccepted `@` cannot query for ever, independently of what the
 * library happens to contain.
 */
const MAX_TOKEN_WORDS = 4
const MAX_TOKEN_CHARS = 60

export class MentionProvider extends TriggerProvider {
  /** @type {CandidateSource} */ #source
  /** @type {(c: import('../block/mention-service.js').MentionCandidate) => void} */ #onAccept
  /** @type {number} */ #debounceMs
  /** @type {number|undefined} */ #limit
  /** @type {ReturnType<typeof setTimeout>|null} */ #timer = null
  /** @type {((c: any[]) => void)|null} the in-flight debounce's resolver, kept so a
   *  superseded keystroke's promise settles instead of dangling for ever */ #superseded = null

  /**
   * @param {CandidateSource} source  the MentionService (the plane tenant)
   * @param {(c: import('../block/mention-service.js').MentionCandidate) => void} [onAccept]
   *   — the composer's attachment sink; accepting a candidate both echoes
   *   `@Title` into the text AND hands the candidate here.
   * @param {MentionProviderOptions} [options]
   */
  constructor(source, onAccept, options = {}) {
    super()
    if (!source || typeof source.search !== 'function') {
      throw new ContractViolation('MentionProvider requires a candidate source')
    }
    this.#source = source
    this.#onAccept = onAccept || (() => {})
    this.#debounceMs = options.debounceMs == null ? DEFAULT_DEBOUNCE_MS : options.debounceMs
    this.#limit = options.limit
  }

  get trigger() { return '@' }

  /**
   * A MENTION TOKEN SURVIVES SPACES, because a document is named in words:
   * `@sprite sheet an` is one token narrowing towards "Sprite Sheet Analysis",
   * where `/btw hello` is a command plus an argument. What stops it is the
   * popover's dry stop (no candidates ⇒ the token is abandoned) with these
   * bounds as the backstop for a token that never goes dry.
   *
   * A NEWLINE still terminates it: Shift+Enter starts a new line of the message,
   * and a token that spanned it would keep a picker open across the break.
   * @param {string} prefix @returns {boolean}
   */
  acceptsPrefix(prefix) {
    if (prefix.length > MAX_TOKEN_CHARS) return false
    if (/[\n\r]/.test(prefix)) return false
    return (prefix.match(/\s+/g) || []).length < MAX_TOKEN_WORDS
  }

  /**
   * The library is unbounded, so this is a DEBOUNCED ROUND-TRIP rather than a
   * local filter. A BLANK prefix never queries: Go answers an empty query with
   * nothing (NotesSource.Search floors on a blank query), so the frame would buy
   * an empty list at the cost of a socket write on every `@` keystroke — and
   * since the token is sticky, "@ " is blank too.
   * @param {string} prefix @returns {Promise<any[]>}
   */
  search(prefix) {
    this.#cancelPending()
    if (!prefix || !prefix.trim()) return Promise.resolve([])
    return new Promise((resolve) => {
      this.#superseded = resolve
      this.#timer = setTimeout(() => {
        this.#timer = null
        this.#superseded = null
        this.#source.search(prefix, this.#limit).then(resolve)
      }, this.#debounceMs)
    })
  }

  /** @param {import('../block/mention-service.js').MentionCandidate} c @returns {Node} */
  render(c) { return this.renderRow('@' + c.title, c.detail) }

  /**
   * Accepting inserts the LITERAL `@Title` and hands the candidate to the
   * composer. The text echo stays plain on purpose: two documents called "Notes"
   * produce two identical tokens and two different chips — the ambiguity lives
   * in the echo, never in the data.
   * @param {import('../block/mention-service.js').MentionCandidate} c
   * @param {TriggerToken} token @param {HTMLTextAreaElement} textarea
   */
  accept(c, token, textarea) {
    this.replaceToken(textarea, token, '@' + c.title)
    this.#onAccept(c)
  }

  /** Drops an in-flight debounce, settling its promise empty (the popover's
   *  staleness guard discards it; an unsettled promise would leak). */
  #cancelPending() {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null }
    if (this.#superseded) { const r = this.#superseded; this.#superseded = null; r([]) }
  }
}
