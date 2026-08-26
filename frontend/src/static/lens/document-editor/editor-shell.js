// @ts-check
// Backward-compat shim: `SieveEditor` is an alias of AbstractEditor, kept wired on
// window for classic-script and console reach-in. New code imports AbstractEditor
// (or the concrete NoteEditor/PromptEditor) directly.

import { AbstractEditor } from '../abstract-editor.js'

export { AbstractEditor as SieveEditor } from '../abstract-editor.js'

// Expose on window for classic-script access from editor.js and the console.
window.SieveEditor = AbstractEditor
