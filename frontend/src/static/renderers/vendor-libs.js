// @ts-check
// The LIB SEAM over the vendor IIFE global: the bundle carries more than
// ProseMirror, and the standalone libraries the PM-FREE renderer package needs
// flow through here as `T.<member>` live reads.
//
// Only renderers/ reads through this seam, and only for bundled libraries —
// never a ProseMirror member, which would smuggle PM into a package that is
// PM-free by construction. Its PM twin is surfaces/tiptap-vendor.js.

/** Bundled non-PM libraries (live member reads: MarkdownIt, markdownItMark,
 *  createLowlight, common). @type {any} */
export const T = /** @type {any} */ (globalThis).TipTap || {}
