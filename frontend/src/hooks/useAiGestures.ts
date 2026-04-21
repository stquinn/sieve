import React from 'react'
import { DOMParser as ProseMirrorDOMParser, Fragment } from '@tiptap/pm/model'
import type { Editor } from '@tiptap/core'
import { Ask, Explain, LoadBuffer, SaveBuffer } from '../../wailsjs/go/main/App'
import type { TabState } from '../types'
import type { main } from '../../wailsjs/go/models'
import { getLocalISOString } from '../lib/fmUtils'
import { buildAiContext, type AiContext } from '../lib/aiContextBuilder'

interface UseAiGesturesParams {
  editor: Editor | null
  isMarkdownMode: boolean
  rawMd: string
  tier: 'dumb' | 'smart'
  activeTabRef: React.MutableRefObject<TabState | undefined>
  tabsRef: React.MutableRefObject<TabState[]>
  uuidToPath: React.MutableRefObject<Map<string, string>>
  metaCache: React.MutableRefObject<Record<string, main.DocumentMetaDTO | null>>
  savedBodyCache: React.MutableRefObject<Record<string, string>>
  pendingAiCount: React.MutableRefObject<number>
  evalStartTimes: React.MutableRefObject<Record<string, number>>
  askContextRef: React.MutableRefObject<AiContext | null>
  setTabs: React.Dispatch<React.SetStateAction<TabState[]>>
  setRawMd: React.Dispatch<React.SetStateAction<string>>
  setShowAskPopup: React.Dispatch<React.SetStateAction<boolean>>
}

export function useAiGestures({
  editor,
  isMarkdownMode,
  rawMd,
  tier,
  activeTabRef,
  tabsRef,
  uuidToPath,
  metaCache,
  savedBodyCache,
  pendingAiCount,
  evalStartTimes,
  askContextRef,
  setTabs,
  setRawMd,
  setShowAskPopup,
}: UseAiGesturesParams) {
  function resolvePathByUuid(uuid: string): string | undefined {
    return tabsRef.current.find(t => t.uuid === uuid)?.path ?? uuidToPath.current.get(uuid)
  }

  function insertAiPlaceholder(aiId: string, blockRef: string, question?: string) {
    if (!editor) return
    queueMicrotask(() => {
      editor.commands.command(({ tr, state }) => {
        const { schema, selection } = state
        const { to } = selection

        let insertPos = state.doc.content.size
        let offset = 0
        for (let i = 0; i < state.doc.childCount; i++) {
          const child = state.doc.child(i)
          const end = offset + child.nodeSize
          if (offset <= to && to <= end) { insertPos = end; break }
          offset = end
        }

        const members: any[] = []
        if (question) {
          members.push(schema.nodes.paragraph.create(null, [
            schema.text('Ask:', [schema.marks.bold.create()]),
            schema.text(` ${question}`),
          ]))
        }
        members.push(
          schema.nodes.paragraph.create(
            null, schema.text('(thinking…)', [schema.marks.italic.create()])
          )
        )

        const aiNode = schema.nodes.aiBlock.create(
          { id: aiId, ref: blockRef },
          Fragment.from(members)
        )
        tr.insert(insertPos, aiNode)
        return true
      })
      if (isMarkdownMode && activeTabRef.current) {
        // Markdown mode shows body only — update rawMd to reflect the inserted block
        setRawMd(editor.storage.markdown.getMarkdown())
      }
    })
  }

  function replaceAiPlaceholder(aiId: string, responseText: string) {
    if (!editor) return

    let targetPos = -1
    let targetEnd = -1
    let askText = ''
    let existingRef = 'doc'

    editor.state.doc.descendants((node: any, pos: number) => {
      if (targetPos !== -1) return false
      if (node.type.name === 'aiBlock' && node.attrs.id === aiId) {
        targetPos = pos
        targetEnd = pos + node.nodeSize
        existingRef = node.attrs.ref ?? 'doc'
        node.forEach((child: any) => {
          if (child.type.name === 'paragraph' && child.textContent.startsWith('Ask: ')) {
            askText = child.textContent
          }
        })
        return false
      }
    })

    if (targetPos === -1) return

    const { schema } = editor.state
    const responseHtml = editor.storage.markdown.parser.md.render(responseText.trim())
    const tempDiv = document.createElement('div')
    tempDiv.innerHTML = responseHtml
    const parsedDoc = ProseMirrorDOMParser.fromSchema(schema).parse(tempDiv)

    const responseNodes: any[] = []
    parsedDoc.forEach((child: any) => {
      if (child.type.name === 'paragraph' && child.childCount === 0) return
      responseNodes.push(child)
    })

    const members: any[] = []
    if (askText) {
      const question = askText.replace(/^Ask:\s*/, '')
      members.push(schema.nodes.paragraph.create(null, [
        schema.text('Ask:', [schema.marks.bold.create()]),
        schema.text(` ${question}`),
      ]))
    }
    members.push(...responseNodes)
    if (members.length === 0) members.push(schema.nodes.paragraph.create())

    const newAiNode = schema.nodes.aiBlock.create(
      { id: aiId, ref: existingRef },
      Fragment.from(members)
    )

    editor.commands.command(({ tr }) => {
      tr.replaceWith(targetPos, targetEnd, newAiNode)
      return true
    })
    if (isMarkdownMode && activeTabRef.current) {
      setRawMd(editor.storage.markdown.getMarkdown())
    }
  }

  // Apply an AI response directly to a file on disk without touching the editor.
  async function applyAiResponseInBackground(uuid: string, aiId: string, responseText: string) {
    const path = resolvePathByUuid(uuid)
    if (!path) {
      console.warn('[stash:ai] background update: no path found for UUID', { uuid, aiId })
      return
    }
    try {
      const dto = await LoadBuffer(path)
      const idEscaped = aiId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const pattern = new RegExp(`(\\[!ai\\] id="${idEscaped}"[^\\n]*)\\s*[\\s\\S]*?\\s*\\[!ai-end\\]`)
      const updatedBody = dto.body.replace(pattern, `$1\n\n${responseText}\n\n[!ai-end]`)

      if (updatedBody === dto.body) {
        console.warn('[stash:ai] background update: placeholder not found in file', { uuid, path, aiId })
        return
      }

      const updatedMeta = { ...dto.meta, aiLastEvaluated: getLocalISOString() }
      const updatedDto = { ...dto, body: updatedBody, meta: updatedMeta }
      await SaveBuffer(updatedDto as any)

      savedBodyCache.current[uuid] = updatedBody
      metaCache.current[uuid] = updatedMeta

      console.log('[stash:ai] background update: response saved', { uuid, path, aiId })
    } catch (err) {
      console.error('[stash:ai] background update: failed', { uuid, path, aiId, err })
    }
  }

  function touchAiLastEvaluated(uuid: string) {
    const meta = metaCache.current[uuid]
    if (!meta) return
    const path = resolvePathByUuid(uuid)
    if (!path) return
    const updatedMeta = { ...meta, aiLastEvaluated: getLocalISOString() }
    metaCache.current[uuid] = updatedMeta
    const body = editor?.storage.markdown.getMarkdown() ?? savedBodyCache.current[uuid] ?? ''
    const tab = tabsRef.current.find(t => t.uuid === uuid)
    if (!tab) return
    const dto = { uuid, path, slug: path.split('/').pop()?.replace('.md','') ?? '', body, meta: updatedMeta, versions: [] }
    SaveBuffer(dto as any).catch(console.error)
  }

  function explainGesture() {
    if (!editor || tier !== 'smart') return
    const ctx = buildAiContext(editor, isMarkdownMode, rawMd, activeTabRef.current?.path ?? '')
    if (!ctx.content) return

    const capturedUuid = activeTabRef.current?.uuid!
    const aiId = 'ai-' + Math.random().toString(16).substring(2, 6)
    insertAiPlaceholder(aiId, ctx.blockRef)

    pendingAiCount.current++
    evalStartTimes.current[capturedUuid] = Date.now()
    setTabs(prev => prev.map(t => t.uuid === capturedUuid ? { ...t, isWaitingAI: true, aiJobName: 'Explain' } : t))

    console.log('[stash:ai] explain: firing', { aiId, uuid: capturedUuid, blockRef: ctx.blockRef, imagePaths: ctx.imagePaths })
    Explain(ctx.content, ctx.history, activeTabRef.current?.path ?? '', Array.from(ctx.imagePaths))
      .then(resp => {
        const trimmed = resp.trim()
        const isActive = activeTabRef.current?.uuid === capturedUuid
        if (!isActive) {
          console.log('[stash:ai] explain: tab not active — applying response to file', { uuid: capturedUuid, aiId })
          applyAiResponseInBackground(capturedUuid, aiId, trimmed)
          return
        }
        console.log('[stash:ai] explain: response received', { aiId, len: trimmed.length })
        replaceAiPlaceholder(aiId, trimmed)
        touchAiLastEvaluated(capturedUuid)
      })
      .catch(err => {
        console.warn('[stash:ai] explain: failed', err)
        const errorMsg = '_(explain timed out — Ctrl+E to retry)_'
        const isActive = activeTabRef.current?.uuid === capturedUuid
        if (!isActive) {
          applyAiResponseInBackground(capturedUuid, aiId, errorMsg)
          return
        }
        replaceAiPlaceholder(aiId, errorMsg)
      })
      .finally(() => {
        pendingAiCount.current--
        setTabs(prev => prev.map(t => t.uuid === capturedUuid ? { ...t, isWaitingAI: false } : t))
      })
  }

  function askGesture() {
    if (!editor || tier !== 'smart') return
    const ctx = buildAiContext(editor, isMarkdownMode, rawMd, activeTabRef.current?.path ?? '')
    console.log('[stash:ai] ask: ', { images: ctx.imagePaths })
    askContextRef.current = ctx
    setShowAskPopup(true)
  }

  function handleAskSend(question: string) {
    const ctx = askContextRef.current
    if (!ctx || !editor) return

    const capturedUuid = activeTabRef.current?.uuid!
    const aiId = 'ai-' + Math.random().toString(16).substring(2, 6)
    insertAiPlaceholder(aiId, ctx.blockRef, question)

    pendingAiCount.current++
    evalStartTimes.current[capturedUuid] = Date.now()
    setTabs(prev => prev.map(t => t.uuid === capturedUuid ? { ...t, isWaitingAI: true, aiJobName: 'Ask' } : t))

    console.log('[stash:ai] ask: firing', { aiId, uuid: capturedUuid, blockRef: ctx.blockRef, question, imagePaths: ctx.imagePaths })
    Ask(ctx.content, ctx.history, question, activeTabRef.current?.path ?? '', Array.from(ctx.imagePaths))
      .then(resp => {
        const trimmed = resp.trim()
        const isActive = activeTabRef.current?.uuid === capturedUuid
        if (!isActive) {
          console.log('[stash:ai] ask: tab not active — applying response to file', { uuid: capturedUuid, aiId })
          applyAiResponseInBackground(capturedUuid, aiId, trimmed)
          return
        }
        console.log('[stash:ai] ask: response received', { aiId, len: trimmed.length })
        replaceAiPlaceholder(aiId, trimmed)
        touchAiLastEvaluated(capturedUuid)
      })
      .catch(err => {
        console.warn('[stash:ai] ask: failed', err)
        const errorMsg = '_(ask timed out — Ctrl+Shift+A to retry)_'
        const isActive = activeTabRef.current?.uuid === capturedUuid
        if (!isActive) {
          applyAiResponseInBackground(capturedUuid, aiId, errorMsg)
          return
        }
        replaceAiPlaceholder(aiId, errorMsg)
      })
      .finally(() => {
        pendingAiCount.current--
        setTabs(prev => prev.map(t => t.uuid === capturedUuid ? { ...t, isWaitingAI: false } : t))
      })
  }

  return {
    insertAiPlaceholder,
    replaceAiPlaceholder,
    resolvePathByUuid,
    applyAiResponseInBackground,
    touchAiLastEvaluated,
    explainGesture,
    askGesture,
    handleAskSend,
  }
}
