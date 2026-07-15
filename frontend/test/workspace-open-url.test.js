// workspace-open-url.test.js — regression guard for prompt documents failing
// to open. open() drives the chi path-param route /api/note/open/{id}; the Go
// handler assumes a DECODED id (strings.HasPrefix(id, "prompt:")) and
// chi.URLParam does NOT unescape. A `prompt:` uuid must therefore travel the
// path RAW — exactly as the pre-P2.D templates sent `{{.ID}}`. Percent-encoding
// the colon (encodeURIComponent → %3A) makes the prefix check miss and the open
// 404s. All ids are URL-path-safe (hex-hyphen uuids; `prompt:<slug>`), so raw is
// correct. (close no longer uses a path id — it POSTs a JSON id set to
// /api/tabs/close; see shell.test.js's tab-lifecycle suite.)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Workspace pulls its children at module-eval; SieveTab drags in the editor →
// TipTap chain, which the bare test vendor bag can't build. open()/close() only
// touch window.htmx, so stub the children out (surfaces/ai-target pattern).
vi.mock('../src/static/shell/tab.js', () => ({ SieveTab: class {} }))
vi.mock('../src/static/shell/ask-panel.js', () => ({ AskPanel: class {} }))
vi.mock('../src/static/shell/insert-dialogs.js', () => ({ InsertDialogs: class {} }))
vi.mock('../src/static/shell/search-overlay.js', () => ({ SearchOverlay: class {} }))
vi.mock('../src/static/shell/status-bar.js', () => ({ StatusBar: class {} }))

import { SieveWorkspace } from '../src/static/shell/workspace.js'

let ajax

beforeEach(() => {
  ajax = vi.fn(() => Promise.resolve())
  // @ts-ignore — minimal htmx stub; #ajax only touches window.htmx.ajax.
  window.htmx = { ajax }
})

afterEach(() => {
  // @ts-ignore
  delete window.htmx
  vi.restoreAllMocks()
})

describe('SieveWorkspace tab-lifecycle URLs', () => {
  it('opens a prompt document with a RAW (unencoded) path id', () => {
    new SieveWorkspace().open('prompt:file')
    expect(ajax).toHaveBeenCalledWith('POST', '/api/note/open/prompt:file', expect.anything())
  })

  it('leaves plain (URL-safe) note uuids untouched', () => {
    const uuid = '2f1c9a4e-0b7d-4a11-9c3e-6d5f8b2a1e00'
    new SieveWorkspace().open(uuid)
    expect(ajax).toHaveBeenCalledWith('POST', '/api/note/open/' + uuid, expect.anything())
  })
})
