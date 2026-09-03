// workspace-boot.test.js — regression guard for `676272d`, the bug where a page
// that loaded and was then left alone heard NOTHING from the server.
//
// Retiring SSE moved every server-initiated signal (the five invalidation
// topics, the jobs snapshot) onto the workspace channel, but nothing in the boot
// sequence dialled it: `WorkspaceService.open()` was reachable only from
// `send()`, so the socket existed only as a side effect of the user having
// spoken first. The failure is silent — the sidebar, tab strip and job badge
// simply keep whatever seeded them and never refresh.
//
// The fix's dial sits behind `typeof WebSocket === 'function'`, and the headless
// DOM has no WebSocket, so no other test in this suite EXECUTES that branch: the
// bug could be reintroduced and every existing test would still pass. This file
// stubs the global and re-imports the module so the branch actually runs.

import { describe, it, expect, afterEach, vi } from 'vitest'

// Workspace pulls its children at module-eval; SieveTab drags in the editor →
// TipTap chain, which the bare test vendor bag can't build (workspace-open-url
// pattern). None of them participates in the dial.
vi.mock('../src/static/shell/tab.js', () => ({ SieveTab: class {} }))
vi.mock('../src/static/shell/ask-panel.js', () => ({ AskPanel: class {} }))
vi.mock('../src/static/shell/insert-dialogs.js', () => ({ InsertDialogs: class {} }))
vi.mock('../src/static/shell/find-dialog.js', () => ({ FindDialog: class {} }))
vi.mock('../src/static/shell/status-bar.js', () => ({ StatusBar: class {} }))

describe('the page dials the push channel at boot', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.resetModules()
    // @ts-ignore — the module's singleton assignment
    delete window.sieveWorkspace
    // @ts-ignore
    delete window.htmx
  })

  /**
   * Imports shell/workspace.js FRESH with a stubbed WebSocket global, and
   * reports what the module load did on the wire.
   */
  async function bootTheModule() {
    /** @type {string[]} */ const dialled = []
    // The tabbar's refresh subscription is the marker for "the tenants are
    // registered": it is installed by startTabbar, which the fix requires to run
    // BEFORE the dial, because the server writes the jobs snapshot the instant
    // the socket connects and unclaimed frames are dropped.
    let tabbarSubscribed = false
    const add = document.addEventListener.bind(document)
    vi.spyOn(document, 'addEventListener').mockImplementation((t, f, o) => {
      if (t === 'sieve:invalidate-session') tabbarSubscribed = true
      return add(t, f, o)
    })

    /** @type {boolean[]} */ const subscribedAtDial = []
    class BootSocket {
      /** @param {string} url */
      constructor(url) {
        dialled.push(url)
        subscribedAtDial.push(tabbarSubscribed)
        this.readyState = 0
        this.onopen = null
        this.onmessage = null
        this.onclose = null
        this.onerror = null
      }
      send() {}
      close() {}
    }
    vi.stubGlobal('WebSocket', BootSocket)
    // @ts-ignore — the boots reach for htmx; a stub keeps the load quiet.
    window.htmx = { ajax: vi.fn(() => Promise.resolve()) }

    vi.resetModules()
    await import('../src/static/shell/workspace.js')
    return { dialled, subscribedAtDial }
  }

  it('constructs the workspace socket at module load, with no user action at all', async () => {
    const { dialled } = await bootTheModule()
    expect(dialled.filter((u) => u.endsWith('/api/ws/workspace'))).toHaveLength(1)
  })

  it('dials only AFTER the tenants are registered, or the first frames land unclaimed', async () => {
    const { subscribedAtDial } = await bootTheModule()
    expect(subscribedAtDial).toEqual([true])
  })
})
