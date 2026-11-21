// @ts-check
// Where a reader is in a Digital Note, as an ink surface feeds it to its lens's
// selection model: nothing selected, and the whole note as the target, labelled
// with the page shown as PageNames places it.

/** @typedef {import('../../renderers/page-names.js').PageNames} PageNames */
/** @typedef {import('../../renderers/page-names.js').NamedPage} NamedPage */
/** @typedef {import('../document-editor/selection-model.js').RawSelectionDescriptor} RawSelectionDescriptor */

export class InkPlace {
  /**
   * @param {string} mode the lens mode the surface presents
   * @param {PageNames} names what the pages are called
   * @param {ReadonlyArray<NamedPage>} pages the note's pages
   * @param {number} pageIndex the index of the page shown among them; -1 while none is shown
   * @returns {Readonly<RawSelectionDescriptor>}
   */
  static describe(mode, names, pages, pageIndex) {
    const at = pageIndex >= 0 ? names.place(pages, pageIndex) : 'No page'
    const label = mode === 'transcript' ? `${at}, transcript` : at
    return Object.freeze({
      selectionType: 'none',
      target: Object.freeze({ kind: 'document', ref: 'doc', range: null, label }),
    })
  }
}
