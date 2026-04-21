import React from 'react'
import { DOMParser as ProseMirrorDOMParser, Fragment } from '@tiptap/pm/model'
import type { Editor } from '@tiptap/core'
import { Ask, Explain, LoadBuffer, SaveBuffer } from '../../wailsjs/go/main/App'
import type { TabState } from '../types'
import type { main } from '../../wailsjs/go/models'
import { getLocalISOString } from '../lib/fmUtils'
import { buildAiContext, type AiContext } from '../lib/aiContextBuilder'
import type { StorableDataService } from '../lib/StorableDataService'

import { EditorPanelHandle } from '../components/EditorPanel'

interface UseAiGesturesParams {
  getEditor: (uuid: string) => EditorPanelHandle | undefined
  tier: 'dumb' | 'smart'
  activeTab: TabState | undefined
  tabsRef: React.MutableRefObject<TabState[]>
  uuidToPath: React.MutableRefObject<Map<string, string>>
  pendingAiCount: React.MutableRefObject<number>
  evalStartTimes: React.MutableRefObject<Record<string, number>>
  askContextRef: React.MutableRefObject<AiContext | null>
  setTabs: React.Dispatch<React.SetStateAction<TabState[]>>
  setShowAskPopup: React.Dispatch<React.SetStateAction<boolean>>
  ds: StorableDataService
}

export function useAiGestures({
  getEditor,
  tier,
  activeTab,
  tabsRef,
  uuidToPath,
  pendingAiCount,
  evalStartTimes,
  askContextRef,
  setTabs,
  setShowAskPopup,
  ds,
}: UseAiGesturesParams) {
  function resolvePathByUuid(uuid: string): string | undefined {
    return ds.get(uuid)?.path ?? uuidToPath.current.get(uuid)
  }

  function insertAiPlaceholder(aiId: string, blockRef: string, question?: string) {
    const editor = activeTab ? getEditor(activeTab.uuid)?.getEditor() : null
    if (!editor) return
    queueMicrotask(() => {
      editor.commands.command(({ tr, state }: { tr: import('@tiptap/pm/state').Transaction, state: import('@tiptap/pm/state').EditorState }) => {
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
      if (activeTab && activeTab.mode === 'markdown') {
        const md = getEditor(activeTab.uuid)?.getMarkdown() || ''
        ds.setBody(activeTab.uuid, md)
      }
    })
  }

  function replaceAiPlaceholder(aiId: string, responseText: string) {
    const editor = activeTab ? getEditor(activeTab.uuid)?.getEditor() : null
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

    editor.commands.command(({ tr }: { tr: import('@tiptap/pm/state').Transaction }) => {
      tr.replaceWith(targetPos, targetEnd, newAiNode)
      return true
    })
    if (activeTab && activeTab.mode === 'markdown') {
      const md = getEditor(activeTab.uuid)?.getMarkdown() || ''
      ds.setBody(activeTab.uuid, md)
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
      const doc = await ds.load(path)
      const idEscaped = aiId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const pattern = new RegExp(`(\\[!ai\\] id="${idEscaped}"[^\\n]*)\\s*[\\s\\S]*?\\s*\\[!ai-end\\]`)
      const updatedBody = doc.body.replace(pattern, `$1\n\n${responseText}\n\n[!ai-end]`)

      if (updatedBody === doc.body) {
        console.warn('[stash:ai] background update: placeholder not found in file', { uuid, path, aiId })
        return
      }

      ds.setBody(uuid, updatedBody)
      ds.setMeta(uuid, { ...doc.meta!, aiLastEvaluated: getLocalISOString() })
      await ds.save(uuid)

      console.log('[stash:ai] background update: response saved', { uuid, path, aiId })
    } catch (err) {
      console.error('[stash:ai] background update: failed', { uuid, path, aiId, err })
    }
  }

  function touchAiLastEvaluated(uuid: string) {
    const doc = ds.get(uuid)
    if (!doc || !doc.meta) return

    ds.setMeta(uuid, { ...doc.meta, aiLastEvaluated: getLocalISOString() })
    ds.save(uuid).catch(console.error)
  }

  function explainGesture() {
    const editor = activeTab ? getEditor(activeTab.uuid)?.getEditor() : null
    if (!editor || tier !== 'smart') return
    const capturedUuid = activeTab?.uuid!
    const capturedPath = ds.get(capturedUuid)?.path || ''
    const aiId = 'ai-' + Math.random().toString(16).substring(2, 6)
    const ctx = buildAiContext(editor, activeTab?.mode === 'markdown', ds.get(capturedUuid)?.body || '', capturedPath)
    if (!ctx.content) return
    insertAiPlaceholder(aiId, ctx.blockRef)

    pendingAiCount.current++
    evalStartTimes.current[capturedUuid] = Date.now()
    ds.setTransient(capturedUuid, { isWaitingAI: true, aiJobName: 'Explain' })

    console.log('[stash:ai] explain: firing', { aiId, uuid: capturedUuid, blockRef: ctx.blockRef, imagePaths: ctx.imagePaths })
    Explain(ctx.content, ctx.history, capturedPath, Array.from(ctx.imagePaths))
      .then(resp => {
        const trimmed = resp.trim()
        const isActive = activeTab?.uuid === capturedUuid
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
        const isActive = activeTab?.uuid === capturedUuid
        if (!isActive) {
          applyAiResponseInBackground(capturedUuid, aiId, errorMsg)
          return
        }
        replaceAiPlaceholder(aiId, errorMsg)
      })
      .finally(() => {
        pendingAiCount.current--
        ds.setTransient(capturedUuid, { isWaitingAI: false })
      })
  }

  function askGesture() {
    if (!activeTab || tier !== 'smart') return
    const editor = getEditor(activeTab.uuid)?.getEditor()
    if (!editor) return
    const path = ds.get(activeTab.uuid)?.path || ''
    const ctx = buildAiContext(editor, activeTab.mode === 'markdown', ds.get(activeTab.uuid)?.body || '', path)
    console.log('[stash:ai] ask: ', { images: ctx.imagePaths })
    askContextRef.current = ctx
    setShowAskPopup(true)
  }

  function handleAskSend(question: string) {
    const ctx = askContextRef.current
    const editor = activeTab ? getEditor(activeTab.uuid)?.getEditor() : null
    if (!ctx || !editor || !activeTab) return

    const capturedUuid = activeTab?.uuid!
    const capturedPath = ds.get(capturedUuid)?.path || ''
    const aiId = 'ai-' + Math.random().toString(16).substring(2, 6)
    insertAiPlaceholder(aiId, ctx.blockRef, question)

    pendingAiCount.current++
    evalStartTimes.current[capturedUuid] = Date.now()
    ds.setTransient(capturedUuid, { isWaitingAI: true, aiJobName: 'Ask' })

    console.log('[stash:ai] ask: firing', { aiId, uuid: capturedUuid, blockRef: ctx.blockRef, question, imagePaths: ctx.imagePaths })
    Ask(ctx.content, ctx.history, question, capturedPath, Array.from(ctx.imagePaths))
      .then(resp => {
        const trimmed = resp.trim()
        const isActive = activeTab?.uuid === capturedUuid
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
        const isActive = activeTab?.uuid === capturedUuid
        if (!isActive) {
          applyAiResponseInBackground(capturedUuid, aiId, errorMsg)
          return
        }
        replaceAiPlaceholder(aiId, errorMsg)
      })
      .finally(() => {
        pendingAiCount.current--
        ds.setTransient(capturedUuid, { isWaitingAI: false })
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
