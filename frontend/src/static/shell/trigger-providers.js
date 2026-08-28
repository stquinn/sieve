// @ts-check
// The composer's TRIGGER PROVIDER family. One popover owns the shared half —
// keyboard model, scroll-into-view, dismissal — a HOST owns the surface it
// happens in, and a provider owns the trigger-specific half:
//
//   trigger            the character that opens it
//   acceptsBoundary()  what must sit BEFORE the trigger for it to count
//   acceptsPrefix()    how far PAST the trigger its token may run
//   search(prefix)     candidates — an array (synchronous) or a promise of one
//   render(item)       the row's content
//   accept(item, …)    what accepting DOES, performed against the HOST
//
// THE SCAN LIVES HERE, on the type whose two predicates decide it and whose
// TriggerToken it mints. A HOST runs it over its own text; the popover never sees
// text at all.
//
// The `{` picker's CANDIDATE type — the Macro family — lives here too, beside the
// provider that renders and accepts it. A macro is a frontend verb; what the
// catalog of them IS, and who declares each one, is macro-catalog.js.

import { ContractViolation } from '../contract/sieve-block.js'
import { LensCapability, LENS_CAPABILITIES } from '../contract/lens-capabilities.js'

// The two widths that make a picker's rows line up into columns: the icon gutter
// every row carries, and the floor a name occupies before its description
// begins. 14px icons with breathing room; a name column wide enough for the
// kinds and verbs on offer.
const ICON_SLOT_WIDTH = '22px'
const NAME_SLOT_MIN_WIDTH = '10em'

/**
 * Whether the engine can lay the popover out as ONE shared grid the rows
 * subgrid into. Detected HERE because both halves of the layout read it: the
 * popover builds its track template from it, and renderRow drops the name
 * slot's floor width under it — a shared track already hugs the widest name,
 * and keeping the floor would push every description past a gulf of dead
 * space. Without subgrid the rows are flex and the floor IS the rhythm.
 */
export const SUBGRID_ROWS = typeof CSS !== 'undefined' && !!CSS.supports
  && CSS.supports('grid-template-columns', 'subgrid')

/**
 * The token the caret currently sits in, frozen because a provider reads it and
 * never edits it. `start`/`end` are the HOST's coordinates and opaque to everyone
 * else — only the host that minted them interprets them.
 * @typedef {object} TriggerToken
 * @property {TriggerProvider} provider  the provider claiming this token's trigger
 * @property {number} start   index of the trigger character
 * @property {number} end     the caret (exclusive end of the token)
 * @property {string} prefix  what the user has typed since the trigger
 */

export class TriggerProvider {
  /**
   * The token in `text` that the caret at `caret` sits in, or null. Walks BACK to
   * the NEAREST trigger character and asks the provider claiming it whether both
   * sides hold.
   *
   * ONE MECHANISM, NOT TWO CATEGORIES: each trigger overrides exactly one of the
   * two predicates. `/` overrides the BOUNDARY, since a command is a whole-line
   * verb; `@` overrides the SPAN, since a document title is several words.
   *
   * THE NEAREST TRIGGER CLAIMS THE SCAN. However it answers, the walk stops
   * there: a `/` mid-word is a rejected token, never an invitation to keep looking
   * for an earlier `@` that would then swallow it.
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
   * Does a trigger at `start`, preceded by `before`, open this picker? The DEFAULT
   * is the mid-text rule: at the start of the text, or after whitespace.
   * @param {string} before  the character before the trigger ('' at index 0)
   * @param {number} _start  the trigger's index
   * @returns {boolean}
   */
  acceptsBoundary(before, _start) { return before === '' || /\s/.test(before) }

  /**
   * Is `prefix` still part of this provider's token? TOKEN STICKINESS is a
   * provider trait rather than a rule in the scanner: the DEFAULT ends a token at
   * the first whitespace, and a provider whose candidates are named in several
   * words overrides it.
   * @param {string} prefix  the text between the trigger and the caret
   * @returns {boolean}
   */
  acceptsPrefix(prefix) { return !/\s/.test(prefix) }

  /**
   * Does this provider's picker carry an ICON COLUMN? A trait rather than an
   * inference from the candidates in hand: a column that appeared and vanished
   * as queries happened to return icons would move the whole list sideways under
   * a user mid-word. The DEFAULT is no column — a command and a document title
   * are named, not pictured.
   * @returns {boolean}
   */
  get providesIcons() { return false }

  /**
   * The candidates for `prefix` — an ARRAY for a provider that enumerates locally,
   * a PROMISE for one that must ask Go. The popover renders a synchronous answer
   * synchronously and guards an async one against being overtaken.
   * @param {string} _prefix
   * @returns {any[]|Promise<any[]>}
   */
  search(_prefix) {
    throw new ContractViolation(`${this.constructor.name} must implement search(prefix)`)
  }

  /** The row content for one candidate. Use renderRow() for the house look.
   *  @param {any} _item @returns {Node} */
  render(_item) {
    throw new ContractViolation(`${this.constructor.name} must implement render(item)`)
  }

  /**
   * Apply an accepted candidate IN `host`. THE HOST IS PASSED, NOT A PAYLOAD,
   * because accepting is not defined as a text substitution: a block-making
   * provider deletes the token and creates a block instead. Range-replace is one
   * facility a typed host offers, and a provider that needs it calls for it.
   * @param {any} _item @param {TriggerToken} _token
   * @param {import('./trigger-host.js').TriggerHost} _host
   */
  accept(_item, _token, _host) {
    throw new ContractViolation(`${this.constructor.name} must implement accept(item, token, host)`)
  }

  /**
   * Substitutes `text` for the token under the caret, leaving the caret one
   * character past it. The trailing gap is REUSED, not duplicated: a completion
   * accepted mid-sentence must not leave a double space, while one at the end of
   * the line still gets its separator. The existing separator is SWALLOWED INTO
   * THE REPLACED RANGE, so the host's one rule — caret after the insert — lands
   * past the gap either way, and the host never learns a completion has a notion
   * of a trailing space.
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
   * Turns the token under the caret into a BLOCK. The token's range travels with
   * it because deleting it is the HOST's half of the job — its coordinates are
   * opaque out here — and the host performs both halves inside one boundary.
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
   * Can `host` hold a block? Presence is the capability, so this is the one place
   * that `typeof` lives.
   * @protected
   * @param {import('./trigger-host.js').TriggerHost} host @returns {boolean}
   */
  hostMakesBlocks(host) {
    return typeof (/** @type {any} */ (host).createBlock) === 'function'
  }

  /**
   * The house row, shared so every trigger is visually ONE picker: a
   * left-aligned flex row of slots — name, description, and an icon column
   * ahead of them for a provider whose `providesIcons` trait declares one.
   *
   * THE COLUMNS ARE THE POINT. Where there is an icon column every row carries
   * it, empty or not, and the name slot has a floor width — so every name in the
   * list starts at one x and every description at another. Both widths are
   * declared HERE and nowhere else: the popover contributes the flex row, not
   * the rhythm inside it. A name longer than the floor pushes only its own
   * description.
   * @protected
   * @param {string} label @param {string} [detail] @param {string} [icon] SVG markup
   * @returns {DocumentFragment}
   */
  renderRow(label, detail, icon) {
    const frag = document.createDocumentFragment()

    if (this.providesIcons) {
      const iconEl = document.createElement('span')
      iconEl.className = 'command-hint__icon'
      iconEl.style.cssText = `display: inline-flex; align-items: center; flex: none; width: ${ICON_SLOT_WIDTH}; opacity: 0.8;`
      if (icon) iconEl.innerHTML = icon
      frag.appendChild(iconEl)
    }

    const nameEl = document.createElement('span')
    nameEl.className = 'command-hint__name'
    const floor = SUBGRID_ROWS ? '' : `min-width: ${NAME_SLOT_MIN_WIDTH}; `
    nameEl.style.cssText = `flex: none; ${floor}font-family: var(--theme-monoFont, monospace); font-weight: 600; color: var(--theme-accentPrimary, #7aa2f7);`
    nameEl.textContent = label

    const descEl = document.createElement('span')
    descEl.className = 'command-hint__desc'
    descEl.style.cssText = 'flex: 1; min-width: 0; text-align: left; font-size: 12px; opacity: 0.75; margin-left: 12px;'
    descEl.textContent = detail || ''

    frag.appendChild(nameEl)
    frag.appendChild(descEl)
    return frag
  }
}

/**
 * @typedef {object} CommandLister
 * @property {() => Array<{name: string, description?: string}>} list
 */

export class SlashCommandProvider extends TriggerProvider {
  /** @type {CommandLister} */ #commands
  /** @type {() => boolean} */ #inScope

  /**
   * @param {CommandLister} commandService the boot-shipped command enumeration
   * @param {() => boolean} [inScope]
   *   whether the caret is somewhere this MOUNT accepts a command at all —
   *   asked afresh on every scan. The default is everywhere, which is the answer
   *   for a host whose entire surface is one message; a host with more than one
   *   place to type narrows it here rather than by subclassing the provider.
   */
  constructor(commandService, inScope) {
    super()
    if (!commandService || typeof commandService.list !== 'function') {
      throw new ContractViolation('SlashCommandProvider requires a command lister')
    }
    this.#commands = commandService
    this.#inScope = inScope || (() => true)
  }

  get trigger() { return '/' }

  /** A command is a whole-line verb, and only where its mount takes one: a slash
   *  at position 0, in a place the mount says is in scope.
   *  @param {string} _before @param {number} start @returns {boolean} */
  acceptsBoundary(_before, start) { return start === 0 && this.#inScope() }

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

/**
 * @typedef {object} MacroSpec
 * @property {string} label   the name a person picks it by
 * @property {string} requires
 *   the capability a mount must publish for this entry to be offered — one of
 *   the `LensCapability` words, never a bare string.
 * @property {string} [name]
 *   the SECOND word it answers to — a kind's wire name, a verb's short handle.
 *   Defaults to the label.
 * @property {string} [description]
 * @property {string} [icon]  the entry's icon as SVG markup
 */

/**
 * ONE ENTRY IN THE `{` PICKER: a frontend verb, drawn like a command and picked
 * like one, whose acceptance is a CALL rather than a text completion.
 *
 * AN ENTRY NAMES A CAPABILITY, NEVER A MOUNT. What it needs of the lens it lands
 * in is `requires`; which mounts satisfy that is the lens's published spec to
 * answer, so one catalog serves every mount by filtering.
 *
 * ACCEPTING A MACRO ALWAYS REMOVES THE TYPED TOKEN. Whether that happens as the
 * first half of one host boundary (a create) or as an edit of its own before the
 * verb runs (a dialog, a native command) is the subclass's business; what a user
 * must never be left with is the `{table` a cancelled dialog abandoned.
 */
export class Macro {
  /** @type {string} */ #label
  /** @type {string} */ #name
  /** @type {string} */ #description
  /** @type {string} */ #icon
  /** @type {string} */ #requires

  /** @param {MacroSpec} spec */
  constructor(spec) {
    if (!spec || !spec.label) throw new ContractViolation('a Macro needs a label')
    if (LENS_CAPABILITIES.indexOf(spec.requires) < 0) {
      throw new ContractViolation(`the macro "${spec.label}" must declare the capability it requires`)
    }
    this.#label = spec.label
    this.#name = spec.name || spec.label
    this.#description = spec.description || ''
    this.#icon = spec.icon || ''
    this.#requires = spec.requires
  }

  get label() { return this.#label }

  get name() { return this.#name }

  get description() { return this.#description }

  get icon() { return this.#icon }

  /** @returns {string} the capability a mount must publish to offer this entry */
  get requires() { return this.#requires }

  /**
   * Perform this entry in `host`, consuming the token the user typed to reach it.
   * @param {import('./trigger-host.js').TriggerHost} _host
   * @param {TriggerToken} _token
   * @param {string} [_arg]
   *   the ARGUMENT TAIL — whatever followed `BlockInsertProvider.ARG_SEPARATOR`
   *   in the typed token, e.g. `go` from `{fence:go`. Undefined when the token
   *   carried none. A subclass that takes no argument simply never reads it.
   */
  run(_host, _token, _arg) {
    throw new ContractViolation(`${this.constructor.name} must implement run(host, token)`)
  }

  /**
   * Deletes the token, leaving the caret where it stood. The FIRST thing an entry
   * that does not create does, because what follows may never happen.
   * @protected
   * @param {import('./trigger-host.js').TriggerHost} host @param {TriggerToken} token
   */
  clearToken(host, token) {
    const typed = /** @type {import('./trigger-host.js').TypedTriggerHost} */ (/** @type {any} */ (host))
    if (typeof typed.replaceRange !== 'function') {
      throw new ContractViolation(`${this.constructor.name} clears its token and needs a host that can be typed into`)
    }
    typed.replaceRange(token.start, token.end, '')
  }
}

/**
 * One kind the picker can make, as the block vocabulary describes it.
 * @typedef {object} InsertableKind
 * @property {string} kind         the wire name the block is created under
 * @property {string} label        the name a person picks it by
 * @property {string} [description]
 * @property {string} [icon]       the kind's icon as SVG markup
 * @property {Record<string, any>} [defaults]  what a fresh block of this kind starts as
 */

/**
 * THE COMMON CASE: the token becomes an empty block of one kind. Delete and
 * create are ONE host boundary — the host removes the token, flushes it to the
 * server, and asks for the block where it stood — so this writes no text and
 * computes no position.
 *
 * Making a block is what this class IS, so it requires `blocks` of its mount
 * rather than taking a declaration from the kind it fronts.
 */
export class BlockMacro extends Macro {
  /** @type {string} */ #kind
  /** @type {Record<string, any>} */ #defaults

  /** @param {InsertableKind} kind */
  constructor(kind) {
    const spec = kind || /** @type {any} */ ({})
    super({
      label: spec.label || spec.kind,
      name: spec.kind,
      description: spec.description,
      icon: spec.icon,
      requires: LensCapability.BLOCKS,
    })
    this.#kind = spec.kind
    this.#defaults = Object.assign({}, spec.defaults)
  }

  /** @returns {string} the wire name the block is created under */
  get kind() { return this.#kind }

  /**
   * @param {import('./trigger-host.js').TriggerHost} host @param {TriggerToken} token
   */
  run(host, token) {
    const maker = /** @type {import('./trigger-host.js').BlockMakingTriggerHost} */ (/** @type {any} */ (host))
    if (typeof maker.createBlock !== 'function') {
      throw new ContractViolation(`${this.constructor.name} makes blocks and needs a host that can hold one`)
    }
    maker.createBlock(this.#kind, Object.assign({}, this.#defaults), token)
  }
}

/**
 * @typedef {MacroSpec & {action: (arg?: string) => void}} ActionMacroSpec
 */

/**
 * A macro that FRONTS a capability the app already has — a dialog, a native
 * editing command. The action returns nothing: whatever it drives owns the
 * outcome, including whether a block is ever created. It receives the token's
 * argument tail (see `Macro.run`), which an action indifferent to it simply
 * ignores.
 */
export class ActionMacro extends Macro {
  /** @type {(arg?: string) => void} */ #action

  /** @param {ActionMacroSpec} spec */
  constructor(spec) {
    super(spec)
    if (!spec || typeof spec.action !== 'function') {
      throw new ContractViolation('an ActionMacro needs an action to run')
    }
    this.#action = spec.action
  }

  /**
   * @param {import('./trigger-host.js').TriggerHost} host @param {TriggerToken} token
   * @param {string} [arg]
   */
  run(host, token, arg) {
    this.clearToken(host, token)
    this.#action(arg)
  }
}

/**
 * @typedef {object} MacroLister
 * @property {() => Macro[]} list
 */

export class BlockInsertProvider extends TriggerProvider {
  /** @type {MacroLister} */ #macros

  /**
   * The token's HEAD/ARGUMENT divider — `{fence:go` matches the `fence` entry
   * and carries `go` as its `run` argument. Lives on the class the split logic
   * belongs to; no other trigger reads it, so it has no reason to be a scanner
   * concept. Chosen over a space because the scanner's default `acceptsPrefix`
   * already ends a token at the first whitespace (a macro is named in one
   * word) — `:` passes that predicate unchanged, so an argument needs no
   * scanner override.
   * @type {string}
   */
  static ARG_SEPARATOR = ':'

  /**
   * @param {MacroLister} macroLister  the catalog composed for this mount.
   *   INJECTED, because what a `{` can do is the HOST's answer and not this
   *   type's: what arrives here is a list, not a registry.
   */
  constructor(macroLister) {
    super()
    if (!macroLister || typeof macroLister.list !== 'function') {
      throw new ContractViolation('BlockInsertProvider requires a macro lister')
    }
    this.#macros = macroLister
  }

  get trigger() { return '{' }

  /** An entry here is a THING the document will hold or a verb it will run, and
   *  both are recognised by their icon long before their name is read.
   *  @returns {boolean} */
  get providesIcons() { return true }

  /**
   * Splits a typed prefix at `ARG_SEPARATOR` into the entry-matching HEAD and
   * the ARGUMENT past it. `{table` and `{fence` (no separator yet) carry no
   * argument; `{fence:` carries an empty one — the author typed the separator
   * but nothing after it.
   * @param {string} prefix @returns {{head: string, arg: string|undefined}}
   */
  static #split(prefix) {
    const i = prefix.indexOf(BlockInsertProvider.ARG_SEPARATOR)
    return i < 0 ? { head: prefix, arg: undefined } : { head: prefix.slice(0, i), arg: prefix.slice(i + 1) }
  }

  /**
   * The catalog is small and local, so this is a SYNCHRONOUS filter. An entry
   * answers to its label and to its second name alike — one is what the user
   * reads, the other is what they may already know it as — and a BLANK prefix
   * lists everything, which is the browse gesture. Only the HEAD of the prefix
   * is matched: an entry stays listed while its argument is typed.
   * @param {string} prefix @returns {Macro[]}
   */
  search(prefix) {
    const p = BlockInsertProvider.#split(prefix || '').head.toLowerCase()
    return (this.#macros.list() || []).filter((m) =>
      m.label.toLowerCase().startsWith(p) || m.name.toLowerCase().startsWith(p))
  }

  /** @param {Macro} macro @returns {Node} */
  render(macro) { return this.renderRow(macro.label, macro.description, macro.icon) }

  /**
   * THE ENTRY OWNS WHAT ACCEPTING MEANS, so there is no branch here on what kind
   * of entry it is. The host is passed through because the entry acts against it.
   * The token's argument tail — everything past `ARG_SEPARATOR` in what was
   * typed — travels to `run` unconditionally; an entry that takes none ignores it.
   * @param {Macro} macro @param {TriggerToken} token
   * @param {import('./trigger-host.js').TriggerHost} host
   */
  accept(macro, token, host) {
    macro.run(host, token, BlockInsertProvider.#split(token.prefix).arg)
  }
}

/**
 * @typedef {object} CandidateSource
 * @property {(q: string, limit?: number) => Promise<import('./mention-service.js').MentionCandidate[]>} search
 */

/**
 * @typedef {object} MentionProviderOptions
 * @property {number} [debounceMs]
 *   the typing-cadence window. It lives HERE and not in MentionService: the
 *   service round-trips what it is asked, the provider watches a keyboard.
 * @property {number} [limit]
 */

/** Long enough to skip the middle of a word, short enough to feel live. */
const DEFAULT_DEBOUNCE_MS = 120

/**
 * The runaway backstop: an unaccepted `@` cannot query for ever. A sticky token
 * normally stops itself when a query comes back dry, so these bounds bite only a
 * token that keeps matching.
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
   *   the composer's attachment sink; accepting a candidate both echoes `@Title`
   *   into the text AND hands the candidate here.
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
   * What stops it is the popover's dry stop, with these bounds as the backstop.
   *
   * A NEWLINE still terminates it: Shift+Enter starts a new line of the message,
   * and a token spanning it would keep a picker open across the break.
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
   * nothing, so the frame would buy an empty list at the cost of a socket write
   * on every `@` keystroke — and since the token is sticky, "@ " is blank too.
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
   * ONE CANDIDATE, ONE MEANING — "make this document present here" — and the HOST
   * decides what that costs:
   *
   * - **A document** can hold a block, so the mention BECOMES one: the token is
   *   deleted and a `reference` block carrying the `uri` takes its place. No text
   *   echo, because the chip in the document IS the reference.
   * - **A composer** cannot, so the LITERAL `@Title` goes into the message and the
   *   candidate goes to the panel's attachment sink. Two documents called "Notes"
   *   then produce two identical tokens and two different chips: the ambiguity
   *   lives in the echo and never in the data.
   *
   * THE WHOLE FACE is seeded, not just a label, so a block born complete never
   * resolves merely to render. The face rides the `cache` attr — root attrs are
   * the reference's own, the cache is what was taken from the target — and
   * `cache.mime` is what says the face is filled AND what the block is: a
   * pointer's mime names Sieve's own space, which is how the renderer tells
   * pointing from holding. An empty face stays an ABSENT cache.
   * @param {import('./mention-service.js').MentionCandidate} c
   * @param {TriggerToken} token
   * @param {import('./trigger-host.js').TriggerHost} host
   */
  accept(c, token, host) {
    if (this.hostMakesBlocks(host)) {
      /** @type {Record<string, string>} */
      const face = {}
      if (c.title) face.title = c.title
      if (c.summary) face.summary = c.summary
      if (c.kind) face.mime = 'sieve/' + c.kind
      /** @type {Record<string, any>} */
      const attrs = { uri: c.uri }
      if (Object.keys(face).length) attrs.cache = face
      this.createBlockFrom(host, token, 'reference', attrs)
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
