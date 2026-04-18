import { useEffect } from 'react'
import type React from 'react'
import { SaveBuffer, Quit as AppQuit } from '../../wailsjs/go/main/App'
import { EventsOn, EventsOff, Quit } from '../../wailsjs/runtime/runtime'
import type { TabState } from '../types'
import { bumpFocusCount } from '../lib/fmUtils'

interface UseAppLifecycleParams {
  activeIdx: number
  tabs: TabState[]
  tabsRef: React.MutableRefObject<TabState[]>
  activeTabRef: React.MutableRefObject<TabState | undefined>
  activeIdxRef: React.MutableRefObject<number>
  fmCache: React.MutableRefObject<Record<string, string>>
  savedBodyCache: React.MutableRefObject<Record<string, string>>
  mdCache: React.MutableRefObject<Record<string, string>>
  evaluatingUuids: React.MutableRefObject<Set<string>>
  pendingAiCount: React.MutableRefObject<number>
  cliTimeoutLongMs: React.MutableRefObject<number>
  // Pass the ref, not the closure — app:closing fires long after render
  flushRef: React.MutableRefObject<() => void>
  focusTimer: React.MutableRefObject<ReturnType<typeof setTimeout> | null>
  saveBufferSafe: (uuid: string, content: string) => void
  persistSession: () => Promise<void>
  setPendingClose: React.Dispatch<React.SetStateAction<boolean>>
}

export function useAppLifecycle({
  activeIdx,
  tabs,
  tabsRef,
  activeTabRef,
  activeIdxRef,
  fmCache,
  savedBodyCache,
  mdCache,
  evaluatingUuids,
  pendingAiCount,
  cliTimeoutLongMs,
  flushRef,
  focusTimer,
  saveBufferSafe,
  persistSession,
  setPendingClose,
}: UseAppLifecycleParams) {
  // ── App close handler ──────────────────────────────────────────────────────
  useEffect(() => {
    const unlistenClosing = EventsOn('app:closing', async () => {
      console.log('[stash] shutdown: app:closing received, flushing state...')

      await flushRef.current()

      const otherTabs = tabsRef.current.filter(t => t.uuid !== activeTabRef.current?.uuid && !t.isVirtual)
      if (otherTabs.length > 0) {
        console.log('[stash] shutdown: flushing', otherTabs.length, 'background tab(s)...')
        await Promise.all(otherTabs.map(async (t) => {
          const uuid = t.uuid
          const body = savedBodyCache.current[uuid] ?? ''
          const fm   = fmCache.current[uuid] ?? ''
          const raw  = mdCache.current[uuid]

          if (raw) {
            await SaveBuffer(t.path, raw).catch(console.error)
          } else if (body || fm) {
            await SaveBuffer(t.path, fm + body).catch(console.error)
          }
        }))
      }

      const doQuit = async () => {
        await persistSession()
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
    const path = tab.path

    focusTimer.current = setTimeout(() => {
      const currentTab = tabsRef.current.find(t => t.path === path)
      if (!currentTab || !currentTab.uuid) return
      const fm = fmCache.current[currentTab.uuid]
      if (!fm) return
      const newFm = bumpFocusCount(fm)
      fmCache.current[currentTab.uuid] = newFm
      const body = savedBodyCache.current[currentTab.uuid] ?? ''
      saveBufferSafe(currentTab.uuid, newFm + body)
      console.debug('[stash] focus_count: visit incremented', { path })
    }, 30 * 1000)

    const dwellInterval = setInterval(() => {
      if (activeIdxRef.current !== activeIdx) return
      const currentTab = tabsRef.current[activeIdx]
      if (!currentTab || !currentTab.uuid) return
      const fm = fmCache.current[currentTab.uuid]
      if (!fm) return
      const newFm = bumpFocusCount(fm)
      fmCache.current[currentTab.uuid] = newFm
      const body = savedBodyCache.current[currentTab.uuid] ?? ''
      saveBufferSafe(currentTab.uuid, newFm + body)
      console.debug('[stash] focus_count: dwell interval incremented', { path })
    }, 5 * 60 * 1000)

    return () => {
      if (focusTimer.current) { clearTimeout(focusTimer.current); focusTimer.current = null }
      clearInterval(dwellInterval)
    }
  }, [activeIdx])
}
