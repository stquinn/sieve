import { describe, it, expect } from 'vitest'
import { schema } from './helpers/editor-fixture.js'
import { reloadReplacement } from '../src/static/editor/surfaces/render-empty.js'

describe('reloadReplacement — empty-reload decision', () => {
  it('clears to one empty paragraph when allowEmpty and blocks are empty', () => {
    const replacement = reloadReplacement([], { allowEmpty: true }, schema)
    expect(replacement).toHaveLength(1)
    expect(replacement[0].type.name).toBe('paragraph')
    expect(replacement[0].childCount).toBe(0)
  })

  it('keeps existing content when blocks are empty without allowEmpty', () => {
    const kept = reloadReplacement([], { allowEmpty: false }, schema)
    expect(kept).toBeNull()
  })

  it('keeps existing content when allowEmpty is absent', () => {
    const kept = reloadReplacement([], {}, schema)
    expect(kept).toBeNull()
  })

  it('passes through the node array unchanged when nodes are non-empty', () => {
    const node = schema.nodes.paragraph.create(null, schema.text('hi'))
    const replacement = reloadReplacement([node], {}, schema)
    expect(replacement).toHaveLength(1)
    expect(replacement[0].type.name).toBe('paragraph')
    expect(replacement[0]).toBe(node)
  })
})
