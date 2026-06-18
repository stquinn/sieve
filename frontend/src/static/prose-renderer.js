// prose-renderer.js — the prose Block: a transparent, kind-homogeneous leaf.
//
// A prose block in the BlockDoc model is rendered as a `sieve-prose` node
// carrying the block's handle (id + aliases). It is a TRANSPARENT container: it
// is NOT an atom and exposes a real `contentDOM`, so ProseMirror owns the prose
// inside it (selection, caret, marks all traverse normally) and typing edits the
// prose WITHOUT ever recreating the node. Its paragraphs are its *content*, not
// child blocks — a prose Block is a kind-homogeneous leaf (Kind = prose).
//
// Identity (the id) is assigned at LOAD/structure time only — never patched on
// every transaction. That deliberate constraint is what avoids the reverted
// attempt's "new line per keystroke" defect.
//
// Registered as kind "prose" → node name "sieve-prose" (see createSieveNode's
// 'sieve-' + kind rule), parsed from `div[data-type="sieve-prose"]`.

(function () {
  'use strict'

  var T = window.TipTap

  var ProseRenderer = {
    nodeConfig: {
      atom: false,        // transparent: prose children are real, editable PM content
      content: 'block+',  // paragraphs, headings, lists, …
      defining: true,
      group: 'block',
      selectable: true,
      draggable: false,
    },

    attrs: {
      // id/kind/serialisedForm/status/createdAt come from BASE_ATTRS; a prose
      // block additionally carries the handle aliases it has absorbed (spec §7).
      aliases: {
        default: [],
        parseHTML: function (el) {
          var raw = el.getAttribute('data-aliases')
          if (!raw) return []
          try { return JSON.parse(raw) } catch (e) { return [] }
        },
        renderHTML: function (attrs) {
          if (!attrs.aliases || attrs.aliases.length === 0) return {}
          return { 'data-aliases': JSON.stringify(attrs.aliases) }
        },
      },
    },

    parseAttrs: function (data) {
      return { aliases: data.aliases || [] }
    },

    // Transparent markdown serialiser. A prose block is NOT a fence — it owns
    // real prose children, so getMarkdown() must emit that prose, not a
    // serialisedForm. We re-prepend the handle marker(s) above the content so
    // the identity survives a doc-update round-trip, byte-for-byte matching Go's
    // SerializeBlockDocWithHandles (`<!--s:ID-->` own-line markers, id then
    // aliases). renderContent serialises the children through PM's own markdown
    // serialiser — no hand-built markdown.
    markdownSerialize: function (state, node) {
      var id = node.attrs.id
      // Handle-less prose (not yet minted) → bare content; Go mints on Open.
      if (!id) {
        state.renderContent(node)
        return
      }
      // PAIRED delimiters, byte-matching Go's serializeProseBlock: the open
      // marker carries the full handle-set (primary id + aliases, space-
      // separated), the close marker the primary id only. A lone open marker
      // would be unbalanced → Go treats it as literal text, so the close is
      // mandatory for the identity to survive a doc-update round-trip.
      var handles = [id].concat(node.attrs.aliases || [])
      state.ensureNewLine()
      state.write('<!--s:' + handles.join(' ') + '-->\n')
      state.renderContent(node)
      state.ensureNewLine()
      state.write('<!--/s:' + id + '-->')
      state.closeBlock(node)
    },

    makeNodeView: function (node, editor, getPos) {
      var dom = document.createElement('div')
      dom.className = 'prose'
      dom.setAttribute('data-type', 'sieve-prose')
      dom.setAttribute('data-kind', 'prose')
      dom.setAttribute('data-id', node.attrs.id || '')

      var contentDOM = document.createElement('div')
      contentDOM.className = 'prose__content'
      dom.appendChild(contentDOM)

      return {
        dom: dom,
        contentDOM: contentDOM,
        // Returning true for a same-type update lets PM reuse this NodeView and
        // its contentDOM across edits — the node is never torn down on typing.
        update: function (updatedNode) {
          if (updatedNode.type !== node.type) return false
          node = updatedNode
          dom.setAttribute('data-id', node.attrs.id || '')
          return true
        },

        // CRITICAL: the prose block is a content-bearing sieve node, so
        // isSieveNode() (serialisedForm-defined) routes it to block-chrome's
        // Strategy B, which injects + repopulates a `.block-chrome-host` inside
        // this editable node on every state change. Without ignoreMutation,
        // ProseMirror's MutationObserver sees those chrome writes, fails to
        // reconcile them, and recreates this NodeView in a tight loop (perpetual
        // redraw → 100% CPU, typing lag). Every other content-bearing sieve block
        // (code, ai-block, web-clip, log, diagram) carries this exact guard; the
        // prose block must too: let PM own mutations inside contentDOM, ignore
        // everything else (chrome).
        ignoreMutation: function (mutation) {
          return !contentDOM.contains(mutation.target)
        },
      }
    },
  }

  T.registerSieveRenderer('prose', ProseRenderer)
})()
