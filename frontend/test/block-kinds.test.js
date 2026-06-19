import { describe, it, expect, beforeEach } from 'vitest'
import { registerBlockKind, getBlockKind, listBlockKinds, isNativeProseNodeName } from '../src/static/block-kinds.js'

// block-kinds is the shared block-kind registry that restores model-layer
// symmetry: EVERY kind — prose included — is a registered block definition, so
// prose is a first-class kind alongside code/ai/diagram. The asymmetry is
// confined to HOW a kind renders (native nodes vs a sieve-<kind> NodeView),
// captured by the `native` flag.
describe('block-kinds registry', () => {
  beforeEach(() => {
    // reset between tests by re-registering known kinds (the module is a singleton)
    for (const k of listBlockKinds()) registerBlockKind({ kind: k, _gone: true })
  })

  it('registers and retrieves a native (prose) kind with its pieces', () => {
    const def = registerBlockKind({
      kind: 'prose', native: true,
      nodeTypes: ['paragraph', 'heading'],
      identityAttr: 'blockId',
      toMarkdown: (id, c) => `<!--s:${id}-->\n${c}\n<!--/s:${id}-->`,
    })
    expect(def).toBe(getBlockKind('prose'))
    expect(getBlockKind('prose').native).toBe(true)
    expect(getBlockKind('prose').identityAttr).toBe('blockId')
    expect(getBlockKind('prose').toMarkdown('pr-1', 'Hi')).toBe('<!--s:pr-1-->\nHi\n<!--/s:pr-1-->')
  })

  it('registers a structured kind flagged non-native', () => {
    registerBlockKind({ kind: 'code', native: false })
    expect(getBlockKind('code').native).toBe(false)
  })

  it('returns null for an unknown kind', () => {
    expect(getBlockKind('does-not-exist')).toBeNull()
  })

  it('lists every registered kind', () => {
    registerBlockKind({ kind: 'prose', native: true })
    registerBlockKind({ kind: 'code', native: false })
    const kinds = listBlockKinds()
    expect(kinds).toContain('prose')
    expect(kinds).toContain('code')
  })

  it('discriminates native prose nodes from structured sieve-<kind> nodes by name', () => {
    expect(isNativeProseNodeName('paragraph')).toBe(true)
    expect(isNativeProseNodeName('bulletList')).toBe(true)
    expect(isNativeProseNodeName('sieve-code')).toBe(false)
    expect(isNativeProseNodeName('sieve-ai-block')).toBe(false)
  })
})
