import type { main, stash } from '../../wailsjs/go/models'

// Compute markdown-relative path from a tab's store-relative path to an asset's store-relative path.

export function getLocalISOString(d = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// Apply a FilingRecommendation (from EvaluateBuffer) to a meta DTO and return
// a new DTO — the Store owns version/modified, so we never bump those here.
export function applyFilingRecToMeta(
  meta: main.DocumentMetaDTO | null,
  rec: stash.FilingRecommendation,
  cli: string,
): main.DocumentMetaDTO {
  const d = meta || {
    status: 'unfiled',
    version: 1,
    focusCount: 0,
    aiEval: 'evaluating',
    displayName: 'Untitled',
    tags: [],
    densitySignals: [],
    created: getLocalISOString(),
    modified: getLocalISOString(),
    scroll: 0,
    assets: [],
    all: {},
  } as main.DocumentMetaDTO

  return {
    ...d,
    aiEval:             'complete',
    aiLastEvaluated:    getLocalISOString(),
    aiKeep:             rec.keep,
    cli:                cli || d.cli,
    displayName:        rec.title    || d.displayName,
    filename:           rec.filename || d.filename,
    aiFolderSuggestion: rec.folder   || d.aiFolderSuggestion,
    summary:            rec.summary  || d.summary,
    tags:               rec.tags?.length     ? rec.tags               : d.tags,
    aiJustification:    rec.ai_justification || d.aiJustification,
    densitySignals:     rec.density_signals?.length ? rec.density_signals : d.densitySignals,
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
