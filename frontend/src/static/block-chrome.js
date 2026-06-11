// block-chrome.js — BlockChrome TipTap extension.
// Adds a ProseMirror plugin that will manage per-block decoration chrome.
// Currently a no-op skeleton — later tasks will add decoration logic.
// Depends on window.TipTap (vendor/tiptap.js) loaded first.
;(function () {
  'use strict'

  var T = window.TipTap
  var Extension = T.Extension
  var Plugin = T.Plugin
  var PluginKey = T.PluginKey

  var blockChromeKey = new PluginKey('blockChrome')

  var BlockChrome = Extension.create({
    name: 'blockChrome',
    addProseMirrorPlugins: function () {
      return [
        new Plugin({
          key: blockChromeKey,
          view: function () {
            return { update: function () {} }
          },
        }),
      ]
    },
  })

  T.BlockChrome = BlockChrome
})()
