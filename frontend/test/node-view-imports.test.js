// @ts-check
// node-view-imports.test.js — every NodeView adapter module must RESOLVE and
// EVALUATE. A stale import specifier (the 2026-07-21 processors/*-renderer.js →
// node-views/*-node-view.js rename left smart-image importing a dead
// './diagram-renderer.js') kills the whole module's evaluation in the browser,
// which silently unregisters the kind: every block of that kind is DROPPED from
// the editor on load, with only a console error ("produced no sieve-<kind>
// node"). Importing each module here makes a dead specifier fail CI instead of
// the user's document. Registration itself is a no-op without the vendor
// runtime (NodeViewRegistry's #runtime is null under the test stub), so these
// imports are side-effect-safe.
import { describe, it, expect } from 'vitest'

// ai-target-decoration.js runs `new T.PluginKey(...)` and `T.Extension.create`
// at module scope — present in the real vendor bundle, absent from the test
// stub. Stub ONLY those members (never T.Node — registration must stay a no-op
// here) so a dead import specifier is the single failure mode this suite can
// report.
Object.assign(/** @type {any} */ (globalThis).TipTap, {
  PluginKey: class PluginKey {},
  Extension: { create: (/** @type {any} */ o) => o },
})

const KINDS = [
  'ai-block',
  'code',
  'diagram',
  'log',
  'smart-card',
  'smart-image',
  'smart-link',
  'web-clip',
]

describe('node-view module graph resolves', () => {
  for (const kind of KINDS) {
    it(`${kind}-node-view.js imports cleanly`, async () => {
      await expect(
        import(`../src/static/editor/surfaces/node-views/${kind}-node-view.js`),
      ).resolves.toBeTruthy()
    })
  }
})
