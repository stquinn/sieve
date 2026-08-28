// @ts-check
// trigger-popover.js — TriggerPopover: the trigger-driven hint picker. Renders
// a fixed list over whatever HOST it is given, placed by a PLACEMENT strategy,
// and handles keyboard navigation (ArrowUp, ArrowDown, Tab, Enter, Escape).
// THE POPOVER NEVER KNOWS WHAT TEXT IS: it asks the host for a token and hands
// the host a candidate.
//
// THE TOKEN CAN BE ABANDONED. A sticky token needs a way to stop, or an `@`
// typed in an ordinary sentence would query on every keystroke and ambush the
// typist with a picker that swallows Enter. Going dry, Escape and acceptance all
// abandon the token under the caret; typing FORWARD from an abandoned prefix
// stays closed, backspacing to a shorter one re-arms it.

import { ContractViolation } from '../contract/sieve-block.js'
import { TriggerProvider, SUBGRID_ROWS } from './trigger-providers.js'
import { TriggerHost, TriggerPlacement, PanelPlacement } from './trigger-host.js'

/**
 * TRUE SHARED COLUMNS when the engine has them: the popover becomes the grid
 * and each row subgrids into it, so the name column is exactly as wide as the
 * widest visible name and every description starts at one x — a floor width
 * cannot do that once names outgrow it (document titles in `@` always do).
 * Without subgrid the rows stay flex and the floor is the fallback rhythm.
 */
const SUBGRID = SUBGRID_ROWS

/** The name track: content-sized, capped so one very long title cannot shove
 *  every description off the popover's edge. */
const NAME_TRACK = 'fit-content(26em)'

/**
 * Tab, however the platform spells it. WebKitGTK reports Shift+Tab as the X11
 * keysym `ISO_Left_Tab` in `event.key` where Chrome says 'Tab', so matching on
 * the key name alone lets Shift+Tab fall THROUGH an open picker and reach the
 * editor's interaction-policy Tab backstop.
 * @param {KeyboardEvent} e @returns {boolean}
 */
function isTabKey(e) {
  return e.key === 'Tab' || e.key === 'ISO_Left_Tab' || e.keyCode === 9
}

export class TriggerPopover {
  /** @type {TriggerHost} */ #host
  /** @type {(TriggerHost & import('./trigger-host.js').TypedTriggerHost)|null} the same
   *  host when it carries the TYPED SLICE. A host without it has no token stream
   *  to arm from, and waits to be summoned instead. */ #typed = null
  /** @type {TriggerPlacement} */ #placement
  /** @type {Map<string, TriggerProvider>} trigger character → the ONE provider claiming it */ #providers = new Map()
  /** @type {HTMLElement|null} */ #popoverEl = null

  /** @type {HTMLElement|null} the fade over the list's bottom edge, visible only
   *  while entries sit below the fold — a scrollable list must say so. */ #scrollHint = null

  /** @type {boolean} whether the popover is currently laid out as the rows'
   *  shared grid — show() must then reveal it as `grid`, not `block`. */ #gridMode = false
  /** @type {any[]} */ #items = []
  /** @type {number} */ #selectedIndex = 0
  /** @type {import('./trigger-providers.js').TriggerToken|null} the token the listed candidates answer */ #token = null
  /** @type {number} monotonic query counter — an async answer that is not the
   *  newest is DROPPED */ #seq = 0
  /** @type {{start: number, prefix: string}|null} the token the user walked away
   *  from. Keyed by where it started and what had been typed at the time, so a
   *  LONGER continuation stays abandoned and a shorter one re-arms. */ #abandoned = null
  /** @type {boolean} true while an accepted completion is being written back —
   *  the `input` that write fires is OUR edit, not the user's. */ #completing = false
  /** @type {Array<() => void>} */ #unsubscribes = []

  /**
   * @param {TriggerHost} host
   * @param {TriggerProvider[]} providers  one per trigger character
   * @param {TriggerPlacement} [placement]  defaults to the composer's panel
   *   placement; the editor host brings a caret-anchored one with it.
   */
  constructor(host, providers, placement) {
    if (!(host instanceof TriggerHost)) {
      throw new ContractViolation('TriggerPopover: host must extend TriggerHost')
    }
    if (placement && !(placement instanceof TriggerPlacement)) {
      throw new ContractViolation('TriggerPopover: placement must extend TriggerPlacement')
    }
    this.#host = host
    this.#placement = placement || new PanelPlacement()
    const typed = /** @type {any} */ (host)
    this.#typed = typeof typed.tokenAtCaret === 'function' && typeof typed.onInput === 'function'
      ? typed
      : null
    for (const provider of providers || []) {
      if (!(provider instanceof TriggerProvider)) {
        throw new ContractViolation('TriggerPopover: providers must extend TriggerProvider')
      }
      const trigger = provider.trigger
      if (this.#providers.has(trigger)) {
        throw new ContractViolation('TriggerPopover: trigger already claimed: ' + trigger)
      }
      this.#providers.set(trigger, provider)
    }
    this.#createPopoverDom()
    this.#wireEvents()
  }

  #createPopoverDom() {
    const el = document.createElement('div')
    el.className = 'command-hint-popover'
    el.style.cssText = [
      'display: none',
      'position: fixed',
      'z-index: 1000',
      'max-height: 320px',
      'overflow-y: auto',
      'background: var(--theme-bgAlt, #1f2335)',
      'border: 1px solid var(--theme-border2, #3b4261)',
      'border-bottom: 1px solid var(--theme-border, #1a1b26)',
      'border-top-left-radius: 8px',
      'border-top-right-radius: 8px',
      'border-bottom-left-radius: 0',
      'border-bottom-right-radius: 0',
      'box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.45)',
      'box-sizing: border-box'
    ].join('; ') + ';'

    document.body.appendChild(el)
    el.addEventListener('scroll', () => this.#syncScrollHint())
    this.#popoverEl = el
  }

  /**
   * The fade earns its keep only while something is actually below the fold:
   * at the bottom (or in an unscrollable list) it vanishes, so the last row is
   * never veiled once it is reachable.
   */
  #syncScrollHint() {
    const el = this.#popoverEl
    if (!el || !this.#scrollHint) return
    const below = el.scrollHeight - el.scrollTop - el.clientHeight > 4
    this.#scrollHint.style.opacity = below ? '1' : '0'
  }

  /**
   * Subscribes to the host. The INPUT stream belongs to the typed slice: a host
   * that cannot be typed into is summoned instead. Precedence — capture phase in
   * a textarea, beating the interaction-policy keymaps in an editor — is the
   * HOST's problem; this only asks to be told.
   */
  #wireEvents() {
    if (this.#typed) this.#unsubscribes.push(this.#typed.onInput(() => this.#handleInput()))
    this.#unsubscribes.push(this.#host.onKeyDown((e) => this.#handleKeyDown(e)))
    this.#unsubscribes.push(this.#host.onDismiss(() => this.#handleDismiss()))

    // AN OPEN LIST HAS TO SURVIVE THE PAGE MOVING UNDER IT: a caret-anchored list
    // detaches the moment the document scrolls without a keystroke. CAPTURE on
    // window, because `scroll` does not bubble — that is the one form that hears
    // an INNER scroller (the editor's own #htmx-editor) as well as the page.
    const reposition = () => {
      if (this.#popoverEl && this.#popoverEl.style.display !== 'none') {
        this.#placement.place(this.#popoverEl, this.#host)
      }
    }
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    this.#unsubscribes.push(() => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    })
  }

  #handleInput() {
    if (this.#completing) return   // our own write-back echo; see #acceptCandidate
    const token = this.#tokenAtCaret()
    if (!token || this.#isAbandoned(token)) {
      this.#token = null
      this.hide()
      return
    }
    this.#token = token
    const seq = ++this.#seq
    const answer = token.provider.search(token.prefix)
    if (answer && typeof (/** @type {any} */ (answer).then) === 'function') {
      /** @type {Promise<any[]>} */ (answer).then((items) => {
        if (seq === this.#seq) this.#present(items)
      })
      return
    }
    this.#present(/** @type {any[]} */ (answer) || [])
  }

  /**
   * Lists `items`, or — when the query came back with nothing to offer — DRIES
   * UP: the picker closes and the token is abandoned, so typing on writes plain
   * prose instead of asking again.
   * @param {any[]} items
   */
  #present(items) {
    this.#items = items || []
    if (this.#items.length === 0) {
      this.#abandon(this.#token)
      return
    }
    this.#selectedIndex = 0
    this.#render()
    this.show()
  }

  /** @param {KeyboardEvent} e */
  #handleKeyDown(e) {
    if (!this.#popoverEl || this.#popoverEl.style.display === 'none') return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      this.#selectedIndex = (this.#selectedIndex + 1) % this.#items.length
      this.#render()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      this.#selectedIndex = (this.#selectedIndex - 1 + this.#items.length) % this.#items.length
      this.#render()
    } else if (isTabKey(e) || (e.key === 'Enter' && !e.shiftKey)) {
      if (this.#items.length > 0 && this.#selectedIndex >= 0 && this.#selectedIndex < this.#items.length) {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        this.#acceptCandidate(this.#items[this.#selectedIndex])
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      // Escape ABANDONS, it does not merely hide: a picker that reappears on the
      // next keystroke is the same ambush by a slower route.
      this.#abandon(this.#token)
    }
  }

  #handleDismiss() {
    // Hide only. Leaving and returning to the composer is not a decision about
    // the token — the caret comes back to it and the picker with it.
    setTimeout(() => this.hide(), 150)
  }

  /**
   * Hands an accepted candidate to the HOST together with the token it answers,
   * then abandons whatever token the write-back left under the caret. A completed
   * `@Sprite Sheet Analysis ` is still a legal sticky token matching the
   * candidate just accepted, so without that the picker re-opens on its own result.
   * @param {any} candidate
   */
  #acceptCandidate(candidate) {
    const token = this.#token
    if (!token) return
    this.applyOwnEdit(() => this.#host.accept(candidate, token))
    this.#abandon(this.#tokenAtCaret())
  }

  /**
   * Runs `edit` as OUR write rather than the user's typing: the `input` it fires
   * is ignored here, so a programmatic change neither reopens the picker on what
   * it just wrote nor records an abandonment for a token that no longer exists.
   * Re-entrant, so a nested edit cannot un-suppress the outer one.
   *
   * DEAF IS NOT CLOSED, so it also CLOSES the picker: suppressing the echo alone
   * leaves an open list answering a token the edit just deleted, and Enter then
   * writes a completion into a span that no longer exists.
   * @param {() => void} edit
   */
  applyOwnEdit(edit) {
    const outer = this.#completing
    this.#completing = true
    try {
      edit()
    } finally {
      this.#completing = outer
    }
    this.#abandon(null)   // closes, drops the stale token, invalidates answers in flight
  }

  /** The token under the caret right now, ignoring abandonment. Null for a host
   *  with no typed slice — there is no caret for one to be under.
   *  @returns {import('./trigger-providers.js').TriggerToken|null} */
  #tokenAtCaret() {
    return this.#typed ? this.#typed.tokenAtCaret(this.#providers) : null
  }

  /**
   * Closes the picker and remembers `token` as walked away from. A blank prefix
   * is NOT recorded: nothing has been asked yet, and a record of `''` would
   * abandon every token that trigger ever opens.
   * @param {import('./trigger-providers.js').TriggerToken|null} token
   */
  #abandon(token) {
    this.#seq++            // any answer still in flight for this token is now moot
    this.#token = null
    if (token && token.prefix) this.#abandoned = Object.freeze({ start: token.start, prefix: token.prefix })
    this.hide()
  }

  /**
   * Is `token` the abandoned one, or a continuation of it? Typing FORWARD keeps
   * it abandoned; backspacing to a shorter prefix re-arms it, so a typo is
   * always recoverable.
   * @param {import('./trigger-providers.js').TriggerToken} token @returns {boolean}
   */
  #isAbandoned(token) {
    const dry = this.#abandoned
    return !!dry && token.start === dry.start && token.prefix.startsWith(dry.prefix)
  }

  /**
   * Forgets the abandonment record and closes the picker — the composer has been
   * CLEARED, so the record's (index, prefix) describes text that no longer exists
   * and a document created mid-session would stay unfindable behind it.
   */
  reset() {
    this.#abandoned = null
    this.#abandon(null)     // closes, invalidates any answer in flight, records nothing
  }

  #render() {
    if (!this.#popoverEl) return
    const token = this.#token
    if (!token) return
    this.#popoverEl.innerHTML = ''

    // The container carries the columns; each row subgrids into them, so the
    // name column is as wide as the widest visible name and every description
    // starts at one x. The icon track exists only for a provider that declares
    // one. Without subgrid, rows fall back to flex and the slots' own widths
    // (icon gutter, name floor) are the rhythm.
    // Every track is CONTENT-SIZED (never a fixed length): a subgrid row's own
    // padding and border are charged inside its edge tracks, and only a track
    // sized from its items inflates to absorb that — a fixed one lets the edge
    // cell overflow into its neighbour.
    this.#gridMode = SUBGRID
    if (this.#gridMode) {
      this.#popoverEl.style.gridTemplateColumns =
        (token.provider.providesIcons ? 'max-content ' : '') + NAME_TRACK + ' 1fr'
      if (this.#popoverEl.style.display !== 'none') this.#popoverEl.style.display = 'grid'
    }

    this.#items.forEach((item, idx) => {
      const row = document.createElement('div')
      const isActive = idx === this.#selectedIndex
      row.className = 'command-hint-item' + (isActive ? ' is-active' : '')
      row.style.cssText = [
        'padding: 8px 14px',
        'cursor: pointer',
        this.#gridMode
          ? 'display: grid; grid-template-columns: subgrid; grid-column: 1 / -1'
          : 'display: flex',
        'align-items: center',
        'font-size: 13px',
        'font-family: var(--theme-uiFont, system-ui, sans-serif)',
        'transition: background 0.1s ease',
        isActive
          ? 'background: color-mix(in srgb, var(--theme-accentPrimary, #7aa2f7) 16%, var(--theme-bgAlt, #1f2335)); border-left: 3px solid var(--theme-accentPrimary, #7aa2f7); color: var(--theme-text, #c0caf5);'
          : 'background: transparent; border-left: 3px solid transparent; color: var(--theme-textDim, #9aa5ce);'
      ].join('; ')

      row.appendChild(token.provider.render(item))

      row.addEventListener('mousedown', (e) => {
        e.preventDefault()
        this.#acceptCandidate(item)
      })

      this.#popoverEl?.appendChild(row)
    })

    // The bottom-edge fade, LAST so it sits over the list's bottom edge. Sticky
    // inside the scroller with a negative margin, so it costs no list height;
    // pointer-events off, so the row beneath it still takes the click.
    const hint = document.createElement('div')
    hint.className = 'command-hint-scroll-hint'
    hint.style.cssText = [
      'position: sticky',
      'bottom: 0',
      'height: 28px',
      'margin-top: -28px',
      'grid-column: 1 / -1',
      'pointer-events: none',
      'opacity: 0',
      'transition: opacity 0.1s ease',
      'background: linear-gradient(to bottom, transparent, var(--theme-bgAlt, #1f2335))',
    ].join('; ')
    this.#popoverEl.appendChild(hint)
    this.#scrollHint = hint

    // Keyboard navigation has to carry the viewport with it: #render() clears
    // innerHTML, which resets scrollTop to 0. 'nearest' scrolls the minimum
    // needed, so the list stays still while the selection is already visible.
    const activeEl = this.#popoverEl.querySelector('.command-hint-item.is-active')
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' })
    this.#syncScrollHint()
  }

  show() {
    if (this.#popoverEl) {
      // Visible BEFORE placing: a display:none element has no box, so a placement
      // that sizes itself to its content (CaretPlacement) measures zero. Both
      // statements are synchronous, so the pre-placement position is never seen.
      this.#popoverEl.style.display = this.#gridMode ? 'grid' : 'block'
      this.#placement.place(this.#popoverEl, this.#host)
      // Only now does the element have a box to measure the fold against.
      this.#syncScrollHint()
    }
  }

  hide() {
    if (this.#popoverEl) this.#popoverEl.style.display = 'none'
  }

  /**
   * Drops every subscription and the popover element, and INVALIDATES ANSWERS IN
   * FLIGHT. Unsubscribing does not reach a promise already handed a `.then`, so
   * without bumping the sequence a late answer would render a list and ask a
   * torn-down host where to place it.
   */
  destroy() {
    for (const unsubscribe of this.#unsubscribes) unsubscribe()
    this.#unsubscribes = []
    this.#seq++
    this.#token = null
    if (this.#popoverEl && this.#popoverEl.parentElement) {
      this.#popoverEl.parentElement.removeChild(this.#popoverEl)
    }
    this.#popoverEl = null
  }
}
