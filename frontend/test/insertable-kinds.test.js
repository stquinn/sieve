// @ts-check
// insertable-kinds.test.js — the KEYBOARD-INSERTABLE half of the block
// vocabulary (#91): the kinds a `{` and a name can make out of nothing.
//
// A kind is insertable because ITS RENDERER CLASS SAYS SO, so this walks the
// real renderer manifest rather than a fixture — the list asserted here is the
// list the picker offers. No NodeView is loaded, so a kind's icon resolves
// through the empty kind registry: what is pinned about it is that a missing
// icon is an empty string, never a throw.
import { describe, it, expect } from 'vitest'
import { listInsertableKinds } from '../src/static/renderers/block-renderers.js'

/** @returns {Record<string, any>} the offered kinds, keyed by kind */
function byKind() {
  /** @type {Record<string, any>} */
  const out = {}
  for (const entry of listInsertableKinds()) out[entry.kind] = entry
  return out
}

describe('listInsertableKinds — what a keystroke can make', () => {
  it('offers exactly the kinds born empty from the keyboard', () => {
    expect(listInsertableKinds().map((k) => k.kind)).toEqual(['code', 'diagram', 'log'])
  })

  it('never offers a kind that is born some OTHER way', () => {
    // prose is typed, ai-block comes from Ask, reference from `@`, the smart
    // kinds from paste, command-result from a command.
    const offered = listInsertableKinds().map((k) => k.kind)
    for (const kind of ['prose', 'ai-block', 'reference', 'smart-image', 'smart-card', 'web-clip', 'command-result']) {
      expect(offered).not.toContain(kind)
    }
  })

  it('names each kind and says what it is', () => {
    const kinds = byKind()
    expect(kinds.code.label).toBe('Code')
    expect(kinds.diagram.label).toBe('Diagram')
    expect(kinds.log.label).toBe('Log')
    for (const entry of listInsertableKinds()) expect(entry.description).toBeTruthy()
  })

  it('starts every kind from the server\'s own defaults — no invented attrs', () => {
    for (const entry of listInsertableKinds()) expect(entry.defaults).toEqual({})
  })

  it('hands each entry its OWN defaults object — the create path enriches attrs', () => {
    const first = listInsertableKinds()[0]
    const second = listInsertableKinds()[0]
    expect(first.defaults).not.toBe(second.defaults)
    first.defaults.language = 'go'
    expect(listInsertableKinds()[0].defaults).toEqual({})
  })

  it('carries an icon slot that is a string even when no NodeView has registered one', () => {
    for (const entry of listInsertableKinds()) expect(typeof entry.icon).toBe('string')
  })
})
