// prose-group-identity.test.js — regression guard for the multi-node-block split
// data-loss bug. A backend prose block whose content is multi-node renders as ONE
// `proseGroup` container carrying the id. When that container is SPLIT (Enter
// inside it), ProseMirror copies its attrs, so the new half is born with the
// original's id; the identity plugin RE-MINTS that duplicate through
// setNodeMarkup. That can only stick if `proseGroup` DECLARES an `id` attribute
// of its own — the global one lives on the single native prose node types
// (PROSE_NODE_TYPES in prose-block.js), not on proseGroup. Without it the write
// is silently dropped, the split half ends up nameless, the block observer skips
// it, and everything after the split is LOST from the container.
//
// prose-group.js builds its real ProseGroup node only when T.Node exists
// (guarded so the module is importable in a bare vitest env). Stub Node onto the
// shared vendor bag (mutate, never reassign — tiptap-vendor.js already captured a
// reference to it) so the real node spec is constructed, then import once
// (modules are cached) to get the real ProseGroup ES export.

import { describe, it, expect } from 'vitest'

Object.assign(globalThis.TipTap, {
  Node: { create: (cfg) => cfg },
})

const { ProseGroup } = await import('../src/static/lens/document-editor/surfaces/prose-group.js')

describe('proseGroup identity attributes (multi-node split)', () => {
  it('declares its durable `id` attribute, so a re-minted split half keeps its name', () => {
    const attrs = ProseGroup.addAttributes()
    expect(attrs).toHaveProperty('id')
    expect(attrs.id.default).toBe('')
  })

  it('declares NOTHING else — a block is born with its id, so there is no pending handle', () => {
    expect(Object.keys(ProseGroup.addAttributes())).toEqual(['id'])
  })
})
