interface Props {
  meta: string
  path: string
  width: number
  isModified: boolean
  isEvaluating?: boolean
  isWaitingAI?: boolean
  onRestoreRequested?: (body: string) => void
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
  if (v === 'filed') return 'var(--theme-accentGreen)'
  if (v === 'unfiled') return 'var(--theme-accentYellow)'
  return 'var(--theme-muted)'
}

function intentColour(v: string | null): string {
  if (v === 'keep') return 'var(--theme-accentPrimary)'
  if (v === 'trash') return 'var(--theme-accentRed)'
  return 'var(--theme-muted)'
}

function evalColour(v: string | null): string {
  if (v === 'complete') return 'var(--theme-accentGreen)'
  if (v === 'timeout') return 'var(--theme-accentRed)'
  if (v === 'none') return 'var(--theme-muted)'
  return 'var(--theme-muted)'
}

export function MetaPanel({ meta: metaStr, path, width, isModified, isEvaluating, isWaitingAI, onRestoreRequested }: Props) {
  const hasMeta = metaStr.trim().startsWith('---')
  const meta = hasMeta ? parseMeta(metaStr) : null

  const fileName = path.split('/').pop() ?? path
  const [activeTab, setActiveTab] = React.useState<'meta'|'history'>('meta')
  const [history, setHistory] = React.useState<any[]>([])

  React.useEffect(() => {
    if (activeTab === 'history' && meta?.uuid) {
      GetBufferHistory(meta.uuid).then(res => setHistory(res || []))
    }
  }, [activeTab, meta?.uuid, meta?.version])

  return (
    <div className="meta-panel" style={{ width }}>
      <div className="meta-panel__header" style={{ display: 'flex', gap: '0.8rem', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: '1rem', flex: 1, position: 'relative', top: '1px' }}>
          <span 
             style={{ cursor: 'pointer', color: activeTab === 'meta' ? 'var(--theme-text)' : 'var(--theme-muted)', borderBottom: activeTab === 'meta' ? '2px solid var(--theme-accentPrimary)' : '2px solid transparent', paddingBottom: '0.4rem', marginBottom: '-0.42rem' }} 
             onClick={() => setActiveTab('meta')}
          >Meta</span>
          <span 
             style={{ cursor: 'pointer', color: activeTab === 'history' ? 'var(--theme-text)' : 'var(--theme-muted)', borderBottom: activeTab === 'history' ? '2px solid var(--theme-accentPrimary)' : '2px solid transparent', paddingBottom: '0.4rem', marginBottom: '-0.42rem' }} 
             onClick={() => setActiveTab('history')}
          >History</span>
        </div>
        {(isEvaluating || isWaitingAI) && (
          <span className="meta-panel__ai-badge">
            <span className="meta-panel__ai-spinner" />
            {isWaitingAI ? 'Thinking' : 'Evaluating'}
          </span>
        )}
      </div>

      <div className="meta-panel__path" title={path}>{fileName}</div>

      {activeTab === 'meta' && (
        !hasMeta ? (
          <div className="meta-panel__empty">No meta</div>
        ) : (
        <div className="meta-panel__fields">
          <Row label="Dirty">
            <span style={{ color: isModified ? 'var(--theme-accentYellow)' : 'var(--theme-accentGreen)' }}>{isModified ? 'true' : 'false'}</span>
          </Row>
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
        )
      )}

      {activeTab === 'history' && (
        <div className="meta-panel__fields">
          {history.filter(h => h.version !== Number(meta?.version)).length === 0 ? (
            <div className="meta-panel__empty">No historical snapshots found.</div>
          ) : (
            history.filter(h => h.version !== Number(meta?.version)).map(snapshot => (
              <div key={snapshot.version} style={{ padding: '0.6rem 0.9rem', borderBottom: '1px solid var(--theme-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                  <span style={{ color: 'var(--theme-text)', fontWeight: 600, fontSize: '14px' }}>Version {snapshot.version}</span>
                  <span style={{ color: 'var(--theme-muted)', fontSize: '12px' }}>{fmtDate(snapshot.modified)} • {Math.round(snapshot.size / 1024)} KB</span>
                </div>
                <button
                  style={{ background: 'var(--theme-bgAlt)', border: '1px solid var(--theme-border2)', color: 'var(--theme-text)', padding: '0.25rem 0.6rem', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--theme-accentPrimary)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'var(--theme-bgAlt)'}
                  onClick={() => {
                    if (window.confirm(`Restore version ${snapshot.version}?\n\nThis will safely overwrite your current text body, but preserve your live tags and document status. The canonical version will be bumped up.`)) {
                       GetBufferHistoryBody(meta!.uuid!, snapshot.version)
                         .then((body) => onRestoreRequested?.(body))
                         .catch(console.error)
                    }
                  }}
                >
                  Restore
                </button>
              </div>
            ))
          )}
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
import { GetBufferHistory, GetBufferHistoryBody } from '../../wailsjs/go/main/App'
