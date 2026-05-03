import React from 'react'
import { cn } from '@/lib/utils'
import type { main } from '../../wailsjs/go/models'
import type { StorableDataService } from '../lib/StorableDataService'
import { UserIntent } from '../types'

interface Props {
  meta: main.DocumentMetaDTO | null
  path: string
  width: number
  isModified: boolean
  isEvaluating?: boolean
  isWaitingAI?: boolean
  versions?: main.VersionRefDTO[]
  onRestoreRequested?: (body: string) => void
  onSetIntent?: (intent: UserIntent) => void
  onSave?: () => Promise<void>
  dataService: StorableDataService
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
  return 'var(--theme-muted)'
}

export function MetaPanel({
  meta, path, width, isModified, isEvaluating, isWaitingAI,
  versions = [], onRestoreRequested, onSetIntent, onSave, dataService
}: Props) {
  const fileName = path.split('/').pop() ?? path
  const [activeTab, setActiveTab] = React.useState<'meta' | 'history' | 'assets'>('meta')
  const [now, setNow] = React.useState(new Date())
  const [pendingRestore, setPendingRestore] = React.useState<main.VersionRefDTO | null>(null)

  React.useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div
      className="flex flex-col flex-shrink-0 overflow-hidden bg-tn-bg-dark border-l border-tn-border text-base"
      style={{ width }}
    >
      {/* Header */}
      <div className="flex items-center justify-between text-[13px] font-semibold uppercase tracking-[0.05em] text-tn-text px-[0.9rem] h-[44px] border-b border-solid border-tn-border shrink-0 bg-tn-bg-dark">
        <div className="flex gap-[1.2rem] h-full">
          {(['meta', 'history', 'assets'] as const).map(tab => {
            if (tab === 'history' && path.startsWith('prompt:')) return null
            if (tab === 'assets' && !meta) return null
            return (
              <span
                key={tab}
                className={cn(
                  'flex items-center cursor-pointer text-[13px] font-semibold transition-colors h-full border-0 border-b-2 border-solid -mb-px',
                  activeTab === tab
                    ? 'text-tn-text border-tn-blue'
                    : 'text-tn-muted border-transparent hover:text-tn-text-dim'
                )}
                onClick={() => setActiveTab(tab)}
              >
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </span>
            )
          })}
        </div>
        {(isEvaluating || isWaitingAI) && (
          <span className="flex items-center gap-[5px] text-[10.5px] font-medium text-tn-cyan opacity-90">
            <span className="w-[7px] h-[7px] shrink-0 rounded-full border-[1.5px] border-solid border-tn-cyan border-t-transparent animate-spin" />
            {isWaitingAI ? 'Thinking' : 'Evaluating'}
          </span>
        )}
      </div>

      {/* Path crumb */}
      <div className="font-mono text-[11px] text-tn-text-dim px-[0.9rem] py-2 whitespace-nowrap overflow-hidden text-ellipsis border-b border-solid border-tn-border shrink-0 bg-tn-bg-dark" title={path}>
        {fileName}
      </div>

      {/* Scrollable content */}
      <div className="flex-1 min-h-0 overflow-y-auto bg-tn-bg-dark">
        {activeTab === 'meta' && (
          !meta ? (
            <>
              <div className="text-xs text-tn-subtle px-[0.9rem] py-[0.6rem] italic">No meta</div>
              <PromptReference path={path} />
            </>
          ) : (
            <div className="py-[0.3rem]">
              {/* Dirty indicator */}
              <div style={{
                padding: '0.5rem 0.9rem',
                marginBottom: '0.5rem',
                border: `1px solid ${isModified ? 'var(--theme-accentYellow)' : 'var(--theme-border)'}`,
                borderRadius: '6px',
                background: isModified ? 'color-mix(in srgb, var(--theme-accentYellow) 10%, transparent)' : 'transparent',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}>
                <span style={{ fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', color: isModified ? 'var(--theme-accentYellow)' : 'var(--theme-textDim)' }}>
                  {isModified ? 'Unsaved Changes' : 'All Changes Saved'}
                </span>
                <div style={{
                  width: '8px', height: '8px', borderRadius: '50%',
                  background: isModified ? 'var(--theme-accentYellow)' : 'var(--theme-accentGreen)',
                  boxShadow: isModified ? '0 0 8px var(--theme-accentYellow)' : 'none',
                }} />
              </div>

              <Row label="Status"><span style={{ color: statusColour(meta.status) }}>{meta.status ?? '—'}</span></Row>
              <Row label="Version">{meta.version ?? '—'}</Row>
              <Row label="Focus count">{meta.focusCount ?? '—'}</Row>
              <Row label="Now"><span style={{ color: 'var(--theme-accentPrimary)' }}>{fmtDate(now.toISOString())}</span></Row>

              <Divider />

              <Row label="User intent"><span style={{ color: intentColour(meta.userIntent) }}>{meta.userIntent ?? 'null'}</span></Row>
              <Row label="AI keep">
                <span style={{ color: meta.aiKeep === true ? 'var(--theme-accentGreen)' : meta.aiKeep === false ? 'var(--theme-accentRed)' : 'inherit', fontWeight: meta.aiKeep === false ? 'bold' : 'normal' }}>
                  {meta.aiKeep === true ? 'keep' : meta.aiKeep === false ? 'discard' : '—'}
                </span>
              </Row>
              <Row label="AI eval"><span style={{ color: evalColour(meta.aiEval) }}>{meta.aiEval ?? '—'}</span></Row>
              <Row label="AI evaluated">{fmtDate(meta.aiLastEvaluated) ?? '—'}</Row>
              <Row label="AI folder">{meta.aiFolderSuggestion ?? '—'}</Row>

              <Divider />

              <Row label="Display name">{meta.displayName ?? '—'}</Row>
              <Row label="Filename">{meta.filename ?? '—'}</Row>
              <Row label="User name">{meta.userSuggestedName ?? '—'}</Row>
              <Row label="CLI">{meta.cli ?? '—'}</Row>

              <Divider />

              <Row label="Summary"><span className="text-tn-text-dim italic text-[15px] leading-[1.5]">{meta.summary ?? '—'}</span></Row>

              {meta.tags && meta.tags.length > 0 ? (
                <div className="flex px-[0.9rem] py-[0.18rem] gap-[0.4rem] items-start">
                  <span className="text-tn-text-dim shrink-0 w-[7.5rem] text-[15px] pt-[0.05rem] font-medium">Tags</span>
                  <div className="flex flex-wrap gap-1 flex-1">
                    {meta.tags.map(t => <Tag key={t}>{t}</Tag>)}
                  </div>
                </div>
              ) : (
                <Row label="Tags">—</Row>
              )}

              <Row label="AI why"><span className="text-tn-text-dim italic text-[15px] leading-[1.5]">{meta.aiJustification ?? '—'}</span></Row>

              {meta.densitySignals && meta.densitySignals.length > 0 ? (
                <div className="flex px-[0.9rem] py-[0.18rem] gap-[0.4rem] items-start">
                  <span className="text-tn-text-dim shrink-0 w-[7.5rem] text-[15px] pt-[0.05rem] font-medium">Density</span>
                  <div className="flex flex-wrap gap-1 flex-1">
                    {meta.densitySignals.map(s => <Tag key={s}>{s}</Tag>)}
                  </div>
                </div>
              ) : (
                <Row label="Density">—</Row>
              )}

              <Divider />

              <Row label="Created">{fmtDate(meta.created) ?? '—'}</Row>
              <Row label="Modified">{fmtDate(meta.modified) ?? '—'}</Row>

              <Divider />

              <Row label="UUID">
                <span className="font-mono text-[11px] text-tn-muted break-all select-all">{meta.all?.['uuid'] ?? '—'}</span>
              </Row>
              <PromptReference path={path} />
            </div>
          )
        )}

        {activeTab === 'history' && (
          <div className="py-[0.3rem]">
            {versions.length === 0 ? (
              <div className="text-xs text-tn-subtle px-[0.9rem] py-[0.6rem] italic">No historical snapshots found.</div>
            ) : (
              versions.map(ref => (
                <div key={ref.id} style={{ padding: '0.6rem 0.9rem', borderBottom: '1px solid var(--theme-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                    <span style={{ color: 'var(--theme-text)', fontWeight: 600, fontSize: '14px' }}>{ref.id}</span>
                    <span style={{ color: 'var(--theme-textDim)', fontSize: '12px' }}>{fmtDate(ref.created)} • {Math.round(ref.size / 1024)} KB</span>
                  </div>
                  {pendingRestore?.id === ref.id ? (
                    <div style={{ display: 'flex', gap: '0.4rem' }}>
                      <button
                        style={{ background: 'var(--theme-bgAlt)', border: '1px solid var(--theme-border2)', color: 'var(--theme-textDim)', padding: '0.25rem 0.6rem', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}
                        onClick={() => setPendingRestore(null)}
                      >Cancel</button>
                      <button
                        style={{ background: 'var(--theme-accentRed)', border: 'none', color: '#fff', padding: '0.25rem 0.6rem', borderRadius: '4px', cursor: 'pointer', fontSize: '13px', fontWeight: 600 }}
                        onClick={() => {
                          setPendingRestore(null)
                          dataService.getDocumentVersion(path, ref)
                            .then(snap => onRestoreRequested?.(snap.body))
                            .catch(console.error)
                        }}
                      >Confirm</button>
                    </div>
                  ) : (
                    <button
                      style={{ background: 'var(--theme-bgAlt)', border: '1px solid var(--theme-border2)', color: 'var(--theme-text)', padding: '0.25rem 0.6rem', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--theme-accentPrimary)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'var(--theme-bgAlt)'}
                      onClick={() => setPendingRestore(ref)}
                    >Restore</button>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {activeTab === 'assets' && meta && (
          <div className="py-[0.3rem]">
            {!meta.assets || meta.assets.length === 0 ? (
              <div className="text-xs text-tn-subtle px-[0.9rem] py-[0.6rem] italic">No owned assets found.</div>
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
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex px-[0.9rem] py-[0.18rem] gap-[0.4rem] leading-[1.5]">
      <span className="text-tn-text-dim shrink-0 w-[7.5rem] text-[15px] pt-[0.05rem] font-medium">{label}</span>
      <span className="text-tn-text text-base break-words flex-1">{children}</span>
    </div>
  )
}

function Divider() {
  return <div className="h-px bg-tn-border my-[0.3rem]" />
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="bg-tn-bg-alt border border-solid border-tn-border-2 rounded-[3px] text-tn-blue text-[10px] px-[0.35rem] py-[0.05rem] whitespace-nowrap">
      {children}
    </span>
  )
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
      <div style={{ color: 'var(--theme-muted)', fontSize: '11px', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Template variables
      </div>
      {defs.map(d => (
        <div key={d.name} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.25rem' }}>
          <code style={{ color: 'var(--theme-accentPrimary)', fontSize: '12px', minWidth: '120px' }}>{d.name}</code>
          <span style={{ color: 'var(--theme-textDim)', fontSize: '12px' }}>{d.desc}</span>
        </div>
      ))}
    </div>
  )
}
