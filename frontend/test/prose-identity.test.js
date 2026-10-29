import { describe, it, expect } from 'vitest'

// D-r.7 piece 1 — identity unification. The prose identity attribute is unified
// from `blockId` to `id`, so EVERY block node (prose or structured sieve-*) is
// addressed by `attrs.id`. The change is confined to the PM node-attr layer: the
// DOM carrier stays `data-id` (a literal `id=` is intentionally NOT emitted to
// avoid duplicate-id collisions), and the on-disk markers carry the id VALUE, so
// the byte-stable round-trip is untouched.

// prose-block.js reads Extension/Plugin/PluginKey off the shared vendor bag
// (lens/surfaces/tiptap-vendor.js) at import time. Stub the minimum onto the shared bag
// test/setup.js seeded (mutate, never reassign — tiptap-vendor.js already
// captured a reference to it), then import once (modules are cached) to get the
// real ProseBlock / BlockId ES exports (the bus is retired).
Object.assign(globalThis.TipTap, {
  Extension: { create: (cfg) => cfg },
  Plugin: function (spec) { this.spec = spec },
  PluginKey: function (k) { this.k = k },
})
const { ProseBlock, BlockId } = await import('../src/static/lens/document-editor/surfaces/prose-block.js')

describe('prose identity unification (blockId → id)', () => {
  it('the prose kind declares its identity attr as `id`', () => {
    expect(ProseBlock.identityAttr).toBe('id')
  })

  it('the global attribute is keyed `id`, not `blockId`', () => {
    const attrs = BlockId.addGlobalAttributes()[0].attributes
    expect(Object.keys(attrs)).toContain('id')
    expect(Object.keys(attrs)).not.toContain('blockId')
  })

  it('renderHTML binds the id to data-id (never a literal id=) and tags the shared block-node class, omitting both when empty', () => {
    const def = BlockId.addGlobalAttributes()[0].attributes.id
    expect(def.renderHTML({ id: 'pr-1' })).toEqual({ 'data-id': 'pr-1', class: 'block-node' })
    expect(def.renderHTML({ id: '' })).toEqual({})
  })

  it('parseHTML reads the id from data-id', () => {
    const def = BlockId.addGlobalAttributes()[0].attributes.id
    const el = { getAttribute: (k) => (k === 'data-id' ? 'pr-9' : null) }
    expect(def.parseHTML(el)).toBe('pr-9')
  })

  it('declares ONE identity attr — there is no pending state to carry a second one', () => {
    // A block is born with its durable id (issue #96), so the transient handle
    // the old create round-trip needed has nothing left to name.
    expect(Object.keys(BlockId.addGlobalAttributes()[0].attributes)).toEqual(['id'])
  })

  it('renderHTML emits data-id and block-node together — a real block has both from birth', () => {
    const def = BlockId.addGlobalAttributes()[0].attributes.id
    expect(def.renderHTML({ id: 'pr-1' })).toEqual({ 'data-id': 'pr-1', class: 'block-node' })
    // The trailing editing surface is deliberately id-less: it is not a block yet.
    expect(def.renderHTML({ id: '' })).toEqual({})
  })
})

// Prose is a block like any other, so it answers the kind registry's icon lookup
// itself. Without its own getIcon it took the registry's generic fallback — the
// CODE icon — and any surface drawing a kind marker (the Ask footer's per-block
// chips, #82) called a paragraph a code block.
describe('the prose kind declares its own icon', () => {
  it('getSieveIcon("prose") is the prose glyph, not the code fallback', async () => {
    const { getSieveIcon } = await import('../src/static/renderers/block-kinds.js')
    window.SieveIcons = { code: '<svg id="code"/>', blockquote: '<svg id="prose"/>' }
    expect(ProseBlock.kind).toBe('prose')
    expect(getSieveIcon('prose')).toBe('<svg id="prose"/>')
  })
})

// A prose copy's clipboard views: `sieve/prose` keeps the markdown so the block
// round-trips, while `text/plain` is the text a reader sees. tiptap-markdown
// writes `>` as `&gt;`, which must never reach text/plain (#192).
describe('the prose kind\'s clipboard views', () => {
  it.each([
    ['a list item with an arrow', '<ul><li><p>go here -&gt; there</p></li></ul>', 'go here -> there'],
    ['a paragraph with angle brackets', '<p>a &lt;b&gt; c</p>', 'a <b> c'],
  ])('%s: text/plain is the plain text, sieve/prose the markdown', async (_label, html, plain) => {
    const { Editor } = await import('@tiptap/core')
    const { StarterKit } = await import('@tiptap/starter-kit')
    const { Markdown } = await import('tiptap-markdown')
    const editor = new Editor({ extensions: [StarterKit, Markdown.configure({ html: true })], content: html })
    const entries = ProseBlock.asContentEntry(editor.state.doc.firstChild, editor)
    const view = (mime) => entries.find((e) => e.mimeType === mime).content
    expect(view('text/plain')).toBe(plain)
    expect(JSON.parse(view('sieve/prose')).content).toBe(editor.storage.markdown.serializer.serialize(editor.state.doc).trim())
    editor.destroy()
  })
})

// Ids are minted, never copied: a paste strips every identity marker before the
// parse, so no pasted prose node can claim its source's id.
describe('a pasted prose node carries no copied id', () => {
  it.each([
    ['a paragraph', '<p data-id="p-1">a</p>'],
    ['a pm-slice heading and list', '<h2 data-pm-slice="1 1 []" data-id="h-1">t</h2><ul data-id="l-1"><li><p>x</p></li></ul>'],
    ['a page behind <meta charset>', '<meta charset="utf-8"><blockquote data-id="q-1"><p data-block-id="q-2">q</p></blockquote>'],
  ])('%s: the id parse rule reads nothing after the paste strip', async (_label, html) => {
    const { BlockIdentity } = await import('../src/static/renderers/block-identity.js')
    const parse = BlockId.addGlobalAttributes()[0].attributes.id.parseHTML
    const template = document.createElement('template')
    template.innerHTML = BlockIdentity.stripHTML(html)
    const els = Array.from(template.content.querySelectorAll('*'))
    expect(els.map((el) => parse(el))).toEqual(els.map(() => ''))
    expect(template.innerHTML).not.toMatch(/data-(block-)?id/)
  })
})

// A17: prose text is stored as itself. `<`, `>` and `&` are escaped only where
// the markdown parser would read html or a blockquote, a marker at any line
// start is escaped, and the stored markdown loads back to the same document.
describe('prose text\'s stored markdown', () => {
  it.each([
    ['A17 an arrow', '<p>go -&gt; stop</p>', 'go -> stop'],
    ['comparisons and an ampersand', '<p>1 &lt; 2 &amp; 3 &gt; 2</p>', '1 < 2 & 3 > 2'],
    ['a `<` that would open a tag', '<p>a &lt;b&gt; c</p>', 'a \\<b> c'],
    ['an `&` that would spell an entity', '<p>&amp;amp; stays</p>', '\\&amp; stays'],
    ['a `>` that begins the block', '<p>&gt; not a quote</p>', '\\> not a quote'],
    ['a `>` that begins a line after a hard break', '<p>first<br>&gt; not a quote</p>', 'first\\\n\\> not a quote'],
    ['list and heading markers after a hard break', '<p>a<br>1. one<br>+ two<br># three</p>', 'a\\\n1\\. one\\\n\\+ two\\\n\\# three'],
    ['E13 `__init__` and snake_case', '<p>def __init__(self, snake_case):</p>', 'def \\_\\_init\\_\\_(self, snake_case):'],
    ['E13 indentation kept as no-break spaces, at a line start too', '<p>\u00a0\u00a0first<br>\u00a0\u00a0\u00a0\u00a0second</p>', '&#160;&#160;first\\\n&#160;&#160;&#160;&#160;second'],
  ])('%s', async (_label, html, markdown) => {
    const { Editor, Node } = await import('@tiptap/core')
    const { StarterKit } = await import('@tiptap/starter-kit')
    const { Markdown } = await import('tiptap-markdown')
    globalThis.TipTap.Node = Node
    const { ProseText } = await import('../src/static/lens/document-editor/surfaces/prose-text.js')
    const editor = new Editor({
      extensions: [StarterKit.configure({ text: false }), ProseText.node(), Markdown.configure({ html: true })],
      content: html,
    })
    const before = JSON.stringify(editor.getJSON())
    const stored = editor.storage.markdown.getMarkdown()
    expect(stored).toBe(markdown)
    editor.commands.setContent(stored)
    expect(JSON.stringify(editor.getJSON())).toBe(before)
    editor.destroy()
  })
})
