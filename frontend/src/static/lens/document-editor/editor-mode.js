// @ts-check
// editor-mode.js — the editing-mode value type (P2.C).
// A frozen enum (docs/how-to-idiomatic-js.md §3): the ONE definition of the
// mode vocabulary the editor hierarchy and its surfaces share. setMode(mode)
// is the N-mode primitive; toggleMode() is binary-flip sugar over it (see
// abstract-editor.js). A future third mode adds explicit call sites invoking
// setMode(EditorMode.X) — it does NOT grow toggleMode, and there is
// deliberately no supportedModes list or mode registry (no second consumer).
//
// IMPORT SCOPE (NORMATIVE): mode is editor-internal vocabulary. Only the
// shell editor hierarchy (abstract/note/prompt-editor, surfaces) and their
// tests may import EditorMode. (SieveTab earliest in P2.D, when it becomes
// the mode record-keeper — not before.) workspace.js, tab.js, main.go menu
// strings, and index.html must contain ZERO mode literals or EditorMode
// references — a caller that speaks mode is reading Editor implementation.
// Callers above the editor use the argument-free, mode-nameless toggleMode()
// contract and depend only on the AbstractEditor abstraction.
//
// Dual-use ES module (block-position.js pattern): export for vitest/module
// imports; window.* for classic-script (editor.js IIFE) reach if needed.

/** @typedef {'wysiwyg'|'markdown'} EditorModeValue */

export const EditorMode = Object.freeze({
  /** @type {EditorModeValue} */ WYSIWYG: 'wysiwyg',
  /** @type {EditorModeValue} */ MARKDOWN: 'markdown',
})

window.SieveEditorMode = EditorMode
