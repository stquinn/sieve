// @ts-check
// editor-shell.js — backward-compat shim for the P1 `SieveEditor` name.
// P2.A promoted the editor from a thin read-only view into a real class
// hierarchy (abstract-editor.js + note-editor.js + prompt-editor.js). The P1
// `SieveEditor` identity survives as an alias of AbstractEditor: the base class
// carries the uuid/mode/tiptap surface P1 exposed, and `window.SieveEditor` stays
// wired for classic-script/console reach-in. New code imports AbstractEditor (or
// the concrete NoteEditor/PromptEditor) directly.

import { AbstractEditor } from '../abstract-editor.js'

export { AbstractEditor as SieveEditor } from '../abstract-editor.js'

// Expose on window for classic-script access from editor.js and the console.
window.SieveEditor = AbstractEditor
