// @ts-check
// Places an asset from the Assets tab into the active document: Insert at the
// caret, or drag to a block boundary. Both send the SAME paste and differ only in
// where it lands, which is the lens's to decide.
//
// The tab is server-rendered markup a swap replaces on every tab switch, so this
// listens on a stable ancestor and reads each row's data attributes at the moment
// of the gesture:
//
//   [data-asset-document]  the document the listed assets belong to
//   [data-asset-row]       one asset: data-asset-address (its absolute sieve
//                          address) and data-asset-holder (the id of a block
//                          holding it whose own view a placement is built from;
//                          empty when none does)
//   [data-asset-insert]    the row's Insert button

import { ASSET_DRAG_TYPE } from '../contract/container-provider.js'

/** @typedef {import('../contract/container-provider.js').ContentEntry} ContentEntry */

export class AssetPlacement {
  /** @type {{activeTab: any, activeBlockEditor: () => any}} */ #ws
  /** @type {EventTarget} */ #root
  /** @type {(e: Event) => void} */ #onClick
  /** @type {(e: Event) => void} */ #onDragStart

  /**
   * @param {{activeTab: any, activeBlockEditor: () => any}} ws the workspace whose active tab receives placements
   * @param {EventTarget} [root] the stable ancestor listened on (the document in the app)
   */
  constructor(ws, root) {
    this.#ws = ws
    this.#root = root || document
    this.#onClick = (e) => this.#insert(/** @type {MouseEvent} */ (e))
    this.#onDragStart = (e) => this.#dragStart(/** @type {DragEvent} */ (e))
  }

  /** @returns {this} */
  attach() {
    this.#root.addEventListener('click', this.#onClick)
    this.#root.addEventListener('dragstart', this.#onDragStart)
    return this
  }

  /** @returns {this} */
  detach() {
    this.#root.removeEventListener('click', this.#onClick)
    this.#root.removeEventListener('dragstart', this.#onDragStart)
    return this
  }

  /**
   * The paste that places the asset `row` names in the active tab's document.
   * An asset the row names a holder for is that block's own `sieve/{kind}` view,
   * which the server places sharing the same file, description carried. Any
   * other asset — including one whose holder the tab's document no longer holds
   * — is its address as a `text/uri-list`, which the server adopts in place.
   * Null when the row is not the active document's.
   * @param {Element} row a [data-asset-row]
   * @returns {ContentEntry[]|null}
   */
  entriesFor(row) {
    const tab = this.#ws.activeTab
    const container = row.closest('[data-asset-document]')?.getAttribute('data-asset-document') || ''
    if (!tab || !container || tab.uuid !== container) return null
    const address = row.getAttribute('data-asset-address') || ''
    const holderId = row.getAttribute('data-asset-holder') || ''
    const provider = tab.mount && tab.mount.provider
    const holder = holderId && provider ? provider.getBlock(holderId) : null
    if (!holder) return address ? [{ mimeType: 'text/uri-list', content: address }] : null
    return [{
      mimeType: 'sieve/' + holder.kind,
      content: JSON.stringify(Object.assign({}, holder.attrs, { kind: holder.kind })),
      context: { container },
    }]
  }

  /** @param {MouseEvent} e */
  #insert(e) {
    const button = /** @type {Element|null} */ (e.target instanceof Element ? e.target.closest('[data-asset-insert]') : null)
    const row = button && button.closest('[data-asset-row]')
    if (!row) return
    const entries = this.entriesFor(row)
    const editor = this.#ws.activeBlockEditor()
    if (!entries || !editor) return
    editor.pasteEntries(entries)
  }

  /** @param {DragEvent} e */
  #dragStart(e) {
    const row = e.target instanceof Element ? e.target.closest('[data-asset-row][draggable="true"]') : null
    if (!row || !e.dataTransfer) return
    const entries = this.entriesFor(row)
    if (!entries) { e.preventDefault(); return }
    e.dataTransfer.setData(ASSET_DRAG_TYPE, JSON.stringify(entries))
    e.dataTransfer.effectAllowed = 'copy'
  }
}
