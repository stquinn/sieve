// tabbar-overflow.test.js — the tab-bar overflow dropdown and the seating of an
// active tab rendered past the fold. Tabs must be NON-SHRINKING (fixed width)
// for the detector to ever see a tab's right edge pass the (overflow-hidden)
// area's edge; this pins the detector's fire condition, the dropdown it opens,
// and the moves seating asks of the reorder verb (the rule is TabSeating's,
// tab-seating.test.js).

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
    win.sieveWorkspace = { open: vi.fn(), close: vi.fn(), reorder: vi.fn(() => Promise.resolve()) }
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

  it('opens a list of the hidden tabs and activates one via window.sieveWorkspace.open, moving nothing itself', async () => {
    const { area, overflowBtn } = renderTabbar(6)
    stubLayout(area, 900, 4)
    await import('../src/static/ui/tabbar.js')

    overflowBtn.click()
    const dropdown = document.getElementById('tab-overflow-dropdown')
    expect(dropdown).not.toBeNull()
    const rows = /** @type {NodeListOf<HTMLButtonElement>} */ (dropdown?.querySelectorAll('button'))
    expect(Array.from(rows).map((r) => r.textContent)).toEqual(['Tab 4', 'Tab 5'])

    rows[0].click()
    expect(/** @type {any} */ (window).sieveWorkspace.open).toHaveBeenCalledWith('uuid-4')
    expect(/** @type {any} */ (window).sieveWorkspace.reorder).not.toHaveBeenCalled()
    expect(document.getElementById('tab-overflow-dropdown')).toBeNull()
  })

  it('seats an active tab rendered past the fold in the last visible slot, in place of the least recently viewed', async () => {
    const { area } = renderTabbar(6)
    const tabs = /** @type {NodeListOf<HTMLElement>} */ (area.querySelectorAll('[data-tab-idx]'))
    ;['50', '10', '30', '40', '0', '60'].forEach((viewed, i) => { tabs[i].dataset.tabViewed = viewed })
    tabs[5].dataset.tabActive = 'true'
    stubLayout(area, 900, 4)
    await import('../src/static/ui/tabbar.js')
    await new Promise((r) => setTimeout(r, 0))
    const reorder = /** @type {any} */ (window).sieveWorkspace.reorder
    expect(reorder.mock.calls).toEqual([[1, 4], [5, 3]])
  })

  it('leaves a strip refetched after the first alone, and seats one this window\'s own request rendered', async () => {
    const { area } = renderTabbar(6)
    stubLayout(area, 900, 4)
    await import('../src/static/ui/tabbar.js')
    const reorder = /** @type {any} */ (window).sieveWorkspace.reorder
    const render = (/** @type {string} */ verb) => {
      const tabs = /** @type {NodeListOf<HTMLElement>} */ (area.querySelectorAll('[data-tab-idx]'))
      tabs.forEach((t) => { delete t.dataset.tabActive })
      tabs[5].dataset.tabActive = 'true'
      const target = document.createElement('div')
      target.id = 'htmx-tabbar'
      document.dispatchEvent(new CustomEvent('htmx:afterSettle', { detail: { target, requestConfig: { verb } } }))
    }
    render('get')
    await new Promise((r) => setTimeout(r, 0))
    expect(reorder).not.toHaveBeenCalled()
    render('post')
    await new Promise((r) => setTimeout(r, 0))
    expect(reorder).toHaveBeenCalled()
  })

  it('leaves a visible active tab where it is', async () => {
    const { area } = renderTabbar(6)
    ;/** @type {HTMLElement} */ (area.querySelectorAll('[data-tab-idx]')[2]).dataset.tabActive = 'true'
    stubLayout(area, 900, 4)
    await import('../src/static/ui/tabbar.js')
    await new Promise((r) => setTimeout(r, 0))
    expect(/** @type {any} */ (window).sieveWorkspace.reorder).not.toHaveBeenCalled()
  })
})
