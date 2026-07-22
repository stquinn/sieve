// @ts-check
// vendor-libs.js — the LIB SEAM over the vendor IIFE global (esbuild
// --global-name=TipTap, frontend/src/static/vendor/tiptap.js). The bundle
// carries more than ProseMirror: it also exposes the standalone rendering
// libraries the PM-FREE renderer package needs — MarkdownIt, markdownItMark,
// createLowlight, common. Those flow through this module as `T.<member>` live
// reads.
//
// DOCTRINE (issue #49 P5 vendor-seam split): this is the NON-PM half of the
// single-read split (its PM twin is editor/surfaces/tiptap-vendor.js). Only
// block/renderers/ reads through here, and only for bundled libraries — never
// a ProseMirror/editor member (that would smuggle PM into the renderer
// package, which is PM-free by construction). Conversely no renderer imports
// tiptap-vendor.js: after the split there are zero tiptap-vendor imports under
// block/renderers/. Both seams read the SAME `window.TipTap` object; the
// boundary is doctrinal (who may read what), enforced by which file you import.
// In vitest, test/setup.js installs the shared object before any import.

/** Bundled non-PM libraries (live member reads: MarkdownIt, markdownItMark,
 *  createLowlight, common). @type {any} */
export const T = /** @type {any} */ (globalThis).TipTap || {}
