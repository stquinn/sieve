// block-anchor-renderer.js — BlockAnchor: a transparent prose container.
//
// Stage D.1. A prose block in the BlockDoc model is rendered as a
// `sieve-block-anchor` node carrying the block's handle (id + aliases). It is a
// TRANSPARENT container: it is NOT an atom and exposes a real `contentDOM`, so
// ProseMirror owns the prose inside it (selection, caret, marks all traverse
// normally) and typing edits the prose WITHOUT ever recreating the node.
//
// Identity (the id) is assigned at LOAD/structure time only — never patched on
// every transaction. That deliberate constraint is what avoids the reverted
// attempt's "new line per keystroke" defect.
//
// Registered as kind "block-anchor" → node name "sieve-block-anchor" (see
// getSieveNodeNameFromKind), parsed from `div[data-type="sieve-block-anchor"]`.

(function () {
  'use strict'

  var T = window.TipTap

  var BlockAnchorRenderer = {
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

    // Transparent markdown serialiser. A block-anchor is NOT a fence — it owns
    // real prose children, so getMarkdown() must emit that prose, not a
    // serialisedForm. We re-prepend the handle marker(s) above the content so
    // the identity survives a doc-update round-trip, byte-for-byte matching Go's
    // SerializeBlockDocWithHandles (`<!--s:ID-->` own-line markers, id then
    // aliases). renderContent serialises the children through PM's own markdown
    // serialiser — no hand-built markdown.
    markdownSerialize: function (state, node) {
      var marks = ''
      if (node.attrs.id) marks += '<!--s:' + node.attrs.id + '-->\n'
      if (node.attrs.aliases && node.attrs.aliases.length) {
        node.attrs.aliases.forEach(function (a) { marks += '<!--s:' + a + '-->\n' })
      }
      if (marks) {
        state.ensureNewLine()
        state.write(marks)
      }
      state.renderContent(node)
    },

    makeNodeView: function (node, editor, getPos) {
      var dom = document.createElement('div')
      dom.className = 'block-anchor'
      dom.setAttribute('data-type', 'sieve-block-anchor')
      dom.setAttribute('data-kind', 'prose')
      dom.setAttribute('data-id', node.attrs.id || '')

      var contentDOM = document.createElement('div')
      contentDOM.className = 'block-anchor__content'
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
      }
    },
  }

  T.registerSieveRenderer('block-anchor', BlockAnchorRenderer)
})()
