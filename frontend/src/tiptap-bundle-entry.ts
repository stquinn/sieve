// Entry point for the pre-built TipTap bundle (ui/static/vendor/tiptap.js).
// Run: npm run bundle:tiptap
// This file has zero React dependencies — esbuild strips all TS types.

export { Editor } from '@tiptap/core'
export { DOMParser as ProseMirrorDOMParser } from '@tiptap/pm/model'
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
export { CodeBlockWithAttrs } from './extensions/CodeBlockWithAttrs'
export { ImageWithAttrs } from './extensions/ImageWithAttrs'
export { AiBlock, AiQuestion } from './extensions/AiBlock'
export { AiShortcuts } from './extensions/AiShortcuts'
export { BlockNode } from './extensions/BlockNode'
export { Search } from './extensions/Search'
export { buildAiContext } from './lib/aiContextBuilder'
