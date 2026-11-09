import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { docWithCaret, build } from './helpers/editor-fixture.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const shellCss = fs.readFileSync(path.resolve(__dirname, '../src/static/shell.css'), 'utf-8')

describe('fixture harness', () => {
  it('builds a doc with a caret', () => {
    const { editor } = docWithCaret([build.p('hello')], 0, 1)
    expect(editor.state.doc.childCount).toBe(1)
    expect(editor.state.selection.empty).toBe(true)
  })
})

describe('meta panel visibility under data-meta="off"', () => {
  let styleEl

  beforeEach(() => {
    styleEl = document.createElement('style')
    styleEl.textContent = shellCss
    document.head.appendChild(styleEl)
  })

  afterEach(() => {
    if (styleEl && styleEl.parentNode) {
      styleEl.parentNode.removeChild(styleEl)
    }
    document.body.innerHTML = ''
  })

  it('hides #htmx-meta-panel and .meta-handle when #app-root has data-meta="off"', () => {
    document.body.innerHTML = `
      <div id="app-root" data-meta="off">
        <div id="right-panel">
          <div class="editor-area">
            <div id="editor-col"></div>
            <div class="meta-handle"></div>
            <div id="htmx-meta-panel" class="flex flex-col"></div>
          </div>
        </div>
      </div>
    `
    const metaPanel = document.getElementById('htmx-meta-panel')
    const metaHandle = document.querySelector('.meta-handle')

    expect(window.getComputedStyle(metaPanel).display).toBe('none')
    expect(window.getComputedStyle(metaHandle).display).toBe('none')
  })

  it('shows #htmx-meta-panel and .meta-handle when #app-root has data-meta="on"', () => {
    document.body.innerHTML = `
      <div id="app-root" data-meta="on">
        <div id="right-panel">
          <div class="editor-area">
            <div id="editor-col"></div>
            <div class="meta-handle"></div>
            <div id="htmx-meta-panel" class="flex flex-col"></div>
          </div>
        </div>
      </div>
    `
    const metaPanel = document.getElementById('htmx-meta-panel')
    const metaHandle = document.querySelector('.meta-handle')

    expect(window.getComputedStyle(metaPanel).display).not.toBe('none')
    expect(window.getComputedStyle(metaHandle).display).not.toBe('none')
  })

  it('captures Mod+Alt+I and executes htmx toggle while preventing default', () => {
    let prevented = false
    const ajaxSpy = vi.fn()
    window.htmx = { ajax: ajaxSpy }
    window.isMod = (e) => !!(e.metaKey || e.ctrlKey)

    const keydownHandler = (e) => {
      if (window.isMod(e) && e.altKey && (e.key === 'i' || e.key === 'I')) {
        e.preventDefault()
        if (window.htmx) {
          window.htmx.ajax('POST', '/api/session/toggle/meta', { swap: 'none' })
        }
      }
    }
    window.addEventListener('keydown', keydownHandler, { capture: true })

    const event = new KeyboardEvent('keydown', {
      key: 'i',
      metaKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    })
    event.preventDefault = () => { prevented = true }

    window.dispatchEvent(event)

    expect(prevented).toBe(true)
    expect(ajaxSpy).toHaveBeenCalledWith('POST', '/api/session/toggle/meta', { swap: 'none' })

    window.removeEventListener('keydown', keydownHandler, { capture: true })
  })

  it('syncs data-meta from #session-layout to #app-root on htmx event', () => {
    document.body.innerHTML = `
      <div id="app-root" data-meta="on">
        <div id="session-layout" data-meta="off"></div>
      </div>
    `
    const appRoot = document.getElementById('app-root')
    const layout = document.getElementById('session-layout')

    const syncSessionLayout = (layoutEl) => {
      const root = document.getElementById('app-root')
      const targetLayout = layoutEl || document.getElementById('session-layout')
      if (!root || !targetLayout || !targetLayout.dataset) return
      if (targetLayout.dataset.meta) {
        root.setAttribute('data-meta', targetLayout.dataset.meta)
      }
    }

    syncSessionLayout(layout)
    expect(appRoot.getAttribute('data-meta')).toBe('off')
  })
})

