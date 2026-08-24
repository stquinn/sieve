// @ts-check
// seed-vendor.js — seeds globalThis.TipTap with permissive proxy stand-ins for the
// vendor members the side-effect extension modules read at MODULE-EVAL time
// (lens/extensions.js, lens/block-chrome.js, lens/surfaces/ai-target-decoration.js do
// `VENDOR.Extension.create/.extend` / `new VENDOR.PluginKey(...)` as they load).
//
// Import this FIRST — before any module that transitively imports those (e.g.
// WysiwygSurface) — so their top-level Extension.create doesn't throw against the
// bare test/setup.js bag. Static imports evaluate in source order, so a leading
// side-effecting import of this module wins the race. Additive: seeds only members
// not already present, never reassigning globalThis.TipTap (tiptap-vendor.js
// captured the object). Use this when a test needs the REAL extensions.js exports
// (e.g. buildAiContext); tests that don't should vi.mock those modules instead.

// A callable + constructable Proxy: every property access / call / `new` yields
// another such proxy, and .create()/.extend() do too — permissive enough that
// whatever member a side-effect module reads at eval time behaves.
function makeProxy() {
  const fn = function () { return makeProxy() }
  fn.create = () => makeProxy()
  fn.extend = () => makeProxy()
  return new Proxy(fn, {
    apply() { return makeProxy() },
    construct() { return makeProxy() },
    get(t, prop) {
      if (prop in t) return t[prop]
      const child = makeProxy()
      t[prop] = child
      return child
    },
  })
}

const MEMBERS = ['Node', 'Extension', 'Plugin', 'PluginKey', 'Decoration', 'DecorationSet', 'Highlight', 'markdownItMark']
const bag = /** @type {any} */ (globalThis).TipTap = /** @type {any} */ (globalThis).TipTap || {}
for (const name of MEMBERS) if (!bag[name]) bag[name] = makeProxy()

export {}
