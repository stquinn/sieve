import { stash } from '../../wailsjs/go/models'
import type { TabState } from '../types'

// Compute markdown-relative path from a tab's store-relative path to an asset's store-relative path.
// e.g. tabPath="dash/buffers/buf.md", assetPath="dash/buffers/assets/blk.png" → "assets/blk.png"
// e.g. tabPath="store/note.md", assetPath="store/assets/blk.png" → "assets/blk.png"
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

export function versionFromFm(fm: string): number {
  const m = fm.match(/^version:\s*(\d+)/m)
  return m ? parseInt(m[1]) : 0
}

// Increment version and update modified timestamp in frontmatter.
// Only applied in wysiwyg mode (in markdown mode the user edits fm directly).
export function bumpFm(fm: string): string {
  const now = getLocalISOString()
  const vMatch = fm.match(/^version:\s*(\d+)/m)
  const v = vMatch ? parseInt(vMatch[1]) + 1 : 1
  return fm
    .replace(/^version:\s*\d+/m, `version: ${v}`)
    .replace(/^modified:\s*.+/m, `modified: ${now}`)
}

export function bumpFocusCount(fm: string): string {
  const fcMatch = fm.match(/^focus_count:\s*(\d+)/m)
  const fc = fcMatch ? parseInt(fcMatch[1]) + 1 : 1
  return fm.replace(/^focus_count:\s*\d+/m, `focus_count: ${fc}`)
}

export function parseMeta(fm: string, body: string) {
  const status = (fm.match(/^status:\s*(\w+)/m)?.[1] ?? 'unfiled') as TabState['status']
  const userIntent = fm.match(/^user_intent:\s*(keep|trash)/m)?.[1] as any || null
  const isEvaluating = /^ai_eval:\s*evaluating\b/m.test(fm)
  const displayName = fm.match(/^display_name:\s*(.+)/m)?.[1]?.trim()?.replace(/^['"]|['"]$/g, '')
  const scrollMatch = fm.match(/^scroll:\s*(\d+)/m)
  const scroll = scrollMatch ? parseInt(scrollMatch[1], 10) : 0
  const isEmpty = body.trim().length === 0
  return {
    status,
    userIntent,
    displayName: (displayName === 'null' || displayName === '') ? undefined : displayName,
    isEmpty,
    isEvaluating,
    scroll,
  }
}

export function setYamlField(yaml: string, key: string, val: any): string {
  let strVal: string
  if (Array.isArray(val)) {
    strVal = `[${val.join(', ')}]`
  } else if (val !== null && val !== undefined && val !== '') {
    const s = String(val)
    strVal = s.includes(':') || s.includes("'") || s.includes('"') ? `"${s.replace(/"/g, '\\"')}"` : s
  } else {
    strVal = 'null'
  }
  const escapedKey = key.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, '\\$1')
  const regex = new RegExp(`^${escapedKey}:\\s*.*$`, 'm')
  if (regex.test(yaml)) {
    return yaml.replace(regex, `${key}: ${strVal}`)
  } else {
    // Append before the closing marker, ensuring a leading newline
    return yaml.replace(/\n---\n?$/, `\n${key}: ${strVal}\n---\n`)
  }
}

// Update a single YAML frontmatter field in-place. Handles null, arrays, and strings.
export function applyFilingRec(fm: string, rec: stash.FilingRecommendation, cli: string): string {
  fm = setYamlField(fm, 'ai_eval', 'complete')
  fm = setYamlField(fm, 'ai_last_evaluated', getLocalISOString())
  fm = setYamlField(fm, 'ai_keep', rec.keep)
  fm = setYamlField(fm, 'cli', cli)
  if (rec.title)            fm = setYamlField(fm, 'display_name', rec.title)
  if (rec.filename)         fm = setYamlField(fm, 'filename', rec.filename)
  if (rec.folder)           fm = setYamlField(fm, 'ai_folder_suggestion', rec.folder)
  if (rec.summary)          fm = setYamlField(fm, 'summary', rec.summary)
  if (rec.tags?.length)     fm = setYamlField(fm, 'tags', rec.tags)
  if (rec.ai_justification) fm = setYamlField(fm, 'ai_justification', rec.ai_justification)
  if (rec.density_signals?.length) fm = setYamlField(fm, 'density_signals', rec.density_signals)
  return fm
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
