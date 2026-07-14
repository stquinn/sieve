import { describe, it, expect, beforeEach } from 'vitest'
import { registerBlockKind, getBlockKind, listBlockKinds, isNativeProseNodeName, getSieveIcon } from '../src/static/block/block-kinds.js'

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
    })
    expect(def).toBe(getBlockKind('prose'))
    expect(getBlockKind('prose').native).toBe(true)
    expect(getBlockKind('prose').identityAttr).toBe('blockId')
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

  // getSieveIcon moved here from sieve-block-extension.js (P4.E D-2): it only
  // needs the kind-registry lookup (getBlockBehaviour), which this module
  // already owns — no reason for the 1100-line extension file to be the home.
  it('getSieveIcon returns a registered kind\'s icon via its behaviour', () => {
    const icon = '<svg>code</svg>'
    registerBlockKind({ kind: 'code', native: false, renderer: { getIcon: () => icon } })
    expect(getSieveIcon('code')).toBe(icon)
  })

  it('getSieveIcon is falsy-safe for an unknown kind', () => {
    expect(getSieveIcon('does-not-exist')).toBeFalsy()
  })
})
