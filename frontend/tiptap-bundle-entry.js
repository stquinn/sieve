// Entry point for the pre-built TipTap bundle (ui/static/vendor/tiptap.js).
// Run: npm run bundle:tiptap
// Custom extensions are in ui/static/extensions.js (plain vanilla JS).
// This file exposes TipTap core + third-party deps + base APIs needed by extensions.js.

export { Editor, Node, Extension, mergeAttributes } from '@tiptap/core'
export { DOMParser as ProseMirrorDOMParser, NodeRange } from '@tiptap/pm/model'
export { Plugin, PluginKey, Selection, TextSelection, NodeSelection } from '@tiptap/pm/state'
export { Decoration, DecorationSet } from '@tiptap/pm/view'
export { default as StarterKit } from '@tiptap/starter-kit'
export { default as Link } from '@tiptap/extension-link'
export { default as Placeholder } from '@tiptap/extension-placeholder'
export { Markdown } from 'tiptap-markdown'
export { default as TaskList } from '@tiptap/extension-task-list'
export { default as TaskItem } from '@tiptap/extension-task-item'
export { common, createLowlight } from 'lowlight'
// MarkdownIt — the raw markdown-it CLASS (not the tiptap-markdown wrapper
// above), exported so block/renderers/sanctioned-markdown.js can construct a
// DEDICATED html:false instance that is never the editor's own (html:true)
// one — see that module's header comment for why the distinction is load-
// bearing (DEFECT SEC-B, issue #48). markdown-it is already a transitive dep
// via tiptap-markdown; declared directly in package.json now that app code
// imports it by name.
export { default as MarkdownIt } from 'markdown-it'
export { Table } from '@tiptap/extension-table'
export { TableRow } from '@tiptap/extension-table-row'
export { TableHeader } from '@tiptap/extension-table-header'
export { TableCell } from '@tiptap/extension-table-cell'
export { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight'
export { Image } from '@tiptap/extension-image'
export { Highlight } from '@tiptap/extension-highlight'
export { default as markdownItMark } from 'markdown-it-mark'
