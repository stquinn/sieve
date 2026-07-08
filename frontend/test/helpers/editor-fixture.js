import { Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection, NodeSelection } from '@tiptap/pm/state'

// Minimal schema mirroring the node-granular model (D-r.7): every top-level node
// — native prose (paragraph/heading/blockquote/list/table/codeBlock/image/hr) AND
// structured sieve-* — carries an `id` attribute (unified identity). resolveAiTarget
// keys off node NAME (flowing-text vs unit) + that id, so the schema only needs the
// right names, groups, and an `id` attr per top-level node type.
export const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block', content: 'inline*', attrs: { id: { default: '' } },
      toDOM: (nd) => ['p', { 'data-id': nd.attrs.id }, 0], parseDOM: [{ tag: 'p' }],
    },
    heading: {
      group: 'block', content: 'inline*', attrs: { id: { default: '' } },
      toDOM: (nd) => ['h1', { 'data-id': nd.attrs.id }, 0],
    },
    blockquote: {
      group: 'block', content: 'block+', attrs: { id: { default: '' } },
      toDOM: (nd) => ['blockquote', { 'data-id': nd.attrs.id }, 0],
    },
    bulletList: {
      group: 'block', content: 'listItem+', attrs: { id: { default: '' } },
      toDOM: (nd) => ['ul', { 'data-id': nd.attrs.id }, 0],
    },
    listItem: { content: 'paragraph+', toDOM: () => ['li', 0] },
    table: {
      group: 'block', content: 'paragraph+', attrs: { id: { default: '' } },
      toDOM: (nd) => ['table', { 'data-id': nd.attrs.id }, ['tbody', 0]],
    },
    codeBlock: {
      group: 'block', content: 'text*', code: true, attrs: { id: { default: '' } },
      toDOM: (nd) => ['pre', { 'data-id': nd.attrs.id }, ['code', 0]],
    },
    image: {
      group: 'block', atom: true, selectable: true,
      attrs: { id: { default: '' }, src: { default: '' } },
      toDOM: (nd) => ['img', { 'data-id': nd.attrs.id, src: nd.attrs.src }],
    },
    horizontalRule: {
      group: 'block', atom: true, selectable: true, attrs: { id: { default: '' } },
      toDOM: (nd) => ['hr', { 'data-id': nd.attrs.id }],
    },
    // The invisible multi-paragraph wrapper (one backend prose block rendered
    // under a shared id) — mirrors prose-group.js. Flowing text for AI targeting.
    proseGroup: {
      group: 'block', content: 'block+', attrs: { id: { default: '' } },
      toDOM: (nd) => ['div', { 'data-id': nd.attrs.id, class: 'block-node prose-group' }, 0],
    },
    text: { group: 'inline' },
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
    toDOM: (nd) => ['div', { 'data-id': nd.attrs.id, 'data-type': 'sieve-' + nd.attrs.kind }],
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

// Build a doc and place a collapsed caret at the nearest valid text position to
// `absPos` — robust for nested top-level nodes (lists, blockquotes, tables) where
// the inner text position is awkward to compute by hand.
export function docWithCaretNear(nodes, absPos) {
  const doc = n.doc.create(null, nodes)
  let state = EditorState.create({ schema, doc })
  state = state.apply(state.tr.setSelection(TextSelection.near(state.doc.resolve(absPos), 1)))
  return { editor: { state }, state, schema }
}

// Build a doc with a collapsed caret at an exact absolute doc position.
export function docWithCaretAt(nodes, pos) {
  const doc = n.doc.create(null, nodes)
  let state = EditorState.create({ schema, doc })
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)))
  return { editor: { state }, state, schema }
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

// Convenience node builders for tests. Native nodes accept an optional id so a
// test can address the block it expects to resolve.
export const build = {
  p: (text, id) => n.paragraph.create(id ? { id } : null, text ? t(text) : null),
  heading: (text, id) => n.heading.create(id ? { id } : null, text ? t(text) : null),
  code: (text, id) => n.codeBlock.create(id ? { id } : null, text ? t(text) : null),
  blockquote: (id, inner) => n.blockquote.create(id ? { id } : null, inner || [n.paragraph.create(null, t('quote'))]),
  bulletList: (id, items) => n.bulletList.create(id ? { id } : null,
    (items || ['item']).map((s) => n.listItem.create(null, n.paragraph.create(null, t(s))))),
  table: (id, text) => n.table.create(id ? { id } : null, n.paragraph.create(null, t(text || 'cell'))),
  image: (id) => n.image.create({ id: id || '', src: 'x.png' }),
  hr: (id) => n.horizontalRule.create(id ? { id } : null),
  sieveCode: (id) => n['sieve-code'].create({ id, kind: 'code', serialisedForm: '' }),
  proseGroup: (id, texts) => n.proseGroup.create(id ? { id } : null,
    (texts || ['one', 'two']).map((s) => n.paragraph.create(null, t(s)))),
  aiBlock: (id, ref) => n['sieve-ai-block'].create({ id, kind: 'ai-block', serialisedForm: '', ref: ref || '' }),
}
