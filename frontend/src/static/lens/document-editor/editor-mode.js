// @ts-check
// The ONE definition of the mode vocabulary the editor hierarchy and its
// surfaces share.
//
// IMPORT SCOPE (NORMATIVE): mode is editor-internal vocabulary. Only the editor
// hierarchy and its tests may import EditorMode — workspace.js, tab.js, the
// native menu strings and index.html must contain ZERO mode literals. A caller
// that speaks mode is reading Editor implementation; callers above the editor
// use the argument-free toggleMode() contract.

/** @typedef {'wysiwyg'|'markdown'} EditorModeValue */

export const EditorMode = Object.freeze({
  /** @type {EditorModeValue} */ WYSIWYG: 'wysiwyg',
  /** @type {EditorModeValue} */ MARKDOWN: 'markdown',
})

window.SieveEditorMode = EditorMode
