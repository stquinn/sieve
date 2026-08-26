// @ts-check
// The PM SEAM over the vendor IIFE global. Everything ProseMirror/TipTap in app
// code flows through this module as `T.<member>` live reads.
//
// The PM-free renderers/ package has its OWN seam (renderers/vendor-libs.js) for
// the bundled non-PM libs, and must never import this one.

/** TipTap/ProseMirror vendor namespace (live member reads). @type {any} */
export const T = /** @type {any} */ (globalThis).TipTap || {}
