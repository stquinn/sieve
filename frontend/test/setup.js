// @ts-check
// setup.js — vitest setupFiles (see vitest.config.js). Installs the shared
// vendor-global object BEFORE any test module imports lens/surfaces/tiptap-vendor.js,
// so its exported bag `T` captures this same object. Tests stub vendor
// members via Object.assign(globalThis.TipTap, {...}) — NEVER reassign
// globalThis.TipTap (a reassignment would orphan the captured bag).
/** @type {any} */ (globalThis).TipTap = /** @type {any} */ (globalThis).TipTap || {}
