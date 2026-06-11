import { Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection, NodeSelection } from '@tiptap/pm/state'

// Minimal schema: enough node NAMES for resolveAiTarget's type checks.
// sieve-* atoms carry id/kind/serialisedForm like real Sieve blocks.
export const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0], parseDOM: [{ tag: 'p' }] },
    text: { group: 'inline' },
    codeBlock: { group: 'block', content: 'text*', code: true, toDOM: () => ['pre', ['code', 0]] },
    table: { group: 'block', content: 'paragraph+', toDOM: () => ['table', ['tbody', 0]] },
    // blockRef = anchor: wraps a block, carries an id
    blockRef: {
      group: 'block', content: 'block+',
      attrs: { id: { default: '' } },
      toDOM: (n) => ['div', { 'data-id': n.attrs.id, class: 'block-ref' }, 0],
    },
    // a generic sieve atom (e.g. sieve-code), and the ai-block follow-up atom
    'sieve-code': sieveAtom('code'),
    'sieve-ai-block': sieveAtom('ai-block'),
  },
  marks: {
    highlight: { toDOM: () => ['mark', 0], parseDOM: [{ tag: 'mark' }] },
  },
})

function sieveAtom(kind) {
  return {
    group: 'block', atom: true, selectable: true,
    attrs: { id: { default: '' }, kind: { default: kind }, serialisedForm: { default: '' }, ref: { default: '' } },
    toDOM: (n) => ['div', { 'data-id': n.attrs.id, 'data-type': 'sieve-' + n.attrs.kind }],
  }
}

const n = schema.nodes
const t = (s) => schema.text(s)

// Build a doc + place a TextSelection inside the block at `blockIndex`
// at character offset `charOffset` (collapsed caret). Returns { editor }.
export function docWithCaret(nodes, blockIndex, charOffset) {
  const doc = n.doc.create(null, nodes)
  let state = EditorState.create({ schema, doc })
  // position of blockIndex's content start:
  let pos = 1 // after doc open
  for (let i = 0; i < blockIndex; i++) pos += nodes[i].nodeSize
  const sel = TextSelection.create(state.doc, pos + 1 + (charOffset || 0))
  state = state.apply(state.tr.setSelection(sel))
  return { editor: { state }, schema }
}

// Build a doc with a TextSelection spanning [from,to] (absolute doc positions).
export function docWithRange(nodes, from, to) {
  const doc = n.doc.create(null, nodes)
  let state = EditorState.create({ schema, doc })
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)))
  return { editor: { state }, schema }
}

// Build a doc with a NodeSelection on the block at `blockIndex`.
export function docWithNodeSelection(nodes, blockIndex) {
  const doc = n.doc.create(null, nodes)
  let state = EditorState.create({ schema, doc })
  let pos = 1
  for (let i = 0; i < blockIndex; i++) pos += nodes[i].nodeSize
  state = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, pos - 1)))
  return { editor: { state }, schema }
}

// Convenience node builders for tests
export const build = {
  p: (text) => n.paragraph.create(null, text ? t(text) : null),
  code: (text) => n.codeBlock.create(null, text ? t(text) : null),
  sieveCode: (id) => n['sieve-code'].create({ id, kind: 'code', serialisedForm: '' }),
  aiBlock: (id, ref) => n['sieve-ai-block'].create({ id, kind: 'ai-block', serialisedForm: '', ref: ref || '' }),
  anchor: (id, inner) => n.blockRef.create({ id }, inner),
}
