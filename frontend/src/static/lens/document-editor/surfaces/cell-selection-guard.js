// @ts-check
// Keeps a table cell selection alive across the gesture that opens a menu over it.
//
// A right-click inside a `contenteditable` is a caret-placing gesture: the
// browser moves the DOM selection to the clicked point and ProseMirror reads it
// back, so a `CellSelection` becomes a `TextSelection` in the one cell clicked —
// before the menu built over it runs anything. prosemirror-tables does not
// defend against it; its own mouse handling returns on the first line for any
// button but the primary one.
//
// Inside the selection the gesture is therefore refused outright. Outside it,
// nothing is claimed and the click collapses the selection as any click does,
// which is what a spreadsheet does.

/** prosemirror-tables' own decoration class on every cell of a `CellSelection`,
 *  and the one `editor.css` skins — so the cells this guard keeps are exactly
 *  the cells the user can see are selected. */
const SELECTED_CELL = 'td.selectedCell, th.selectedCell'

export class CellSelectionGuard {
  /** Whether `event` is the context-menu gesture landing inside the live cell
   *  selection, refusing it when it is. Wired at `editorProps.handleDOMEvents`,
   *  whose handlers ProseMirror consults before any plugin's.
   *  @param {any} view the EditorView
   *  @param {MouseEvent} event
   *  @returns {boolean} true when the gesture was consumed */
  handleMouseDown(view, event) {
    if (!CellSelectionGuard.#opensContextMenu(event)) return false
    if (!CellSelectionGuard.#isCellSelection(view.state.selection)) return false
    const target = /** @type {any} */ (event.target)
    if (!target || !target.closest || !target.closest(SELECTED_CELL)) return false
    event.preventDefault()
    return true
  }

  /** The context-menu gesture in both its forms: the right button, and — on
   *  macOS ALONE — Ctrl+left. Everywhere else Ctrl+left is Mod+click, the app's
   *  link activation, and claiming it would swallow a gesture with no menu
   *  behind it. @param {MouseEvent} event @returns {boolean} */
  static #opensContextMenu(event) {
    return event.button === 2 || (event.button === 0 && event.ctrlKey && CellSelectionGuard.#isMac())
  }

  /** Whether this is a macOS host. Read per call, not captured at load: it is
   *  the one thing about the gesture a test has to vary. @returns {boolean} */
  static #isMac() {
    return typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform || '')
  }

  /** Whether `selection` is a `CellSelection`, read by its shape rather than by
   *  `instanceof`: the class is not exported on the TipTap global, and this is
   *  the test prosemirror-tables makes of a selection itself.
   *  @param {any} selection @returns {boolean} */
  static #isCellSelection(selection) {
    return !!selection && '$anchorCell' in selection
  }
}
