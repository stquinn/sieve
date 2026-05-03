export function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const match = content.match(/^(---\n[\s\S]*?\n---\n?)/)
  if (match) return { frontmatter: match[1], body: content.slice(match[1].length) }
  return { frontmatter: '', body: content }
}

// Strips all AI blocks from a markdown string to produce clean context for AI prompts.
export function getCleanMarkdown(fullMd: string): string {
  const regex = /\n*\[!ai\] id="[^"]+" ref="[^"]+"[\s\S]*?\[!ai-end\]\n*/g
  return fullMd.replace(regex, '\n\n').trim()
}
