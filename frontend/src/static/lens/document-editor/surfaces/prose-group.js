// The multi-node prose CONTAINER.
//
// A backend `kind:prose` block whose content parses to MULTIPLE top-level nodes
// (an embedded AI answer or Web Clip: heading + paragraphs) must render as ONE
// editable block with ONE id, not N native nodes the identity pass would mint
// into N blocks. This node is that container.
//
// It is the prose kind's multi-node rendering, not a new kind and not a sieve-*
// NodeView: its node name `proseGroup` satisfies isNativeProseNodeName, so every
// prose path — save, ref-chain, identity — already handles it as one native prose
// block. Its CHILDREN are not top-level, so they are never treated as blocks.
//
// Created ONLY by code (proseBlockNodes at load); the editor and keyboard never
// make one. Markdown serialize is transparent: children only, no markers — Go
// re-wraps them.
//
// The TipTap Node definition is guarded, so this module still imports in a bare
// (vitest) env; the pure exports are always available.

import { T } from './tiptap-vendor.js'

export let ProseGroup

// TRANSPARENT serialize — the children only, no wrapper and no markers.
// state.renderContent lets each child serialize itself with proper block
// separation, the same call blockquote's serializer uses.
export function proseGroupMarkdownSerialize(state, node) {
  state.renderContent(node)
}

// Maps a prose block's PARSED content (a Fragment of native top-level nodes) to
// the node(s) the document should hold:
//   - 0 children  → []        (caller logs an empty-block error)
//   - 1 child     → [that node, with the block id stamped]
//   - >1 children → [ONE proseGroup carrying the id, wrapping all N]
// The parse count alone decides: typed prose is always one top-level node, so
// childCount > 1 ⟺ a container. No flag, no content inspection.
export function proseBlockNodes(fragment, id, schema) {
  if (!fragment || fragment.childCount === 0) return []
  if (fragment.childCount === 1) {
    const only = fragment.firstChild
    return [only.type.create(Object.assign({}, only.attrs, { id: id }), only.content, only.marks)]
  }
  return [schema.nodes.proseGroup.create({ id: id }, fragment)]
}

if (T.Node) {
  ProseGroup = T.Node.create({
    name: 'proseGroup',
    group: 'block',
    content: 'block+',
    addAttributes() {
      return {
        // The id round-trips through data-id, but the attribute's renderHTML
        // returns {} so the node renderHTML below is its SOLE emitter.
        //
        // It must be declared here rather than inheriting the global one: a SPLIT
        // copies attrs and the identity pass re-mints the duplicate through
        // setNodeMarkup, and an undeclared attr is dropped silently — which would
        // leave the split half nameless and lose the rest of the container.
        id: {
          default: '',
          parseHTML(el) { return el.getAttribute('data-id') || '' },
          renderHTML() { return {} },
        },
      }
    },
    parseHTML() { return [{ tag: 'div.prose-group' }] },
    // Root carries `block-node` + data-id for the same block styling and ref-chain
    // accent as any other block. `0` is the content hole — children render and edit
    // natively, with no NodeView.
    renderHTML(props) {
      const id = props.node.attrs.id
      const attrs = { class: 'block-node prose-group' }
      if (id) attrs['data-id'] = id
      return ['div', attrs, 0]
    },
    addStorage() {
      return { markdown: { serialize: proseGroupMarkdownSerialize } }
    },
  })
}
