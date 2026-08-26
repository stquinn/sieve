// @ts-check
// The composer's TRIGGER PROVIDER family.
//
// One popover (trigger-popover.js) owns the shared half — keyboard model,
// scroll-into-view, dismissal — and a HOST (trigger-host.js) owns the surface it
// all happens in. A provider owns the trigger-specific half and nothing else:
//
//   trigger            the character that opens it
//   acceptsBoundary()  what must sit BEFORE the trigger for it to count
//   acceptsPrefix()    how far PAST the trigger its token may run
//   search(prefix)     candidates — an array (synchronous) or a promise of one
//   render(item)       the row's content
//   accept(item, …)    what accepting DOES, performed against the HOST
//
// THE SCAN LIVES HERE (scanToken), on the type whose two predicates decide it
// and whose TriggerToken it mints. A HOST runs it over its own text; the popover
// never sees text at all.
//
// `@` CANNOT ENUMERATE AT BOOT — the library is unbounded, so search() is a
// debounced round-trip returning a promise, where the command list is a
// boot-shipped array returned synchronously.
//
// Nothing here speaks transport: MentionProvider holds a MentionService and
// calls one verb on it, so the UI stays transport-blind.

import { ContractViolation } from '../contract/sieve-block.js'

/**
 * The token the caret currently sits in — minted by TriggerProvider.scanToken,
 * frozen because a provider reads it and never edits it.
 *
 * `start`/`end` are the HOST's coordinates and opaque to everyone else: a
 * textarea's string offsets today, a ProseMirror host's positions tomorrow. Only
 * the host that minted them interprets them.
 * @typedef {object} TriggerToken
 * @property {TriggerProvider} provider  the provider claiming this token's trigger
 * @property {number} start   index of the trigger character
 * @property {number} end     the caret (exclusive end of the token)
 * @property {string} prefix  what the user has typed since the trigger
 */

// ── The abstract provider ────────────────────────────────────────────────────

export class TriggerProvider {
  /**
   * The token in `text` that the caret at `caret` sits in, or null. Walks BACK
   * from the caret to the NEAREST trigger character and asks the provider
   * claiming it whether both sides hold: `acceptsBoundary` for what precedes the
   * trigger, `acceptsPrefix` for how far the token may run past it.
   *
   * ONE MECHANISM, NOT TWO CATEGORIES: each trigger overrides exactly one of the
   * two predicates. `/` overrides the BOUNDARY (a command is a whole-line verb,
   * so only position 0 counts) and keeps the default span; `@` keeps the default
   * boundary (start of text or after whitespace, so `me@example` is an address)
   * and overrides the SPAN, because a document title is several words.
   *
   * THE NEAREST TRIGGER CLAIMS THE SCAN. Whichever way it answers, the walk stops
   * there: a `/` in the middle of a word is a rejected token, never an invitation
   * to keep looking for an earlier `@` that would then swallow it.
   * @param {string} value @param {number} caret
   * @param {Map<string, TriggerProvider>} providers
   * @returns {TriggerToken|null}
   */
  static scanToken(value, caret, providers) {
    const text = value || ''
    const end = Math.max(0, Math.min(caret == null ? text.length : caret, text.length))
    for (let i = end - 1; i >= 0; i--) {
      const provider = providers.get(text.charAt(i))
      if (!provider) continue
      const before = i > 0 ? text.charAt(i - 1) : ''
      if (!provider.acceptsBoundary(before, i)) return null
      const prefix = text.slice(i + 1, end)
      if (!provider.acceptsPrefix(prefix)) return null
      return Object.freeze({ provider: provider, start: i, end: end, prefix: prefix })
    }
    return null
  }

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
   * Apply an accepted candidate IN `host`. Text providers call replaceToken()
   * for the substitution and then do whatever else acceptance means to them (a
   * mention also attaches).
   *
   * THE HOST IS PASSED, NOT A PAYLOAD, because accepting is not defined as a text
   * substitution: a `{kind` provider deletes the token and creates a block
   * instead. Range-replace is one facility a typed host offers, and a provider
   * that needs it calls for it.
   * @param {any} _item @param {TriggerToken} _token
   * @param {import('./trigger-host.js').TriggerHost} _host
   */
  accept(_item, _token, _host) {
    throw new ContractViolation(`${this.constructor.name} must implement accept(item, token, host)`)
  }

  // ── Shared behaviour (on the type that owns the token contract) ────────────

  /**
   * Substitutes `text` for the token under the caret and leaves the caret one
   * character past it. The trailing gap is REUSED, not duplicated: a completion
   * accepted mid-sentence ("How does @au| handle this?") must not leave a double
   * space behind it, while one accepted at the end of the line still gets the
   * separator that lets the next word be typed straight away.
   *
   * An existing separator is SWALLOWED INTO THE REPLACED RANGE rather than left
   * standing, so the one rule the host has to keep — caret after the insert —
   * lands the caret past the gap either way. The host never learns that a
   * completion has a notion of a trailing space; that is completion semantics
   * and belongs to the family that owns the token.
   *
   * THE TYPED SLICE IS ASKED FOR HERE rather than required of every host, because
   * substituting text is what this kind of provider does. A provider that
   * completes text into a host that cannot be typed into is a wiring mistake and
   * says so by name.
   * @protected
   * @param {import('./trigger-host.js').TriggerHost} host
   * @param {TriggerToken} token @param {string} text
   */
  replaceToken(host, token, text) {
    const typed = /** @type {import('./trigger-host.js').TypedTriggerHost} */ (/** @type {any} */ (host))
    if (typeof typed.textAfter !== 'function' || typeof typed.replaceRange !== 'function') {
      throw new ContractViolation(`${this.constructor.name} completes text and needs a host that can be typed into`)
    }
    const after = typed.textAfter(token.end)
    const reused = /^\s/.test(after)
    typed.replaceRange(token.start, token.end + (reused ? 1 : 0), text + (reused ? after.charAt(0) : ' '))
  }

  /**
   * Turns the token under the caret into a BLOCK — the second facility a host
   * may offer, and the sibling of replaceToken above. The token's range travels
   * with it because deleting it is the HOST's half of the job (its coordinates
   * are opaque out here), and the host performs both halves inside one boundary.
   *
   * ASKED FOR BY NAME, exactly as the typed slice is, so a provider that makes
   * blocks in a host that cannot hold one says so.
   * @protected
   * @param {import('./trigger-host.js').TriggerHost} host
   * @param {TriggerToken} token
   * @param {string} kind @param {Record<string, any>} attrs
   */
  createBlockFrom(host, token, kind, attrs) {
    const maker = /** @type {import('./trigger-host.js').BlockMakingTriggerHost} */ (/** @type {any} */ (host))
    if (typeof maker.createBlock !== 'function') {
      throw new ContractViolation(`${this.constructor.name} makes blocks and needs a host that can hold one`)
    }
    maker.createBlock(kind, attrs, token)
  }

  /**
   * Can `host` hold a block? The capability check a provider whose acceptance
   * DIFFERS BY HOST runs before it decides what accepting means. Presence is the
   * capability (trigger-host.js), so this is the one place that `typeof` lives.
   * @protected
   * @param {import('./trigger-host.js').TriggerHost} host @returns {boolean}
   */
  hostMakesBlocks(host) {
    return typeof (/** @type {any} */ (host).createBlock) === 'function'
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

  /** @param {{name: string}} cmd @param {TriggerToken} token
   *  @param {import('./trigger-host.js').TriggerHost} host */
  accept(cmd, token, host) { this.replaceToken(host, token, '/' + cmd.name) }
}

// ── `@` — document mentions ──────────────────────────────────────────────────

/**
 * @typedef {object} CandidateSource
 * @property {(q: string, limit?: number) => Promise<import('./mention-service.js').MentionCandidate[]>} search
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
 * The runaway backstop: an unaccepted `@` cannot query for ever, whatever the
 * library contains. A sticky token normally stops itself when a query comes back
 * dry, so these bounds bite only a token that keeps matching.
 */
const MAX_TOKEN_WORDS = 4
const MAX_TOKEN_CHARS = 60

export class MentionProvider extends TriggerProvider {
  /** @type {CandidateSource} */ #source
  /** @type {(c: import('./mention-service.js').MentionCandidate) => void} */ #onAccept
  /** @type {number} */ #debounceMs
  /** @type {number|undefined} */ #limit
  /** @type {ReturnType<typeof setTimeout>|null} */ #timer = null
  /** @type {((c: any[]) => void)|null} the in-flight debounce's resolver, kept so a
   *  superseded keystroke's promise settles instead of dangling for ever */ #superseded = null

  /**
   * @param {CandidateSource} source  the MentionService (the plane tenant)
   * @param {(c: import('./mention-service.js').MentionCandidate) => void} [onAccept]
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
   * `@sprite sheet an` is one token narrowing towards "Sprite Sheet Analysis".
   * What stops it is the popover's dry stop — no candidates means the token is
   * abandoned — with these bounds as the backstop.
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

  /** @param {import('./mention-service.js').MentionCandidate} c @returns {Node} */
  render(c) { return this.renderRow('@' + c.title, c.detail) }

  /**
   * ONE CANDIDATE, ONE MEANING — "make this document present here" — and the
   * HOST decides what that costs:
   *
   * - **A document** can hold a block, so the mention BECOMES one: the token is
   *   deleted and a `reference` block carrying the `uri` takes its place. No text
   *   echo, because the chip in the document is the reference.
   * - **A composer** cannot, so the LITERAL `@Title` goes into the message and
   *   the candidate goes to the panel's attachment sink, which draws the chip
   *   beside it. The text echo stays plain, so two documents called "Notes"
   *   produce two identical tokens and two different chips: the ambiguity lives
   *   in the echo and never in the data.
   *
   * THE WHOLE FACE is seeded, not just a label, so a block born complete never
   * resolves merely to render. `mime` is what says the face is filled AND what
   * the block is: a pointer's mime names Sieve's own space (`sieve/note`), which
   * is how the renderer tells pointing from holding.
   * @param {import('./mention-service.js').MentionCandidate} c
   * @param {TriggerToken} token
   * @param {import('./trigger-host.js').TriggerHost} host
   */
  accept(c, token, host) {
    if (this.hostMakesBlocks(host)) {
      this.createBlockFrom(host, token, 'reference', {
        uri: c.uri,
        title: c.title || '',
        summary: c.summary || '',
        mime: c.kind ? 'sieve/' + c.kind : '',
      })
      return
    }
    this.replaceToken(host, token, '@' + c.title)
    this.#onAccept(c)
  }

  /** Drops an in-flight debounce, settling its promise empty (the popover's
   *  staleness guard discards it; an unsettled promise would leak). */
  #cancelPending() {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null }
    if (this.#superseded) { const r = this.#superseded; this.#superseded = null; r([]) }
  }
}
