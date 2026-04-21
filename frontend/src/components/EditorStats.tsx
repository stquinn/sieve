import { useEffect, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { splitFrontmatter } from '../lib/markdown'

interface EditorStatsProps {
  editor: Editor | null
  isMarkdownMode: boolean
  rawMd: string
}

export function EditorStats({ editor, isMarkdownMode, rawMd }: EditorStatsProps) {
  const [stats, setStats] = useState({ chars: 0, lines: 0 })

  useEffect(() => {
    if (isMarkdownMode) {
      const text = splitFrontmatter(rawMd).body
      const chars = text.length
      const lines = text === '' ? 0 : text.split('\n').length
      setStats({ chars, lines })
      return
    }

    if (!editor) return

    const updateStats = () => {
      const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n')
      const chars = text.length
      const lines = text === '' ? 0 : text.split('\n').length
      setStats({ chars, lines })
    }

    updateStats()
    editor.on('transaction', updateStats)
    return () => { editor.off('transaction', updateStats) }
  }, [editor, isMarkdownMode, rawMd])

  return (
    <>
      <span title="Characters">{stats.chars} chars</span>
      <span className="status-bar__sep">|</span>
      <span title="Lines">{stats.lines} lines</span>
    </>
  )
}
