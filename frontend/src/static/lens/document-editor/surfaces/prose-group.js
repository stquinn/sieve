// prose-group.js — the multi-node prose CONTAINER (the embed render, 2026-06-21).
//
// A backend `kind:prose` block whose content is MULTI-NODE (an embedded AI answer
// or Web Clip: heading + paragraphs) must render as ONE editable block with ONE
// id — not N native nodes (which the mint observer would split into N blocks: the
// embed-fragmentation bug, tech-debt E-1). This node is that container.
//
// It is the PROSE kind's multi-node rendering — NOT a new kind and NOT a sieve-*
// NodeView. Because its node name is `proseGroup` (not `sieve-*`),
// isNativeProseNodeName(name) === true, so every prose path already handles it as
// ONE native prose block, with no bridge:
//   - save:     topBlockTriple serializes it via serializeNode (raw markdown, no
//               markers); the block-sync observer emits a granular block-op with
//               attrs.content. Go wraps in <!--s:id--> markers on its side.
//   - chain:    proseChainHits matches it (top-level, native-named, id) so the AI
//               ref-chain decoration lands on its root.
//   - identity: the mint observer counts it as one top-level prose node; it carries
//               the loaded id, so nothing is minted. Its CHILDREN are not top-level,
//               so they are never minted or treated as blocks.
//
// Created ONLY by code (proseBlockNodes, from renderBlocksIntoEditor at load when a
// prose block parses to >1 top-level node). The editor/keyboard never creates one.
//
// Editability is the proven native `block+` mechanism (the early single-container
// "bag"). The bag failed only because it was the DOC top node — trapping the doc in
// one block with no sibling. This container is the inverse: ONE selective sibling
// among first-class native blocks.
//
// Markdown serialize is TRANSPARENT: emit ONLY the children's markdown, no markers.
// Go re-wraps in <!--s:id--> on save — serialization stays a backend concern.
//
// Depends on the vendor TipTap bundle (vendor/tiptap.js) for Node — guarded so this
// module is importable in a bare (vitest) env where TipTap is absent; the pure
// exports (proseBlockNodes, proseGroupMarkdownSerialize) are always available.

import { T } from './tiptap-vendor.js'

// Cross-file binding the guarded block below assigns when the TipTap runtime is
// present (the sieve-block-extension `export let` pattern, P4.E): stays undefined
// in a bare (vitest) env.
export let ProseGroup

// proseGroupMarkdownSerialize: TRANSPARENT serialize — render ONLY the children, no
// wrapper, no markers. state.renderContent walks the child blocks and lets each
// serialize itself with proper block separation (the prosemirror-markdown contract,
// the same call blockquote's serializer uses).
export function proseGroupMarkdownSerialize(state, node) {
  state.renderContent(node)
}

// proseBlockNodes maps a prose block's PARSED content (a Fragment of native
// top-level nodes, as produced by the editor's own DOMParser) to the node(s) the
// document should hold:
//   - 0 children  → []        (caller logs an empty-block error)
//   - 1 child     → [that node, with the block id stamped]   (the native path)
//   - >1 children → [ONE proseGroup carrying the id, wrapping all N]  (the fix)
// The renderer's OWN parse count decides: a typed prose block is always exactly one
// top-level node; only an actor-created embed is multi-node. So childCount > 1 ⟺ a
// container — no flag, no content inspection.
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
        // The id round-trips through data-id. The attribute's renderHTML returns {}
        // so the node renderHTML below is the SOLE emitter of data-id (no conflict /
        // no dependency on mergeAttributes); parseHTML reads it back on re-parse.
        //
        // It is declared HERE rather than inheriting the global one, because a
        // proseGroup is a node type in its own right — and it has to be declared,
        // because a SPLIT copies attrs and the identity plugin re-mints the
        // duplicate through setNodeMarkup. An undeclared attr is dropped silently,
        // which would leave the split half nameless and lose everything after it
        // from the container (the multi-node-block data-loss bug).
        id: {
          default: '',
          parseHTML(el) { return el.getAttribute('data-id') || '' },
          renderHTML() { return {} },
        },
      }
    },
    parseHTML() { return [{ tag: 'div.prose-group' }] },
    // Root carries `block-node` + data-id so it gets the SAME block styling and AI
    // ref-chain accent as every other block (CSS targets .block-node[data-id]). `0`
    // is the content hole → children render and edit natively (no NodeView).
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
