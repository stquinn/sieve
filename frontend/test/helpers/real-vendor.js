// @ts-check
// real-vendor.js — seeds globalThis.TipTap with the REAL TipTap/ProseMirror
// members, for a test that MOUNTS a vendor-global module (block-chrome.js,
// extensions.js) in a live editor rather than merely importing it.
//
// seed-vendor.js is its permissive sibling: proxies that survive module-eval but
// build nothing. Import this FIRST, ahead of the module under test, so its
// top-level `Extension.create` runs against the real class. Additive, and never
// reassigns the bag — tiptap-vendor.js captured that object.
import { Extension, Node, Mark } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

Object.assign(/** @type {any} */ (globalThis).TipTap, {
  Extension, Node, Mark, Plugin, PluginKey, Decoration, DecorationSet,
})

export {}
