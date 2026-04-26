// Entry point for the pre-built TipTap bundle (ui/static/vendor/tiptap.js).
// Run: npm run bundle:tiptap
// Custom extensions have moved to ui/static/extensions.js (plain vanilla JS).
// This file exposes TipTap core + third-party deps + base APIs needed by extensions.js.

export { Editor, Node, Extension, mergeAttributes } from '@tiptap/core'
export { DOMParser as ProseMirrorDOMParser, NodeRange } from '@tiptap/pm/model'
export { Plugin, PluginKey } from '@tiptap/pm/state'
export { Decoration, DecorationSet } from '@tiptap/pm/view'
export { default as StarterKit } from '@tiptap/starter-kit'
export { default as Link } from '@tiptap/extension-link'
export { default as Placeholder } from '@tiptap/extension-placeholder'
export { Markdown } from 'tiptap-markdown'
export { default as TaskList } from '@tiptap/extension-task-list'
export { default as TaskItem } from '@tiptap/extension-task-item'
export { common, createLowlight } from 'lowlight'
export { default as Table } from '@tiptap/extension-table'
export { default as TableRow } from '@tiptap/extension-table-row'
export { default as TableHeader } from '@tiptap/extension-table-header'
export { default as TableCell } from '@tiptap/extension-table-cell'
export { default as CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight'
export { default as Image } from '@tiptap/extension-image'
