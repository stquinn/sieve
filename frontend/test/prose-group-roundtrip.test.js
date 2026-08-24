// prose-group-roundtrip.test.js — real-editor round-trip: prove the proseGroup
// container renders correctly via proseBlockNodes AND serializes transparently
// through the live tiptap-markdown MarkdownSerializer stack.
//
// Approach: full Editor (element: null, no DOM mount) with StarterKit + Markdown +
// a real ProseGroup Node that uses the real proseGroupMarkdownSerialize. This
// exercises the actual MarkdownSerializerState.renderContent path, confirming
// state.renderContent exists in the real serializer (not just a fake stub) and
// that the transparent serialize produces no <!--s:--> markers and no wrapper.
//
// The node is constructed by hand in the test (Node.create) rather than relying
// on the shared vendor bag, so this runs in vitest without any T.Node guard issues.

import { describe, it, expect, afterEach } from 'vitest'
import { Editor, Node } from '@tiptap/core'
import { StarterKit } from '@tiptap/starter-kit'
import { Markdown } from 'tiptap-markdown'
import { Fragment } from '@tiptap/pm/model'
import { proseBlockNodes, proseGroupMarkdownSerialize } from '../src/static/lens/document-editor/surfaces/prose-group.js'

// A ProseGroup node extension whose markdown.serialize uses the REAL
// proseGroupMarkdownSerialize (imported from the source module being tested).
const ProseGroupNode = Node.create({
  name: 'proseGroup',
  group: 'block',
  content: 'block+',
  addAttributes() {
    return {
      id: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-id') || '',
        renderHTML: () => ({}),
      },
    }
  },
  parseHTML() { return [{ tag: 'div.prose-group' }] },
  renderHTML({ node }) {
    const attrs = { class: 'block-node prose-group' }
    if (node.attrs.id) attrs['data-id'] = node.attrs.id
    return ['div', attrs, 0]
  },
  // Registers the real serialize fn so tiptap-markdown picks it up via
  // extension.storage.markdown.serialize (the getMarkdownSpec path).
  addStorage() {
    return { markdown: { serialize: proseGroupMarkdownSerialize } }
  },
})

// Shared editor instance: element: null prevents DOM mount while still
// running onBeforeCreate (which wires editor.storage.markdown).
let editor

function makeEditor() {
  editor = new Editor({
    element: null,
    extensions: [StarterKit, Markdown, ProseGroupNode],
    content: '',
  })
}

afterEach(() => {
  if (editor && !editor.isDestroyed) editor.destroy()
  editor = null
})

describe('proseBlockNodes — multi-node → single proseGroup container', () => {
  it('wraps heading + two paragraphs in ONE proseGroup with the given id', () => {
    makeEditor()
    const { schema } = editor

    const heading = schema.nodes.heading.create({ level: 2 }, schema.text('AI Answer'))
    const p1 = schema.nodes.paragraph.create({}, schema.text('First paragraph.'))
    const p2 = schema.nodes.paragraph.create({}, schema.text('Second paragraph.'))
    const fragment = Fragment.fromArray([heading, p1, p2])

    const nodes = proseBlockNodes(fragment, 'ai-x', schema)

    expect(nodes).toHaveLength(1)
    expect(nodes[0].type.name).toBe('proseGroup')
    expect(nodes[0].attrs.id).toBe('ai-x')
    expect(nodes[0].childCount).toBe(3)
  })
})

describe('proseGroup transparent markdown serialize (real tiptap-markdown stack)', () => {
  // Verifies state.renderContent exists in the real MarkdownSerializerState (not
  // just a fake stub) and that proseGroupMarkdownSerialize produces wrapper-free
  // markdown for a heading + two paragraphs block.
  it('serializes children as plain markdown — no <!--s: markers, no prose-group wrapper', () => {
    makeEditor()
    const { schema } = editor

    const heading = schema.nodes.heading.create({ level: 2 }, schema.text('AI Answer'))
    const p1 = schema.nodes.paragraph.create({}, schema.text('First paragraph.'))
    const p2 = schema.nodes.paragraph.create({}, schema.text('Second paragraph.'))
    const [groupNode] = proseBlockNodes(Fragment.fromArray([heading, p1, p2]), 'ai-d63e', schema)

    const serialized = editor.storage.markdown.serializer.serialize(groupNode)

    // Transparent: the heading + paragraphs appear as native markdown.
    expect(serialized).toContain('AI Answer')
    expect(serialized).toContain('First paragraph.')
    expect(serialized).toContain('Second paragraph.')
    // No HTML wrapper, no sieve comment markers.
    expect(serialized).not.toContain('prose-group')
    expect(serialized).not.toContain('<div')
    expect(serialized).not.toContain('<!--s:')
    expect(serialized).not.toContain('<!--/s:')
  })

  it('serialized output has the correct heading markdown level', () => {
    makeEditor()
    const { schema } = editor

    const h1 = schema.nodes.heading.create({ level: 1 }, schema.text('Title'))
    const body = schema.nodes.paragraph.create({}, schema.text('Body text.'))
    const [groupNode] = proseBlockNodes(Fragment.fromArray([h1, body]), 'ai-z', schema)

    const serialized = editor.storage.markdown.serializer.serialize(groupNode)

    expect(serialized).toMatch(/^# Title/m)
    expect(serialized).toContain('Body text.')
  })
})
