import React from 'react'
import { GetDocumentVersion } from '../../wailsjs/go/main/App'
import type { main } from '../../wailsjs/go/models'

interface Props {
  meta: main.DocumentMetaDTO | null
  path: string
  width: number
  isModified: boolean
  isEvaluating?: boolean
  isWaitingAI?: boolean
  versions?: main.VersionRefDTO[]
  onRestoreRequested?: (body: string) => void
}

function fmtDate(v: string | null | undefined): string | null {
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

function statusColour(v: string | null | undefined): string {
  if (v === 'filed') return 'var(--theme-accentGreen)'
  if (v === 'unfiled') return 'var(--theme-accentYellow)'
  return 'var(--theme-muted)'
}

function intentColour(v: string | null | undefined): string {
  if (v === 'keep') return 'var(--theme-accentPrimary)'
  if (v === 'trash') return 'var(--theme-accentRed)'
  return 'var(--theme-muted)'
}

function evalColour(v: string | null | undefined): string {
  if (v === 'complete') return 'var(--theme-accentGreen)'
  if (v === 'timeout') return 'var(--theme-accentRed)'
  if (v === 'none') return 'var(--theme-muted)'
  return 'var(--theme-muted)'
}

export function MetaPanel({ meta, path, width, isModified, isEvaluating, isWaitingAI, versions = [], onRestoreRequested }: Props) {
  const fileName = path.split('/').pop() ?? path
  const [activeTab, setActiveTab] = React.useState<'meta'|'history'|'assets'>('meta')
  const [now, setNow] = React.useState(new Date())

  React.useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="meta-panel" style={{ width }}>
      <div className="meta-panel__header" style={{ display: 'flex', gap: '0.8rem', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: '1rem', flex: 1, position: 'relative', top: '1px' }}>
          <span
             style={{ cursor: 'pointer', color: activeTab === 'meta' ? 'var(--theme-text)' : 'var(--theme-muted)', borderBottom: activeTab === 'meta' ? '2px solid var(--theme-accentPrimary)' : '2px solid transparent', paddingBottom: '0.4rem', marginBottom: '-0.42rem' }}
             onClick={() => setActiveTab('meta')}
          >Meta</span>
          {!path.startsWith('prompt:') && (
            <span
               style={{ cursor: 'pointer', color: activeTab === 'history' ? 'var(--theme-text)' : 'var(--theme-muted)', borderBottom: activeTab === 'history' ? '2px solid var(--theme-accentPrimary)' : '2px solid transparent', paddingBottom: '0.4rem', marginBottom: '-0.42rem' }}
               onClick={() => setActiveTab('history')}
            >History</span>
          )}
          {meta?.assets && meta.assets.length > 0 && (
             <span
             style={{ cursor: 'pointer', color: activeTab === 'assets' ? 'var(--theme-text)' : 'var(--theme-muted)', borderBottom: activeTab === 'assets' ? '2px solid var(--theme-accentPrimary)' : '2px solid transparent', paddingBottom: '0.4rem', marginBottom: '-0.42rem' }}
             onClick={() => setActiveTab('assets')}
          >Assets</span>
          )}
        </div>
        {(isEvaluating || isWaitingAI) && (
          <span className="meta-panel__ai-badge">
            <span className="meta-panel__ai-spinner" />
            {isWaitingAI ? 'Thinking' : 'Evaluating'}
          </span>
        )}
      </div>

      <div className="meta-panel__path !text-white/80 border-b border-tn-bg px-[0.9rem] font-medium" title={path}>{fileName}</div>

      {activeTab === 'meta' && (
        !meta ? (
          <>
            <div className="meta-panel__empty !text-white/90">No meta</div>
            <PromptReference path={path} />
          </>
        ) : (
        <div className="meta-panel__fields">
          <Row label="Dirty">
            <span style={{ color: isModified ? 'var(--theme-accentYellow)' : 'var(--theme-accentGreen)' }}>{isModified ? 'true' : 'false'}</span>
          </Row>
          <Row label="Status">
            <span style={{ color: statusColour(meta.status) }}>{meta.status ?? '—'}</span>
          </Row>
          <Row label="Version">{meta.version ?? '—'}</Row>
          <Row label="Focus count">{meta.focusCount ?? '—'}</Row>
          <Row label="Now">
            <span style={{ color: 'var(--theme-accentPrimary)' }}>{fmtDate(now.toISOString())}</span>
          </Row>

          <Divider />

          <Row label="User intent">
            <span style={{ color: intentColour(meta.userIntent) }}>
              {meta.userIntent ?? 'null'}
            </span>
          </Row>
          <Row label="AI keep">
            <span style={{ color: meta.aiKeep === true ? 'var(--theme-accentGreen)' : meta.aiKeep === false ? 'var(--theme-accentRed)' : 'inherit', fontWeight: meta.aiKeep === false ? 'bold' : 'normal' }}>
              {meta.aiKeep === true ? 'keep' : meta.aiKeep === false ? 'discard' : '—'}
            </span>
          </Row>
          <Row label="AI eval">
            <span style={{ color: evalColour(meta.aiEval) }}>{meta.aiEval ?? '—'}</span>
          </Row>
          <Row label="AI evaluated">{fmtDate(meta.aiLastEvaluated) ?? '—'}</Row>
          <Row label="AI folder">{meta.aiFolderSuggestion ?? '—'}</Row>

          <Divider />

          <Row label="Display name">{meta.displayName ?? '—'}</Row>
          <Row label="Filename">{meta.filename ?? '—'}</Row>
          <Row label="User name">{meta.userSuggestedName ?? '—'}</Row>
          <Row label="CLI">{meta.cli ?? '—'}</Row>

          <Divider />

          <Row label="Summary">
            <span className="meta-panel__summary">{meta.summary ?? '—'}</span>
          </Row>

          {meta.tags && meta.tags.length > 0 && (
            <div className="meta-panel__tags-row">
              <span className="meta-panel__label">Tags</span>
              <div className="meta-panel__tags">
                {meta.tags.map(t => (
                  <span key={t} className="meta-panel__tag">{t}</span>
                ))}
              </div>
            </div>
          )}
          {(!meta.tags || meta.tags.length === 0) && (
            <Row label="Tags">—</Row>
          )}

          <Row label="AI why">
            <span className="meta-panel__summary">{meta.aiJustification ?? '—'}</span>
          </Row>

          {meta.densitySignals && meta.densitySignals.length > 0 && (
            <div className="meta-panel__tags-row">
              <span className="meta-panel__label">Density</span>
              <div className="meta-panel__tags">
                {meta.densitySignals.map(s => (
                  <span key={s} className="meta-panel__tag">{s}</span>
                ))}
              </div>
            </div>
          )}
          {(!meta.densitySignals || meta.densitySignals.length === 0) && (
            <Row label="Density">—</Row>
          )}

          <Divider />

          <Row label="Created">{fmtDate(meta.created) ?? '—'}</Row>
          <Row label="Modified">{fmtDate(meta.modified) ?? '—'}</Row>

          <Divider />

          <Row label="UUID">
            <span className="meta-panel__uuid">{meta.all?.['uuid'] ?? '—'}</span>
          </Row>
          <PromptReference path={path} />
        </div>
        )
      )}

      {activeTab === 'history' && (
        <div className="meta-panel__fields">
          {versions.length === 0 ? (
            <div className="meta-panel__empty">No historical snapshots found.</div>
          ) : (
            versions.map(ref => (
              <div key={ref.id} style={{ padding: '0.6rem 0.9rem', borderBottom: '1px solid var(--theme-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                  <span style={{ color: 'var(--theme-text)', fontWeight: 600, fontSize: '14px' }}>{ref.id}</span>
                  <span style={{ color: 'var(--theme-textDim)', fontSize: '12px' }}>{fmtDate(ref.created)} • {Math.round(ref.size / 1024)} KB</span>
                </div>
                <button
                  style={{ background: 'var(--theme-bgAlt)', border: '1px solid var(--theme-border2)', color: 'var(--theme-text)', padding: '0.25rem 0.6rem', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--theme-accentPrimary)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'var(--theme-bgAlt)'}
                  onClick={() => {
                    if (window.confirm(`Restore snapshot ${ref.id}?\n\nThis will safely overwrite your current text body, but preserve your live tags and document status.`)) {
                      GetDocumentVersion(path, ref)
                        .then(snap => onRestoreRequested?.(snap.body))
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

      {activeTab === 'assets' && meta && (
        <div className="meta-panel__fields">
          {!meta.assets || meta.assets.length === 0 ? (
            <div className="meta-panel__empty">No owned assets found.</div>
          ) : (
            meta.assets.map(asset => {
              const name = asset.externalRef.split('/').pop() ?? asset.externalRef
              return (
                <div key={asset.externalRef} style={{ padding: '0.6rem 0.9rem', borderBottom: '1px solid var(--theme-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                    <span style={{ color: 'var(--theme-text)', fontWeight: 600, fontSize: '14px' }}>{name}</span>
                    <span style={{ color: 'var(--theme-textDim)', fontSize: '12px' }}>{asset.encoding}</span>
                  </div>
                  <code style={{ fontSize: '11px', color: 'var(--theme-muted)' }}>{asset.externalRef}</code>
                </div>
              )
            })
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

function PromptReference({ path }: { path: string }) {
  if (!path.startsWith('prompt:')) return null
  const type = path.split(':').pop()

  interface VarDef { name: string; desc: string }
  const vars: Record<string, VarDef[]> = {
    'file': [
      { name: '{content}', desc: 'Note body text' },
      { name: '{folder_list}', desc: 'Existing store folders' },
      { name: '{version}', desc: 'Doc version number' },
      { name: '{focus_count}', desc: 'Open frequency' },
      { name: '{created}', desc: 'Creation timestamp' },
      { name: '{modified}', desc: 'Last modified timestamp' },
      { name: '{now}', desc: 'Current timestamp' },
    ],
    'explain': [
      { name: '{type}', desc: 'Detected content type' },
      { name: '{history}', desc: 'Relevant conversation context' },
      { name: '{content}', desc: 'Target text to explain' },
      { name: '{images}', desc: 'List of relevant asset names' },
    ],
    'ask': [
      { name: '{type}', desc: 'Detected content type' },
      { name: '{content}', desc: 'Context document text' },
      { name: '{history}', desc: 'Conversation history' },
      { name: '{question}', desc: 'User question' },
      { name: '{images}', desc: 'List of relevant asset names' },
    ],
    'refine': [
      { name: '{content}', desc: 'The code block text to identify' },
    ],
    'image': [
      { name: '{image_filename}', desc: 'The original filename of the image' },
    ],
  }

  const defs = vars[type ?? ''] ?? []
  if (defs.length === 0) return null

  return (
    <div style={{ padding: '0.8rem 0.9rem', borderTop: '1px solid var(--theme-border)' }}>
      <div style={{ color: 'var(--theme-muted)', fontSize: '11px', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Template variables</div>
      {defs.map(d => (
        <div key={d.name} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.25rem' }}>
          <code style={{ color: 'var(--theme-accentPrimary)', fontSize: '12px', minWidth: '120px' }}>{d.name}</code>
          <span style={{ color: 'var(--theme-textDim)', fontSize: '12px' }}>{d.desc}</span>
        </div>
      ))}
    </div>
  )
}
