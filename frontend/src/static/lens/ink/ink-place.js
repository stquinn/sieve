// @ts-check
// Where a reader is in a Digital Note, as an ink surface feeds it to its lens's
// selection model: nothing selected, and the whole note as the target, labelled
// with the page shown.

/** @typedef {import('../document-editor/selection-model.js').RawSelectionDescriptor} RawSelectionDescriptor */

export class InkPlace {
  /**
   * @param {string} mode the lens mode the surface presents
   * @param {number} pageIndex the index of the page shown among the note's pages; -1 while none is shown
   * @param {number} pages how many pages the note has
   * @returns {Readonly<RawSelectionDescriptor>}
   */
  static describe(mode, pageIndex, pages) {
    const at = pageIndex >= 0 ? `Page ${pageIndex + 1} of ${pages}` : 'No page'
    const label = mode === 'transcript' ? `${at}, transcript` : at
    return Object.freeze({
      selectionType: 'none',
      target: Object.freeze({ kind: 'document', ref: 'doc', range: null, label }),
    })
  }
}
