import { useEffect } from 'react'
import type React from 'react'
import { SaveBuffer, Quit as AppQuit } from '../../wailsjs/go/main/App'
import { EventsOn, EventsOff, Quit } from '../../wailsjs/runtime/runtime'
import type { TabState } from '../types'
import type { main } from '../../wailsjs/go/models'
import type { StorableDataService } from '../lib/StorableDataService'

interface UseAppLifecycleParams {
  activeIdx: number
  tabs: TabState[]
  tabsRef: React.MutableRefObject<TabState[]>
  activeIdxRef: React.MutableRefObject<number>
  tierRef: React.MutableRefObject<'dumb' | 'smart'>
  evaluatingUuids: React.MutableRefObject<Set<string>>
  pendingAiCount: React.MutableRefObject<number>
  cliTimeoutLongMs: React.MutableRefObject<number>
  // Pass the ref, not the closure — app:closing fires long after render
  flushRef: React.MutableRefObject<() => void>
  focusTimer: React.MutableRefObject<ReturnType<typeof setTimeout> | null>
  persistSession: () => Promise<void>
  persistSessionRef: React.MutableRefObject<() => Promise<void>>
  setPendingClose: React.Dispatch<React.SetStateAction<boolean>>
  ds: StorableDataService
}

export function useAppLifecycle({
  activeIdx,
  tabs,
  tabsRef,
  activeIdxRef,
  tierRef,
  evaluatingUuids,
  pendingAiCount,
  cliTimeoutLongMs,
  flushRef,
  focusTimer,
  persistSession,
  persistSessionRef,
  setPendingClose,
  ds,
}: UseAppLifecycleParams) {
  // ── App close handler ──────────────────────────────────────────────────────
  useEffect(() => {
    const unlistenClosing = EventsOn('app:closing', async () => {
      console.log('[stash] shutdown: app:closing received, flushing state...')

      await flushRef.current()

      const activeTabAtShutdown = tabsRef.current[activeIdxRef.current]
      const otherTabs = tabsRef.current.filter(t => t.uuid !== activeTabAtShutdown?.uuid && !t.isVirtual)
      if (otherTabs.length > 0) {
        console.log('[stash] shutdown: flushing', otherTabs.length, 'background tab(s)...')
        await Promise.all(otherTabs.map(async (t) => {
          await ds.save(t.uuid).catch(console.error)
        }))
      }

      const doQuit = async () => {
        await persistSessionRef.current()
          .then(() => console.log('[stash] shutdown: session saved'))
          .catch(err => console.error('[stash] shutdown: save failed', err))
          .finally(() => {
            console.log('[stash] shutdown: calling backend AppQuit')
            AppQuit().catch(err => {
              console.error('[stash] shutdown: AppQuit failed, forcing runtime Quit', err)
              Quit()
            })
          })
      }

      const totalJobs = evaluatingUuids.current.size + pendingAiCount.current
      if (totalJobs === 0) {
        doQuit()
        return
      }

      console.log('[stash] shutdown: waiting for', totalJobs, 'AI job(s)...')
      setPendingClose(true)
      const deadline = Date.now() + cliTimeoutLongMs.current
      const poll = setInterval(() => {
        const remaining = evaluatingUuids.current.size + pendingAiCount.current
        if (remaining === 0 || Date.now() >= deadline) {
          clearInterval(poll)
          setPendingClose(false)
          if (remaining > 0) {
            console.warn('[stash] shutdown: timed out waiting for AI jobs, quitting anyway')
          }
          doQuit()
        }
      }, 200)
    })

    return () => { EventsOff('app:closing') }
  }, [])

  // ── Focus count tracking ───────────────────────────────────────────────────
  useEffect(() => {
    if (focusTimer.current) clearTimeout(focusTimer.current)
    const tab = tabs[activeIdx]
    if (!tab) return
    const uuid = tab.uuid

    const bumpFocusCount = () => {
      const currentTab = tabsRef.current.find(t => t.uuid === uuid)
      if (!currentTab) return
      
      const doc = ds.get(uuid)
      if (!doc || !doc.meta) return

      ds.setMeta(uuid, { ...doc.meta, focusCount: (doc.meta.focusCount ?? 0) + 1 })
      ds.save(uuid).catch(console.error)
      console.debug('[stash] focus_count: incremented', { uuid, path: doc.path })
    }

    focusTimer.current = setTimeout(bumpFocusCount, 30 * 1000)

    const dwellInterval = setInterval(() => {
      if (activeIdxRef.current !== activeIdx) return
      bumpFocusCount()
    }, 5 * 60 * 1000)

    return () => {
      if (focusTimer.current) { clearTimeout(focusTimer.current); focusTimer.current = null }
      clearInterval(dwellInterval)
    }
  }, [activeIdx])
}
