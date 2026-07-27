// @ts-check
// link-edit-dialog.js — THE modal for editing a hyperlink's URL and display
// title. One <dialog>, one class, every caller.
//
// WHY IT LIVES IN ui/ AND NOT IN A NODE-VIEW. It started life inside
// smart-card-node-view.js, which made it look like a smart-card concern; it
// never was. Nothing in it speaks ProseMirror, block attrs or the wire — it
// collects two strings and hands them back. It now has two consumers that share
// nothing but that shape:
//   • the smart-card NodeView (`sieve:smart-card-edit`) → renderer.setLink()
//   • a prose `link` mark (ProseLink.edit — Mod+K and the context menu) → a
//     tracked PM transaction
// A UI surface shared across kinds belongs beside ui/media-lightbox.js (the
// same shape: a class + a lazy singleton + one thin verb), not inside either
// consumer. #67.
//
// The caller supplies the SAVE behaviour (`onSave`); the dialog owns only the
// DOM, the Enter/Escape wiring, and the "blank title falls back to the URL"
// rule. It never touches a document.

/**
 * @typedef {object} LinkEditSpec
 * @property {string} [href]
 *   — the URL to prefill
 * @property {string} [label]
 *   — the display title to prefill
 * @property {string} [title]
 *   — the dialog's own heading (default "Edit Link")
 * @property {(href: string, label: string) => void} onSave
 *   — called with the trimmed URL and display title. A blank title is replaced
 *     by the URL before the call, so consumers never re-implement that rule.
 *     Not called at all when the URL is blank (the dialog stays open).
 */

export class LinkEditDialog {
  /** @type {LinkEditDialog|null} */
  static #singleton = null

  /** The process-wide dialog (lazily constructed). @returns {LinkEditDialog} */
  static shared() { return (LinkEditDialog.#singleton ??= new LinkEditDialog()) }

  /** @type {HTMLDialogElement|null} */ #dialog = null
  /** @type {HTMLInputElement|null} */ #hrefInput = null
  /** @type {HTMLInputElement|null} */ #labelInput = null
  /** @type {HTMLElement|null} */ #heading = null
  /** @type {((href: string, label: string) => void)|null} */ #onSave = null

  /**
   * Prefills and shows the dialog. A second open replaces the first's binding —
   * there is only ever one link being edited.
   * @param {LinkEditSpec} spec
   */
  open(spec) {
    if (!spec || typeof spec.onSave !== 'function') return
    const dlg = this.#ensure()
    if (!dlg || !this.#hrefInput || !this.#labelInput || !this.#heading) return
    this.#onSave = spec.onSave
    this.#heading.textContent = spec.title || 'Edit Link'
    this.#hrefInput.value = spec.href || ''
    this.#labelInput.value = spec.label || ''
    if (!dlg.open) dlg.showModal()
    // The URL is always the field in play — creating a link from selected text
    // arrives with the label already filled and the URL blank.
    const href = this.#hrefInput
    requestAnimationFrame(() => href.select())
  }

  /** Closes the dialog and drops the caller's save binding. */
  close() {
    this.#onSave = null
    if (this.#dialog && this.#dialog.open) this.#dialog.close()
  }

  /**
   * Lazily builds the <dialog> on first open (no DOM in the constructor —
   * vitest-safe, matching InsertDialogs).
   * @returns {HTMLDialogElement|null}
   */
  #ensure() {
    if (this.#dialog) return this.#dialog
    if (typeof document === 'undefined') return null

    const dlg = /** @type {HTMLDialogElement} */ (document.createElement('dialog'))
    dlg.className = 'ask-popup link-edit-popup'

    const header = document.createElement('div')
    header.className = 'ask-popup__header'
    const heading = document.createElement('span')
    heading.className = 'ask-popup__label'
    heading.textContent = 'Edit Link'
    const closeBtn = document.createElement('button')
    closeBtn.className = 'ask-popup__close'
    closeBtn.textContent = '✕'
    closeBtn.title = 'Close (Esc)'
    closeBtn.addEventListener('click', () => this.close())
    header.append(heading, closeBtn)

    const hrefInput = document.createElement('input')
    hrefInput.type = 'url'
    hrefInput.className = 'block-edit-popup__input'
    hrefInput.placeholder = 'URL (https://…)'

    const labelInput = document.createElement('input')
    labelInput.type = 'text'
    labelInput.className = 'block-edit-popup__input'
    labelInput.placeholder = 'Display title'

    const footer = document.createElement('div')
    footer.className = 'ask-popup__footer'
    const saveBtn = document.createElement('button')
    saveBtn.className = 'ask-popup__send'
    saveBtn.textContent = 'Save'
    saveBtn.addEventListener('click', () => this.#save())
    footer.appendChild(saveBtn)

    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this.close() }
      if (e.key === 'Enter') { e.preventDefault(); this.#save() }
    })

    dlg.append(header, hrefInput, labelInput, footer)
    document.body.appendChild(dlg)

    this.#dialog = dlg
    this.#hrefInput = hrefInput
    this.#labelInput = labelInput
    this.#heading = heading
    return dlg
  }

  /** Validates, applies the blank-title fallback, hands over, closes. */
  #save() {
    if (!this.#hrefInput || !this.#labelInput) return
    const href = this.#hrefInput.value.trim()
    if (!href) return                                  // no URL: stay open
    const label = this.#labelInput.value.trim() || href
    const onSave = this.#onSave
    this.close()
    if (onSave) onSave(href, label)
  }
}

/**
 * Opens THE shared link dialog — the one-line call site every consumer uses
 * (mirrors media-lightbox.js's `expandBlock`).
 * @param {LinkEditSpec} spec
 */
export function openLinkEditor(spec) { LinkEditDialog.shared().open(spec) }
