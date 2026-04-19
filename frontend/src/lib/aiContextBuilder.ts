import { NodeRange } from '@tiptap/pm/model'
import type { Editor } from '@tiptap/core'
import { mdSrcToStoreRelPath } from './imageUtils'
import { splitFrontmatter, getCleanMarkdown } from './markdown'

export type AiContext = {
  content: string
  blockRef: string
  history: string
  contextLabel: string
  imagePaths: string[]
}

// Collect store-relative paths for all image nodes reachable from the given
// chain ref IDs. blockRef='doc' → scan whole document. Otherwise walk chain.
export function collectChainImagePaths(doc: any, refs: string[], tabPath: string): string[] {
  console.log('[stash:ai] collectChainImagePaths', { refs, tabPath })
  const paths: string[] = []
  const seen = new Set<string>()

  if (refs.length === 0 || refs.includes('doc')) {
    doc.descendants((node: any) => {
      if (node.type.name === 'image' && node.attrs?.src) {
        const p = mdSrcToStoreRelPath(node.attrs.src, tabPath)
        if (p && !seen.has(p)) { seen.add(p); paths.push(p) }
      }
    })
  } else {
    for (const refId of refs) {
      doc.descendants((node: any) => {
        if (node.attrs?.id === refId) {
          console.log('[stash:ai] matched block anchor', { refId, type: node.type.name, src: node.attrs?.src })

          if (node.type.name === 'image' && node.attrs?.src) {
            const p = mdSrcToStoreRelPath(node.attrs.src, tabPath)
            console.log('[stash:ai] anchor is image', { p })
            if (p && !seen.has(p)) { seen.add(p); paths.push(p) }
          }

          node.descendants?.((child: any) => {
            if (child.type.name === 'image' && child.attrs?.src) {
              const p = mdSrcToStoreRelPath(child.attrs.src, tabPath)
              console.log('[stash:ai] child is image', { p })
              if (p && !seen.has(p)) { seen.add(p); paths.push(p) }
            }
          })
          return false
        }
      })
    }
  }
  console.log('[stash:ai] collectChainImagePaths result', paths)
  return paths
}

// Build explain/ask context from current editor selection or cursor position.
// Returns content string, a blockRef id, conversation history (for threading),
// image paths for any images in the chain, and a human-readable label.
//
// Side effect: may dispatch a transaction to the editor to tag blocks with IDs.
export function buildAiContext(
  editor: Editor,
  isMarkdownMode: boolean,
  rawMd: string,
  tabPath: string
): AiContext {
  if (isMarkdownMode) {
    const ta = document.querySelector('.markdown-raw') as HTMLTextAreaElement
    const body = splitFrontmatter(rawMd).body
    const cleanBody = getCleanMarkdown(body)

    if (ta && ta.selectionStart !== ta.selectionEnd) {
      return {
        content: ta.value.substring(ta.selectionStart, ta.selectionEnd).trim(),
        blockRef: 'doc',
        history: '',
        contextLabel: 'Selection',
        imagePaths: [],
      }
    }

    return {
      content: cleanBody,
      blockRef: 'doc',
      history: '',
      contextLabel: 'Document',
      imagePaths: [],
    }
  }

  const { selection, doc } = editor.state
  const { from, to, empty } = selection
  const serializer = editor.storage.markdown.serializer

  // Threading: detect if cursor is inside or selecting an aiBlock node.
  let aiBlockRef = ''
  let aiBlockId = ''

  // 1. Check parent hierarchy (best for point selections)
  const $from = editor.state.selection.$from
  for (let d = $from.depth; d >= 0; d--) {
    const node = $from.node(d)
    if (node.type.name === 'aiBlock') {
      aiBlockId = node.attrs.id ?? ''
      aiBlockRef = node.attrs.ref ?? ''
      break
    }
  }

  // 2. Fall back to range scan (best for larger selections)
  if (!aiBlockId) {
    doc.nodesBetween(from, to, (node: any) => {
      if (node.type.name === 'aiBlock') {
        aiBlockId = node.attrs.id ?? ''
        aiBlockRef = node.attrs.ref ?? ''
        return false
      }
    })
  }

  if (aiBlockId) {
    const refs = aiBlockRef.split(',')
    const sourceRef = refs[0]
    let sourceContent = ''
    if (sourceRef && sourceRef !== 'doc') {
      doc.descendants((node: any) => {
        if (node.attrs?.id === sourceRef) { sourceContent = serializer.serialize(node); return false }
      })
    } else {
      sourceContent = getCleanMarkdown(editor.storage.markdown.getMarkdown())
    }

    const intermediateHistory: string[] = []
    const seenIds = new Set<string>()
    let turnCount = 1

    for (let i = 1; i < refs.length; i++) {
      const refId = (refs[i] || '').trim()
      if (!refId || seenIds.has(refId)) continue
      seenIds.add(refId)

      doc.descendants((node: any) => {
        if (node.attrs?.id === refId) {
          const md = serializer.serialize(node)
          intermediateHistory.push(`[Turn ${turnCount++}]\n${md}`)
          return false
        }
      })
    }

    let currentBlockText = ''
    doc.nodesBetween(from, to, (node: any) => {
      if (node.type.name === 'aiBlock' && node.attrs?.id === aiBlockId) {
        if (!seenIds.has(node.attrs.id)) {
          currentBlockText = serializer.serialize(node)
          seenIds.add(node.attrs.id)
        }
        return false
      }
    })

    if (!currentBlockText && !empty) {
      currentBlockText = doc.textBetween(from, to, '\n')
    }

    const historyTurns = [
      sourceContent ? `[Source Context]\n${sourceContent}` : '',
      ...intermediateHistory,
    ].filter(Boolean).join('\n\n---\n\n')

    const newRef = aiBlockRef ? `${aiBlockRef},${aiBlockId}` : aiBlockId
    const chainRefs = aiBlockRef ? aiBlockRef.split(',') : ['doc']

    return {
      content: currentBlockText || sourceContent,
      blockRef: newRef,
      history: historyTurns,
      contextLabel: 'Follow-up',
      imagePaths: collectChainImagePaths(doc, chainRefs, tabPath),
    }
  }

  // Default target detection: check if we are on/selecting an inherent block target (image, codeBlock)
  let targetNode: any = null
  let targetPos: number = -1
  const scanFrom = (from === to) ? Math.max(0, from - 1) : from
  const scanTo   = (from === to) ? Math.min(doc.content.size, to + 1) : to

  doc.nodesBetween(scanFrom, scanTo, (node: any, pos: number) => {
    if (!targetNode && (node.type.name === 'image' || node.type.name === 'codeBlock')) {
      targetNode = node
      targetPos = pos
      return false
    }
  })

  let selectedText = ''
  let blockRange: NodeRange | null = null
  let contextLabel = ''

  if (targetNode && from === targetPos && to === targetPos + targetNode.nodeSize) {
    selectedText = serializer.serialize(targetNode).trim()
    contextLabel = targetNode.type.name === 'image' ? 'Image' : 'Code Block'
  } else if (from !== to) {
    const slice = doc.slice(from, to)
    selectedText = serializer.serialize(slice.content).trim()
    blockRange = selection.$from.blockRange(selection.$to)
    contextLabel = 'Selection'
  } else if (targetNode) {
    selectedText = serializer.serialize(targetNode).trim()
    contextLabel = targetNode.type.name === 'image' ? 'Image' : 'Code Block'
  } else {
    selectedText = getCleanMarkdown(editor.storage.markdown.getMarkdown())
    contextLabel = 'Document'
  }

  let existingBlockId = ''
  if (targetNode && from >= targetPos && to <= targetPos + targetNode.nodeSize) {
    existingBlockId = targetNode.attrs.id
  } else if (blockRange) {
    doc.nodesBetween(blockRange.start, blockRange.end, (node: any) => {
      if (!existingBlockId && node.type.name === 'blockRef' && node.attrs.id) {
        existingBlockId = node.attrs.id
        return false
      }
    })
  }

  let blockRef = existingBlockId || 'blk-' + Math.random().toString(16).substring(2, 6)
  const tr = editor.state.tr

  if (!existingBlockId) {
    if (targetNode && from >= targetPos && to <= targetPos + targetNode.nodeSize) {
      tr.setNodeMarkup(targetPos, undefined, { ...targetNode.attrs, id: blockRef })
    } else if (blockRange) {
      // Wrap the top-level node at depth 1. NodeRange(..., 0) covers depth-1 children.
      const topRange = new NodeRange(blockRange.$from, blockRange.$to, 0)
      tr.wrap(topRange, [{ type: editor.state.schema.nodes.blockRef, attrs: { id: blockRef } }])
    }
  }

  let finalImagePaths: string[] = []
  if (from !== to || targetNode || blockRange) {
    const seen = new Set<string>()
    const scanRangeFrom = targetNode ? targetPos : (blockRange ? blockRange.start : from)
    const scanRangeTo   = targetNode ? targetPos + targetNode.nodeSize : (blockRange ? blockRange.end : to)

    doc.nodesBetween(scanRangeFrom, scanRangeTo, (node: any) => {
      if (node.type.name === 'image' && node.attrs?.src) {
        const p = mdSrcToStoreRelPath(node.attrs.src, tabPath)
        if (p && !seen.has(p)) { seen.add(p); finalImagePaths.push(p) }
      }
    })
  } else {
    finalImagePaths = collectChainImagePaths(tr.doc, [blockRef], tabPath)
  }

  if (tr.docChanged) {
    editor.view.dispatch(tr)
  }

  return {
    content: selectedText,
    blockRef: (from === to && !targetNode && !blockRange) ? 'doc' : blockRef,
    history: '',
    contextLabel,
    imagePaths: finalImagePaths,
  }
}
