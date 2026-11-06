// @ts-check
// Where a reader is in a Digital Note, as an ink surface feeds it to its lens's
// selection model: nothing selected, the whole note as the target, and the
// place — mode, page, index, page count — beside it.

/** @typedef {import('../document-editor/selection-model.js').RawSelectionDescriptor} RawSelectionDescriptor */

export class InkPlace {
  /**
   * @param {string} mode the lens mode the surface presents
   * @param {string|null} page the id of the page shown; null while none is
   * @param {number} pageIndex its index among the note's pages; -1 while none is shown
   * @param {number} pages how many pages the note has
   * @returns {Readonly<RawSelectionDescriptor>}
   */
  static describe(mode, page, pageIndex, pages) {
    const at = pageIndex >= 0 ? `Page ${pageIndex + 1} of ${pages}` : 'No page'
    const label = mode === 'transcript' ? `${at}, transcript` : at
    return Object.freeze({
      selectionType: 'none',
      target: Object.freeze({ kind: 'document', ref: 'doc', range: null, label }),
      ink: Object.freeze({ mode, page, pageIndex, pages }),
    })
  }
}
