import type { main, stash } from '../../wailsjs/go/models'

// Compute markdown-relative path from a tab's store-relative path to an asset's store-relative path.
// e.g. tabPath="dash/buffers/buf.md", assetPath="dash/buffers/.assets/blk.png" → ".assets/blk.png"
// e.g. tabPath="store/note.md", assetPath="store/.assets/blk.png" → ".assets/blk.png"
export function assetMarkdownPath(tabPath: string, assetStorePath: string): string {
  const fromDir = tabPath.split('/').slice(0, -1)
  const toParts = assetStorePath.split('/')
  let common = 0
  while (common < fromDir.length && common < toParts.length && fromDir[common] === toParts[common]) common++
  const ups = Array(fromDir.length - common).fill('..')
  const downs = toParts.slice(common)
  return [...ups, ...downs].join('/')
}

export function getLocalISOString(d = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// Apply a FilingRecommendation (from EvaluateBuffer) to a meta DTO and return
// a new DTO — the Store owns version/modified, so we never bump those here.
export function applyFilingRecToMeta(
  meta: main.DocumentMetaDTO,
  rec: stash.FilingRecommendation,
  cli: string,
): main.DocumentMetaDTO {
  return {
    ...meta,
    aiEval:             'complete',
    aiLastEvaluated:    getLocalISOString(),
    aiKeep:             rec.keep,
    cli:                cli || meta.cli,
    displayName:        rec.title    || meta.displayName,
    filename:           rec.filename || meta.filename,
    aiFolderSuggestion: rec.folder   || meta.aiFolderSuggestion,
    summary:            rec.summary  || meta.summary,
    tags:               rec.tags?.length     ? rec.tags               : meta.tags,
    aiJustification:    rec.ai_justification || meta.aiJustification,
    densitySignals:     rec.density_signals?.length ? rec.density_signals : meta.densitySignals,
  }
}

export function getAncestorPaths(path: string): string[] {
  // Strip "store/" prefix to treat the store directory as a virtual root.
  const prefix = 'store/'
  const workingPath = path.startsWith(prefix) ? path.substring(prefix.length) : path

  const parts = workingPath.split('/')
  const ancestors: string[] = []
  for (let i = 0; i < parts.length - 1; i++) {
    ancestors.push(parts.slice(0, i + 1).join('/'))
  }
  return ancestors
}
