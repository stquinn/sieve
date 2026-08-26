// @ts-check
// PM-free header machinery for block renderers: plain DOM, no ProseMirror, no
// editor/view, no window.* app bus. A kind's buildHeader() creates a HeaderBar
// and returns its bar; the kind's update() drives HeaderBar.update() so active
// states track live attrs.

/** @param {string} [cls] @param {string} [tag] @returns {HTMLElement} */
function hdrEl(cls, tag) {
  const e = document.createElement(tag || 'div')
  if (cls) e.className = cls
  return e
}

/**
 * A badge chip. `text` is set via textContent — never innerHTML.
 * @param {string|number|null} text @param {string} [extraCls] @returns {HTMLElement}
 */
export function badgeEl(text, extraCls) {
  const b = hdrEl('sieve-block__badge' + (extraCls ? ' ' + extraCls : ''), 'span')
  b.textContent = (text == null) ? '' : String(text)
  return b
}

/** @param {HTMLElement} parent @param {(Node|null)[]} nodes */
function appendAll(parent, nodes) {
  ;(nodes || []).forEach((n) => { if (n) parent.appendChild(n) })
}

// A badge value is a literal string/number or a function(attrs) — NOT an attr
// name (ambiguous with a literal like 'diagram'). For an attr: `a => a.language`.
/** @param {any} badge @param {object} attrs */
function resolveBadge(badge, attrs) {
  return (typeof badge === 'function') ? badge(attrs) : badge
}

/**
 * Shared segmented toggle; onChange(value) is the durable action.
 * @param {{value: string, label: string, icon?: string}[]} options
 * @param {string} activeValue
 * @param {(value: string) => void} onChange
 * @returns {HTMLElement}
 */
export function segmentedToggle(options, activeValue, onChange) {
  const wrap = hdrEl('sieve-block__toggle')
  ;(options || []).forEach((opt) => {
    const btn = document.createElement('button')
    btn.className = 'sieve-block__toggle-btn' + (opt.value === activeValue ? ' sieve-block__toggle-btn--active' : '')
    btn.innerHTML = (opt.icon ? opt.icon + ' ' : '') + opt.label
    btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onChange(opt.value) }
    wrap.appendChild(btn)
  })
  return wrap
}

/**
 * The universal EXPAND affordance button. The icon HTML and the click action
 * are injected by the RENDERER's own buildHeader (its expand() verb — one
 * behaviour, every trigger lands on it).
 * @param {string} iconHtml @param {() => void} onClick @returns {HTMLButtonElement}
 */
export function expandButton(iconHtml, onClick) {
  const xb = document.createElement('button')
  xb.className = 'sieve-block__expand-btn'
  xb.setAttribute('aria-label', 'Expand')
  xb.innerHTML = iconHtml || '⤢'
  xb.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); onClick() })
  return xb
}

/** Base slot — override render() or subclass AdvancedHeaderProvider. */
export class SieveBlockHeader {
  /** @param {object} [_attrs] @param {object} [_ctx] @returns {HTMLElement} */
  render(_attrs, _ctx) { return hdrEl('sieve-block__header') }
}

/** Built-in: badge only. */
export class BadgeOnlyHeader extends SieveBlockHeader {
  /** @param {any} badge */
  constructor(badge) { super(); this._badge = badge }
  /** @param {object} attrs @returns {HTMLElement} */
  render(attrs) {
    const bar = hdrEl('sieve-block__header')
    bar.contentEditable = 'false'
    const text = resolveBadge(this._badge, attrs)
    if (text != null && text !== '') bar.appendChild(badgeEl(text))
    return bar
  }
}

// Built-in: the toolbar. render() is the template:
//   [badge][...left][...center][spacer][...right]. Subclass + override hooks.
export class AdvancedHeaderProvider extends SieveBlockHeader {
  /** @param {object} [_attrs] @returns {string|number|Element|null} */
  badge(_attrs) { return null }
  /** @param {object} [_attrs] @param {object} [_ctx] @returns {(Node|null)[]} */
  left(_attrs, _ctx) { return [] }
  /** @param {object} [_attrs] @param {object} [_ctx] @returns {(Node|null)[]} */
  center(_attrs, _ctx) { return [] }
  /** @param {object} [_attrs] @param {object} [_ctx] @returns {(Node|null)[]} */
  right(_attrs, _ctx) { return [] }
  /** @param {object} attrs @param {object} ctx @returns {HTMLElement} */
  render(attrs, ctx) {
    const bar = hdrEl('sieve-block__header')
    bar.contentEditable = 'false'
    const b = this.badge(attrs)
    if (b != null && b !== '') bar.appendChild((b instanceof Element) ? b : badgeEl(b))
    appendAll(bar, this.left(attrs, ctx))
    appendAll(bar, this.center(attrs, ctx))
    const spacer = hdrEl(); spacer.style.flex = '1'; bar.appendChild(spacer)
    appendAll(bar, this.right(attrs, ctx))
    return bar
  }
}

// A header re-render rebuilds the whole toolbar so button states track live
// attrs. When the bar holds a control the user is actively in — log's Filter…
// input — the LIVE focused control is kept across the rebuild: its actual DOM
// node moves into the fresh tree at the matching slot (value/caret intact) and
// is re-focused after mounting, since reparenting blurs it.

const HEADER_FOCUSABLE = 'input, textarea, select, button'

// The per-block context the provider needs (injected actions + live view state
// such as log's columns) is passed per call by the kind; HeaderBar holds only
// its current bar element.

export class HeaderBar {
  /** @type {SieveBlockHeader} */ #provider
  /** @type {((bar: HTMLElement, attrs: object, ctx: object) => void)|null} */ #decorate
  /** @type {HTMLElement|null} */ #el = null

  /**
   * @param {SieveBlockHeader} provider  declarative bar layout (badge/left/right)
   * @param {(bar: HTMLElement, attrs: object, ctx: object) => void} [decorate]
   *   optional post-build step — e.g. appending the expand button when expandable.
   */
  constructor(provider, decorate) {
    this.#provider = provider
    this.#decorate = decorate || null
  }

  /** The current bar element. */
  get el() { return this.#el }

  /** @param {object} attrs @param {object} ctx @returns {HTMLElement} */
  #build(attrs, ctx) {
    const bar = this.#provider.render(attrs, ctx)
    if (this.#decorate) this.#decorate(bar, attrs, ctx)
    return bar
  }

  /** Initial build. @param {object} attrs @param {object} ctx @returns {HTMLElement} */
  render(attrs, ctx) {
    this.#el = this.#build(attrs, ctx)
    return this.#el
  }

  /** Re-render in place, preserving a focused control. @param {object} attrs @param {object} ctx */
  update(attrs, ctx) {
    if (!this.#el) return
    const fresh = this.#build(attrs, ctx)
    const snap = HeaderBar.adoptFocusedControl(this.#el, fresh)
    if (this.#el.parentNode) this.#el.parentNode.replaceChild(fresh, this.#el)
    this.#el = fresh
    HeaderBar.restoreFocusedControl(snap)
  }

  /**
   * Move the live focused control from oldBar into freshBar at the matching slot
   * (same index among focusable descendants, same tag). Returns a snapshot for
   * restoreFocusedControl, or null if nothing in oldBar was focused. Call BEFORE
   * freshBar is mounted; call restoreFocusedControl AFTER (a detached element
   * can't hold focus).
   * @param {HTMLElement} oldBar @param {HTMLElement} freshBar
   * @returns {{ el: HTMLElement, selectionStart: number|null, selectionEnd: number|null }|null}
   */
  static adoptFocusedControl(oldBar, freshBar) {
    const active = /** @type {any} */ ((typeof document !== 'undefined') ? document.activeElement : null)
    if (!oldBar || !freshBar || !active || !oldBar.contains(active)) return null
    const oldList = Array.prototype.slice.call(oldBar.querySelectorAll(HEADER_FOCUSABLE))
    const idx = oldList.indexOf(active)
    if (idx < 0) return null
    const freshList = Array.prototype.slice.call(freshBar.querySelectorAll(HEADER_FOCUSABLE))
    const twin = freshList[idx]
    if (!twin || twin.tagName !== active.tagName || !twin.parentNode) return null
    const ss = (typeof active.selectionStart === 'number') ? active.selectionStart : null
    const se = (typeof active.selectionEnd === 'number') ? active.selectionEnd : null
    twin.parentNode.replaceChild(active, twin)   // fresh tree now holds the LIVE control
    return { el: active, selectionStart: ss, selectionEnd: se }
  }

  /**
   * Re-focus the adopted control (the reparent blurred it) and restore its
   * caret. No-op when adoptFocusedControl returned null.
   * @param {{ el: HTMLElement, selectionStart: number|null, selectionEnd: number|null }|null} snap
   */
  static restoreFocusedControl(snap) {
    if (!snap || !snap.el) return
    if (typeof snap.el.focus === 'function') snap.el.focus()
    const el = /** @type {any} */ (snap.el)
    if (snap.selectionStart !== null && typeof el.setSelectionRange === 'function') {
      try { el.setSelectionRange(snap.selectionStart, snap.selectionEnd) } catch (e) {}
    }
  }
}
