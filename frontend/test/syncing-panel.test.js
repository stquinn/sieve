// @ts-check
// SyncingPanel — the plain panel a view of a Digital Note shows while the note
// has no published log: it says the note is syncing, as a status, and carries
// its look as theme variables only.

import { describe, it, expect } from 'vitest'
import { SyncingPanel } from '../src/static/renderers/syncing-panel.js'

describe('SyncingPanel', () => {
  it('says the note is syncing from the tablet, as a status, and no more', () => {
    const panel = new SyncingPanel().element
    expect(panel.getAttribute('role')).toBe('status')
    expect(panel.querySelector('.ink-syncing__title')?.textContent).toBe(SyncingPanel.Words.TITLE)
    expect(panel.textContent).toBe(SyncingPanel.Words.TITLE + SyncingPanel.Words.DETAIL)
    expect(panel.textContent).not.toMatch(/\d/)
  })

  it('colours itself through theme variables alone', () => {
    const colours = SyncingPanel.styles.match(/(?:color|background|border[a-z-]*)\s*:[^;]+/g) || []
    expect(colours.length).toBeGreaterThan(0)
    for (const rule of colours) expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i)
  })
})
