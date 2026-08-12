// status-bar.test.js — P4.D. The status bar as a Workspace child: it owns the
// static .status-bar slots (__save/__blockid/__stats + #meta-dirty-dot), consumes
// the editor `stats` stream event, the sieve:meta-dirty save paint, and the
// editor:blockhover readout, and RE-POINTS its stats subscription on
// onActiveTabChanged. Headless (happy-dom); a fake workspace + fake editor stream.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StatusBar } from '../src/static/shell/status-bar.js'

// Build the static status-bar DOM the child wires (index.html shape).
function mountStatusDom() {
  document.body.innerHTML = `
    <div class="status-bar">
      <div class="status-bar__save"></div>
      <div class="status-bar__blockid"></div>
      <div class="status-bar__stats"></div>
    </div>
    <span id="meta-dirty-dot" class="bg-tn-green"></span>
  `
}

// A fake workspace exposing the onActiveTabChanged registry + a settable activeTab.
function fakeWorkspace() {
  let activeCb = null
  const ws = {
    _tab: null,
    get activeTab() { return this._tab },
    onActiveTabChanged(fn) { activeCb = fn; return () => { activeCb = null } },
    setActive(tab) { this._tab = tab; if (activeCb) activeCb(tab) },
  }
  return ws
}

// A fake editor exposing a pull-able stats() (StatusBar pull-seeds on point when an
// editor is already present). `seed` is what stats() returns.
function fakeEditor(seed = { chars: 0, lines: 0, blockCount: 0 }) {
  return { stats: () => seed }
}

// A fake TAB mirroring SieveTab's tab-level stats forward: StatusBar subscribes to
// tab.onStats (survives an editor that attaches after the tab is active). fireStats
// simulates the editor's `stats` event being forwarded through the tab.
function fakeTab(editor = null) {
  let statsListeners = []
  return {
    editor,
    onStats(fn) { statsListeners.push(fn); return () => { statsListeners = statsListeners.filter((l) => l !== fn) } },
    fireStats: (chars, lines, blockCount) => statsListeners.forEach((fn) => fn({ chars, lines, blockCount })),
  }
}

afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks() })

describe('StatusBar (P4.D)', () => {
  it('constructs headless-safe with no status DOM (all writes no-op)', () => {
    document.body.innerHTML = ''
    const ws = fakeWorkspace()
    expect(() => {
      const sb = new StatusBar(ws)
      document.dispatchEvent(new CustomEvent('sieve:meta-dirty', { detail: { dirty: true } }))
      document.dispatchEvent(new CustomEvent('editor:blockhover', { detail: { id: 'x' } }))
      void sb
    }).not.toThrow()
  })

  it('a stats event from the active tab writes chars/lines and sets --line-digits', () => {
    mountStatusDom()
    const ws = fakeWorkspace()
    const tab = fakeTab(fakeEditor())
    ws._tab = tab
    new StatusBar(ws) // points at the active tab in the constructor
    tab.fireStats(42, 3, 128)
    const stats = document.querySelector('.status-bar__stats')
    expect(stats.innerHTML).toContain('42 chars')
    expect(stats.innerHTML).toContain('3 lines')
    expect(document.documentElement.style.getPropertyValue('--line-digits')).toBe('3') // "128" → 3 digits
  })

  it('COLD BOOT: subscribes at the TAB level, so a stats seed emitted AFTER the editor attaches still paints', () => {
    mountStatusDom()
    const ws = fakeWorkspace()
    const tab = fakeTab(null) // active tab has NO editor yet (openTab precedes attachEditor)
    ws._tab = tab
    new StatusBar(ws) // subscribes tab.onStats; no editor to pull-seed from yet
    expect(document.querySelector('.status-bar__stats').innerHTML).toBe('') // nothing until the seed
    // The editor attaches and its initial-present stats seed is forwarded via the tab.
    tab.fireStats(1228, 14, 3)
    expect(document.querySelector('.status-bar__stats').innerHTML).toContain('1228 chars')
  })

  it('sieve:meta-dirty paints Unsaved(red)/Saved(green) on the save slot + dot', () => {
    mountStatusDom()
    new StatusBar(fakeWorkspace())
    document.dispatchEvent(new CustomEvent('sieve:meta-dirty', { detail: { dirty: true } }))
    const save = document.querySelector('.status-bar__save')
    const dot = document.getElementById('meta-dirty-dot')
    expect(save.innerHTML).toContain('Unsaved')
    expect(save.innerHTML).toContain('bg-tn-red')
    expect(dot.classList.contains('bg-tn-red')).toBe(true)
    expect(dot.classList.contains('bg-tn-green')).toBe(false)
    document.dispatchEvent(new CustomEvent('sieve:meta-dirty', { detail: { dirty: false } }))
    expect(save.innerHTML).toContain('Saved')
    expect(dot.classList.contains('bg-tn-green')).toBe(true)
  })

  // Block ids are UUIDs (#75). The slot shows kind + the id's TAIL: a UUIDv7 leads
  // with a millisecond timestamp, so every block minted in one session shares its
  // head and a head-truncated readout is uniform noise.
  it('editor:blockhover writes kind and the id TAIL, not the head', () => {
    mountStatusDom()
    new StatusBar(fakeWorkspace())
    const uuid = '019ff755-fcdc-7c95-9a2e-aa791ea970cb'
    document.dispatchEvent(new CustomEvent('editor:blockhover', { detail: { id: uuid, kind: 'code' } }))
    const slot = document.querySelector('.status-bar__blockid')
    expect(slot.textContent).toContain('code·')
    expect(slot.textContent).toContain('a970cb')
    expect(slot.textContent).not.toContain('019ff755')
    // The full id stays reachable for copy/report.
    expect(slot.title).toContain(uuid)
  })

  it('a short legacy handle is shown verbatim — truncating it would lose signal', () => {
    mountStatusDom()
    new StatusBar(fakeWorkspace())
    document.dispatchEvent(new CustomEvent('editor:blockhover', { detail: { id: 'pr-3f2a', kind: 'prose' } }))
    expect(document.querySelector('.status-bar__blockid').textContent).toContain('pr-3f2a')
  })

  // The readout must SURVIVE the pointer leaving the block: the slot is
  // click-to-copy, and one that blanked on mouse-out could never be reached.
  it('a null hover keeps the last readout so the slot stays clickable', () => {
    mountStatusDom()
    new StatusBar(fakeWorkspace())
    const uuid = '019ff755-fcdc-7c95-9a2e-aa791ea970cb'
    document.dispatchEvent(new CustomEvent('editor:blockhover', { detail: { id: uuid, kind: 'code' } }))
    const slot = document.querySelector('.status-bar__blockid')
    const painted = slot.textContent
    document.dispatchEvent(new CustomEvent('editor:blockhover', { detail: null }))
    expect(slot.textContent).toBe(painted)
  })

  it('clicking the slot copies the FULL id, not the displayed tail', async () => {
    mountStatusDom()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    new StatusBar(fakeWorkspace())
    const uuid = '019ff755-fcdc-7c95-9a2e-aa791ea970cb'
    document.dispatchEvent(new CustomEvent('editor:blockhover', { detail: { id: uuid, kind: 'code' } }))
    document.querySelector('.status-bar__blockid').click()
    await Promise.resolve()
    expect(writeText).toHaveBeenCalledWith(uuid)
    vi.unstubAllGlobals()
  })

  it('clicking with nothing hovered copies nothing', () => {
    mountStatusDom()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    new StatusBar(fakeWorkspace())
    document.querySelector('.status-bar__blockid').click()
    expect(writeText).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('RE-POINTS on onActiveTabChanged: the new editor drives stats, the old one is dropped', () => {
    mountStatusDom()
    const ws = fakeWorkspace()
    const tabA = fakeTab(fakeEditor())
    const tabB = fakeTab(fakeEditor())
    ws._tab = tabA
    new StatusBar(ws)
    tabA.fireStats(1, 1, 1)
    expect(document.querySelector('.status-bar__stats').innerHTML).toContain('1 chars')
    // Switch to B: A must be unsubscribed, B live.
    ws.setActive(tabB)
    // Re-point PULL-seeds tabB's current stats immediately (tabB editor default → 0 chars).
    expect(document.querySelector('.status-bar__stats').innerHTML).toContain('0 chars')
    tabB.fireStats(9, 2, 5)
    expect(document.querySelector('.status-bar__stats').innerHTML).toContain('9 chars')
    // A late push from the OLD tab is ignored (unsubscribed).
    tabA.fireStats(777, 7, 7)
    expect(document.querySelector('.status-bar__stats').innerHTML).toContain('9 chars')
  })

  it('re-point to a tab with no editor yet does not throw (null-guarded)', () => {
    mountStatusDom()
    const ws = fakeWorkspace()
    new StatusBar(ws)
    expect(() => ws.setActive(fakeTab(null))).not.toThrow() // tab present, editor not yet
    expect(() => ws.setActive(null)).not.toThrow()          // no tab at all
  })

  it('PULL-seeds stats on point when an editor is already present (a tab switch after boot)', () => {
    mountStatusDom()
    const ws = fakeWorkspace()
    const tab = fakeTab(fakeEditor({ chars: 5, lines: 2, blockCount: 1 }))
    ws._tab = tab
    new StatusBar(ws) // editor already present → pull-seed via tab.editor.stats(), no emit needed
    const slot = document.querySelector('.status-bar__stats')
    expect(slot.innerHTML).toContain('5 chars')
    expect(slot.innerHTML).toContain('2 lines')
  })
})
