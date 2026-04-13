interface Props {
  meta: string
  path: string
  width: number
}

interface ParsedMeta {
  uuid: string | null
  status: string | null
  version: string | null
  focus_count: string | null
  user_intent: string | null
  ai_eval: string | null
  ai_last_evaluated: string | null
  ai_folder_suggestion: string | null
  user_suggested_name: string | null
  display_name: string | null
  filename: string | null
  summary: string | null
  tags: string[] | null
  created: string | null
  modified: string | null
  cli: string | null
}

function parseMeta(fm: string): ParsedMeta {
  const str = (key: string): string | null => {
    const m = fm.match(new RegExp(`^${key}:\\s*(.+)`, 'm'))
    if (!m) return null
    const v = m[1].trim().replace(/^['"]|['"]$/g, '')
    return v === 'null' || v === '' ? null : v
  }

  const tagsRaw = fm.match(/^tags:\s*\[([^\]]*)\]/m)?.[1] ?? null
  const tags = tagsRaw
    ? tagsRaw.split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    : null

  return {
    uuid:                 str('uuid'),
    status:               str('status'),
    version:              str('version'),
    focus_count:          str('focus_count'),
    user_intent:          str('user_intent'),
    ai_eval:              str('ai_eval'),
    ai_last_evaluated:    str('ai_last_evaluated'),
    ai_folder_suggestion: str('ai_folder_suggestion'),
    user_suggested_name:  str('user_suggested_name'),
    display_name:         str('display_name'),
    filename:             str('filename'),
    summary:              str('summary'),
    tags,
    created:              str('created'),
    modified:             str('modified'),
    cli:                  str('cli'),
  }
}

function fmtDate(v: string | null): string | null {
  if (!v) return null
  try {
    return new Date(v).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return v
  }
}

function statusColour(v: string | null): string {
  if (v === 'filed') return '#9ece6a'
  if (v === 'unfiled') return '#e0af68'
  return '#565f89'
}

function intentColour(v: string | null): string {
  if (v === 'keep') return '#7aa2f7'
  if (v === 'trash') return '#f7768e'
  return '#565f89'
}

function evalColour(v: string | null): string {
  if (v === 'complete') return '#9ece6a'
  if (v === 'timeout') return '#f7768e'
  if (v === 'none') return '#565f89'
  return '#565f89'
}

export function MetaPanel({ meta: metaStr, path, width }: Props) {
  const hasMeta = metaStr.trim().startsWith('---')
  const meta = hasMeta ? parseMeta(metaStr) : null

  const fileName = path.split('/').pop() ?? path

  return (
    <div className="meta-panel" style={{ width }}>
      <div className="meta-panel__header">Meta</div>

      <div className="meta-panel__path" title={path}>{fileName}</div>

      {!hasMeta ? (
        <div className="meta-panel__empty">No meta</div>
      ) : (
        <div className="meta-panel__fields">
          <Row label="Status">
            <span style={{ color: statusColour(meta!.status) }}>{meta!.status ?? '—'}</span>
          </Row>
          <Row label="Version">{meta!.version ?? '—'}</Row>
          <Row label="Focus count">{meta!.focus_count ?? '—'}</Row>

          <Divider />

          <Row label="User intent">
            <span style={{ color: intentColour(meta!.user_intent) }}>
              {meta!.user_intent ?? 'null'}
            </span>
          </Row>
          <Row label="AI eval">
            <span style={{ color: evalColour(meta!.ai_eval) }}>{meta!.ai_eval ?? '—'}</span>
          </Row>
          <Row label="AI evaluated">{fmtDate(meta!.ai_last_evaluated) ?? '—'}</Row>
          <Row label="AI folder">{meta!.ai_folder_suggestion ?? '—'}</Row>

          <Divider />

          <Row label="Display name">{meta!.display_name ?? '—'}</Row>
          <Row label="Filename">{meta!.filename ?? '—'}</Row>
          <Row label="User name">{meta!.user_suggested_name ?? '—'}</Row>
          <Row label="CLI">{meta!.cli ?? '—'}</Row>

          <Divider />

          <Row label="Summary">
            <span className="meta-panel__summary">{meta!.summary ?? '—'}</span>
          </Row>

          {meta!.tags && meta!.tags.length > 0 && (
            <div className="meta-panel__tags-row">
              <span className="meta-panel__label">Tags</span>
              <div className="meta-panel__tags">
                {meta!.tags.map(t => (
                  <span key={t} className="meta-panel__tag">{t}</span>
                ))}
              </div>
            </div>
          )}
          {(!meta!.tags || meta!.tags.length === 0) && (
            <Row label="Tags">—</Row>
          )}

          <Divider />

          <Row label="Created">{fmtDate(meta!.created) ?? '—'}</Row>
          <Row label="Modified">{fmtDate(meta!.modified) ?? '—'}</Row>

          <Divider />

          <Row label="UUID">
            <span className="meta-panel__uuid">{meta!.uuid ?? '—'}</span>
          </Row>
        </div>
      )}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="meta-panel__row">
      <span className="meta-panel__label">{label}</span>
      <span className="meta-panel__value">{children}</span>
    </div>
  )
}

function Divider() {
  return <div className="meta-panel__divider" />
}

// React needed for JSX
import React from 'react'
