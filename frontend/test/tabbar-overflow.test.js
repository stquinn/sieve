// tabbar-overflow.test.js — #122: the tab-bar overflow dropdown. Tabs must be
// NON-SHRINKING (fixed width) for the detector to ever see a tab's right edge
// pass the (overflow-hidden) area's edge; this pins the detector's fire
// condition and the dropdown it opens, both regressed by 0d68547's shrinking
// tab wrappers.

import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Builds the tabbar DOM tabbar.html renders, with `count` tab wrappers.
 * @param {number} count
 * @returns {{ area: HTMLElement, overflowWrap: HTMLElement, overflowBtn: HTMLElement }}
 */
function renderTabbar(count) {
  document.body.innerHTML = `
    <div id="tabs-area" class="flex items-stretch shrink overflow-hidden min-w-0"></div>
    <div id="tab-overflow" class="relative shrink-0" style="display:none">
      <button id="tab-overflow-btn">▼ 0</button>
    </div>
  `
  const area = /** @type {HTMLElement} */ (document.getElementById('tabs-area'))
  for (let i = 0; i < count; i++) {
    const tab = document.createElement('div')
    tab.dataset.tabId = 'uuid-' + i
    tab.dataset.tabIdx = String(i)
    tab.dataset.ctxName = 'Tab ' + i
    area.appendChild(tab)
  }
  return {
    area,
    overflowWrap: /** @type {HTMLElement} */ (document.getElementById('tab-overflow')),
    overflowBtn: /** @type {HTMLElement} */ (document.getElementById('tab-overflow-btn')),
  }
}

/**
 * Stubs getBoundingClientRect so the first `visible` tabs sit inside
 * `areaRight` and every tab after that overflows past it — the ONLY condition
 * the detector checks.
 * @param {HTMLElement} area @param {number} areaRight @param {number} visible
 */
function stubLayout(area, areaRight, visible) {
  area.getBoundingClientRect = () => /** @type {any} */ ({ right: areaRight })
  const tabs = area.querySelectorAll('[data-tab-idx]')
  tabs.forEach((tab, i) => {
    const right = i < visible ? areaRight - 10 : areaRight + 50 + i
    const el = /** @type {any} */ (tab)
    el.getBoundingClientRect = () => ({ right })
  })
}

describe('tab-bar overflow detector and dropdown (#122)', () => {
  beforeEach(() => {
    vi.resetModules()
    document.body.innerHTML = ''
    const win = /** @type {any} */ (window)
    win.sieveWorkspace = { open: vi.fn(), close: vi.fn(), reorder: vi.fn() }
  })

  it('stays hidden when every tab fits inside the area', async () => {
    const { area, overflowWrap } = renderTabbar(4)
    stubLayout(area, 900, 4)
    await import('../src/static/ui/tabbar.js')
    expect(overflowWrap.style.display).toBe('none')
  })

  it('fires and reports the hidden count once a tab overflows the area', async () => {
    const { area, overflowWrap, overflowBtn } = renderTabbar(6)
    stubLayout(area, 900, 4)
    await import('../src/static/ui/tabbar.js')
    expect(overflowWrap.style.display).toBe('flex')
    expect(overflowBtn.textContent).toBe('▼ 2')
  })

  it('opens a list of the hidden tabs and activates one via window.sieveWorkspace.open', async () => {
    const { area, overflowBtn } = renderTabbar(6)
    stubLayout(area, 900, 4)
    await import('../src/static/ui/tabbar.js')

    overflowBtn.click()
    const dropdown = document.getElementById('tab-overflow-dropdown')
    expect(dropdown).not.toBeNull()
    const rows = /** @type {NodeListOf<HTMLButtonElement>} */ (dropdown?.querySelectorAll('button'))
    expect(Array.from(rows).map((r) => r.textContent)).toEqual(['Tab 4', 'Tab 5'])

    rows[0].click()
    // Summoning a hidden tab SEATS it in the last visible slot first (the strip
    // does not scroll, so visibility is a position), and ACTIVATES it only once
    // the move settles — the reorder is index-based, so opening mid-move can
    // land on whichever tab slid into the old slot.
    expect(/** @type {any} */ (window).sieveWorkspace.reorder).toHaveBeenCalledWith(4, 3)
    expect(/** @type {any} */ (window).sieveWorkspace.open).not.toHaveBeenCalled()
    await new Promise((r) => setTimeout(r, 0))
    expect(/** @type {any} */ (window).sieveWorkspace.open).toHaveBeenCalledWith('uuid-4')
    expect(document.getElementById('tab-overflow-dropdown')).toBeNull()
  })
})
