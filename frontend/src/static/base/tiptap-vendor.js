// @ts-check
// tiptap-vendor.js — THE single read of the vendor IIFE global (esbuild
// --global-name=TipTap, frontend/src/static/vendor/tiptap.js). Everything
// TipTap/ProseMirror in app code flows through this module as `T.<member>`
// live reads.
// NORMATIVE (P4.E D-1): no other file may read the vendor global. In vitest,
// test/setup.js installs the shared object before any import; tests stub
// members via Object.assign(globalThis.TipTap, {...}) and never reassign it.

/** TipTap/ProseMirror vendor namespace (live member reads). @type {any} */
export const T = /** @type {any} */ (globalThis).TipTap || {}
