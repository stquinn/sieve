interface EditorStatsProps {
  chars: number
  lines: number
}

export function EditorStats({ chars, lines }: EditorStatsProps) {
  return (
    <>
      <span title="Characters">{chars} chars</span>
      <span className="status-bar__sep">|</span>
      <span title="Lines">{lines} lines</span>
    </>
  )
}
