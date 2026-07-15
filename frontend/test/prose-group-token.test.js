// prose-group-token.test.js — regression guard for the multi-node-block split
// data-loss bug (B-A). A backend prose block whose content is multi-node renders
// as ONE `proseGroup` container carrying the id. When that container is SPLIT
// (Enter inside it), ProseMirror copies its attrs, so the new half is born with
// the original's id; the identity plugin CLEARS that duplicate id and stamps a
// transient `token` (the backend-authoritative create handle). That token can only
// persist if `proseGroup` DECLARES a `token` attribute — the B-A `token` global
// attr lives on the single native prose node types (PROSE_NODE_TYPES), NOT on
// proseGroup. Without the attr, setNodeMarkup({token}) is silently dropped, the
// split half ends up with NEITHER id NOR token, the block observer skips it
// (key = id||token = ''), and everything after the split is LOST from the shadow
// doc. So proseGroup MUST carry the transient token too. This test asserts it.
//
// prose-group.js builds its real ProseGroup node only when T.Node exists
// (guarded so the module is importable in a bare vitest env). Stub Node onto the
// shared vendor bag (mutate, never reassign — tiptap-vendor.js already captured a
// reference to it) so the real node spec is constructed, then import once
// (modules are cached) to get the real ProseGroup ES export (the bus is retired).

import { describe, it, expect } from 'vitest'

Object.assign(globalThis.TipTap, {
  Node: { create: (cfg) => cfg },
})

const { ProseGroup } = await import('../src/static/block/prose-group.js')

describe('proseGroup identity attributes (B-A multi-node split)', () => {
  it('still declares its durable `id` attribute', () => {
    const attrs = ProseGroup.addAttributes()
    expect(attrs).toHaveProperty('id')
    expect(attrs.id.default).toBe('')
  })

  it('declares a TRANSIENT `token` attribute so a split proseGroup can carry the backend token (regression: data loss on multi-node split)', () => {
    const attrs = ProseGroup.addAttributes()
    expect(attrs).toHaveProperty('token')
    expect(attrs.token.default).toBe('')
    expect(attrs.token.rendered).toBe(false) // transient: never in HTML or markdown
  })
})
