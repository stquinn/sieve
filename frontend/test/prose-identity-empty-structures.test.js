// @ts-check
// Identity for EMPTY prose structures, against a REAL editor with the shipped
// BlockId extension. Only an empty PARAGRAPH is the trailing surface the mint
// pass leaves bare; a fresh blockquote, table or horizontalRule has no text and
// is still deliberate structure — id-less it cannot be reconciled by identity,
// and the container's untracked top-level rebuild then throws the caret out of
// it (the `{quote` macro left the user typing BELOW their new quote).
import { describe, it, expect, afterEach } from 'vitest'
import { Editor, Extension } from '@tiptap/core'
import { StarterKit } from '@tiptap/starter-kit'
import { Plugin, PluginKey } from '@tiptap/pm/state'

// prose-block.js builds its extensions off the shared vendor bag at import time.
// Seed the REAL classes (mutate, never reassign — tiptap-vendor.js already
// captured a reference), then import once to get the shipped BlockId.
Object.assign(/** @type {any} */ (globalThis).TipTap, { Extension, Plugin, PluginKey })
const { BlockId } = await import('../src/static/lens/document-editor/surfaces/prose-block.js')

/** @type {any} */ let editor = null

afterEach(() => {
  if (editor) { editor.destroy(); editor = null }
  document.body.innerHTML = ''
})

function makeEditor() {
  const element = document.createElement('div')
  document.body.appendChild(element)
  editor = new Editor({
    element,
    extensions: [StarterKit.configure({ trailingNode: true }), BlockId],
    content: { type: 'doc', content: [{ type: 'paragraph', content: [] }] },
  })
  return editor
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('the mint pass and empty prose structures', () => {
  it('an EMPTY blockquote at the end of the doc is minted an id, and the caret stays inside it', () => {
    makeEditor()
    editor.chain().focus().toggleBlockquote().run()

    const bq = editor.state.doc.content.child(0)
    expect(bq.type.name).toBe('blockquote')
    expect(bq.attrs.id).toMatch(UUID)

    const $from = editor.state.selection.$from
    const ancestry = []
    for (let d = $from.depth; d > 0; d--) ancestry.push($from.node(d).type.name)
    expect(ancestry).toContain('blockquote')
  })

  it('a horizontalRule — textless by nature — is minted an id', () => {
    makeEditor()
    editor.chain().focus().setHorizontalRule().run()
    const types = []
    editor.state.doc.forEach((n) => types.push(n.type.name))
    const hrIndex = types.indexOf('horizontalRule')
    expect(hrIndex).toBeGreaterThanOrEqual(0)
    expect(editor.state.doc.content.child(hrIndex).attrs.id).toMatch(UUID)
  })

  it('the TRAILING empty paragraph stays bare — it is surface, not a block', () => {
    makeEditor()
    editor.chain().focus().toggleBlockquote().run()
    const last = editor.state.doc.content.child(editor.state.doc.content.childCount - 1)
    expect(last.type.name).toBe('paragraph')
    expect(last.attrs.id).toBe('')
  })

  it('wrapping an identified paragraph STRIPS its id — nested prose carries none', () => {
    makeEditor()
    editor.chain().focus().insertContent('quoted words').run()
    const paraId = editor.state.doc.content.child(0).attrs.id
    expect(paraId).toMatch(UUID)

    editor.chain().focus().toggleBlockquote().run()

    const bq = editor.state.doc.content.child(0)
    expect(bq.type.name).toBe('blockquote')
    expect(bq.attrs.id).toMatch(UUID)
    expect(bq.attrs.id).not.toBe(paraId)
    // The nested paragraph no longer answers to its old top-level id: a remove
    // cue for that retired block must find nothing.
    let nestedIds = []
    bq.descendants((n) => { if (n.attrs && n.attrs.id) nestedIds.push(n.attrs.id) })
    expect(nestedIds).toEqual([])
  })

  it('an empty paragraph ABOVE content is a structural blank and keeps a minted id', () => {
    makeEditor()
    editor.commands.setContent({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [] },
        { type: 'paragraph', content: [{ type: 'text', text: 'below' }] },
      ],
    })
    // setContent is a docChanged transaction; the append pass runs on it.
    const first = editor.state.doc.content.child(0)
    expect(first.type.name).toBe('paragraph')
    expect(first.attrs.id).toMatch(UUID)
  })
})
