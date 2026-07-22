// @ts-check
// tiptap-vendor.js — the PM SEAM over the vendor IIFE global (esbuild
// --global-name=TipTap, frontend/src/static/vendor/tiptap.js). Everything
// ProseMirror/TipTap in app code flows through this module as `T.<member>`
// live reads: Node, Extension, Plugin, PluginKey, Decoration, DecorationSet,
// mergeAttributes, NodeSelection, the DOMParser, Highlight, CodeBlockLowlight, …
//
// DOCTRINE (P4.E D-1; issue #49 P5 vendor-seam split): there are exactly TWO
// named seams over the one `window.TipTap` bundle global, and every reader
// picks the seam that matches WHAT it reads:
//   • this file (editor/surfaces/tiptap-vendor.js) — PM/editor reads only, for
//     surfaces, extensions, node-views and the PM-bearing block extensions
//     (prose-block, prose-group, sieve-block-extension, ai-target-decoration).
//   • block/renderers/vendor-libs.js — bundled NON-PM libs only (MarkdownIt,
//     markdownItMark, createLowlight, common). The PM-free renderer package
//     reads THROUGH THAT seam and never imports this one.
// No file reads `globalThis.TipTap` directly; nothing outside block/renderers/
// imports vendor-libs. In vitest, test/setup.js installs the shared object
// before any import; tests stub members via Object.assign(globalThis.TipTap,
// {...}) and never reassign it (a reassignment would orphan the captured bag).

/** TipTap/ProseMirror vendor namespace (live member reads). @type {any} */
export const T = /** @type {any} */ (globalThis).TipTap || {}
