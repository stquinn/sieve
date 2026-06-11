// block-chrome.js — BlockChrome TipTap extension.
// Adds a ProseMirror plugin that renders gutter chrome (drag handle + rail)
// as widget decorations on every top-level block node.
// Depends on window.TipTap (vendor/tiptap.js) loaded first.
;(function () {
  'use strict'

  var T = window.TipTap
  var Extension = T.Extension
  var Plugin = T.Plugin
  var PluginKey = T.PluginKey
  var Decoration = T.Decoration
  var DecorationSet = T.DecorationSet

  var blockChromeKey = new PluginKey('blockChrome')

  function buildDecorations(doc) {
    var decos = []
    doc.forEach(function (node, offset) {
      var pos = offset           // position just before this top-level node
      decos.push(Decoration.widget(pos + 1, function () {
        var wrap = document.createElement('div')
        wrap.className = 'block-chrome'
        wrap.setAttribute('contenteditable', 'false')
        var handle = document.createElement('span')
        handle.className = 'block-chrome-handle'
        handle.setAttribute('draggable', 'true')
        handle.textContent = '⠷'         // ⠷ braille drag dots
        var rail = document.createElement('span')
        rail.className = 'block-chrome-rail'
        wrap.appendChild(handle)
        wrap.appendChild(rail)
        return wrap
      }, { side: -1, key: 'chrome-' + pos }))
    })
    return DecorationSet.create(doc, decos)
  }

  var BlockChrome = Extension.create({
    name: 'blockChrome',
    addProseMirrorPlugins: function () {
      return [
        new Plugin({
          key: blockChromeKey,
          props: {
            decorations: function (state) {
              return buildDecorations(state.doc)
            },
          },
        }),
      ]
    },
  })

  T.BlockChrome = BlockChrome
})()
