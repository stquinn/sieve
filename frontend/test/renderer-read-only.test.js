// @ts-check
// READ-ONLY — the framework flag a renderer honours when it is drawing a RECORD
// rather than a live block: full anatomy, normal chrome, no editing or mutating
// affordance. The base makes every outbound verb inert; each kind below disables
// the affordance that would have fired one.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import MarkdownIt from 'markdown-it'
import { CodeRenderer } from '../src/static/renderers/code-renderer.js'
import { LogRenderer } from '../src/static/renderers/log-renderer.js'
import { DiagramRenderer } from '../src/static/renderers/diagram-renderer.js'
import { ProseRenderer } from '../src/static/renderers/prose-renderer.js'
import { SieveBlock } from '../src/static/contract/sieve-block.js'

/** A provider that records every outbound verb it is asked to perform. */
function spyProvider() {
  return {
    calls: /** @type {string[]} */ ([]),
    getUuid() { return 'c' },
    requestSetBlock(/** @type {string} */ id, /** @type {any} */ patch) { this.calls.push('set:' + JSON.stringify(patch)) },
    requestRetry(/** @type {string} */ id) { this.calls.push('retry') },
    flush(/** @type {string} */ id, /** @type {string} */ text) { this.calls.push('flush') },
  }
}

// A render-mode diagram injects a real <script src> when window.mermaid is
// absent, and happy-dom fetches it synchronously against no server.
function installMermaidStub() {
  /** @type {any} */ (window).mermaid = {
    initialize() {},
    render() { return Promise.resolve({ svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }) },
  }
}

const READ_ONLY = { readOnly: true }

describe('BlockRenderer — the read-only flag', () => {
  beforeAll(() => { Object.assign(/** @type {any} */ (globalThis).TipTap, { MarkdownIt }); installMermaidStub() })
  afterAll(() => { delete /** @type {any} */ (globalThis).TipTap.MarkdownIt })
  afterEach(() => { document.body.innerHTML = '' })

  it('is off by default and reported as it was given', () => {
    expect(new ProseRenderer(new SieveBlock('prose', {})).readOnly).toBe(false)
    expect(new ProseRenderer(new SieveBlock('prose', {}), null, undefined, READ_ONLY).readOnly).toBe(true)
  })

  it('makes EVERY outbound verb inert, whatever the kind asks', () => {
    const live = spyProvider()
    const liveR = new LogRenderer(new SieveBlock('log', { id: 'b1', source: 'a' }), /** @type {any} */ (live))
    liveR.render()
    liveR.toggleNoise(); liveR.setFilter('x'); liveR.retry(); liveR.setContent('y')
    expect(live.calls.length).toBe(4)

    const record = spyProvider()
    const recordR = new LogRenderer(new SieveBlock('log', { id: 'b1', source: 'a' }), /** @type {any} */ (record), undefined, READ_ONLY)
    recordR.render()
    recordR.toggleNoise(); recordR.setFilter('x'); recordR.retry(); recordR.setContent('y')
    expect(record.calls).toEqual([])
  })
})

describe('the kinds that honour it', () => {
  beforeAll(() => { Object.assign(/** @type {any} */ (globalThis).TipTap, { MarkdownIt }); installMermaidStub() })
  afterAll(() => { delete /** @type {any} */ (globalThis).TipTap.MarkdownIt })
  afterEach(() => { document.body.innerHTML = '' })

  it('diagram: no EDIT toggle and no engine picker — a record is the rendered diagram', () => {
    const attrs = { id: 'd1', diagramType: 'mermaid', mode: 'edit', source: 'graph TD; a-->b' }
    const live = new DiagramRenderer(new SieveBlock('diagram', attrs)).render()
    expect(live.querySelector('.diagram-block__toggle')).toBeTruthy()
    expect(live.querySelector('select.diagram-block__engine')).toBeTruthy()

    const record = new DiagramRenderer(new SieveBlock('diagram', attrs), null, undefined, READ_ONLY).render()
    expect(record.querySelector('.diagram-block__toggle')).toBeNull()
    expect(record.querySelector('select.diagram-block__engine')).toBeNull()
    // mode:'edit' on the block, RENDERED all the same — the record shows the
    // diagram, never the source surface it was last left on.
    expect(record.querySelector('.diagram-block__engine-wrap')?.textContent).toBe('mermaid')
  })

  it('code: the language badge stays, the text surface stops accepting edits', () => {
    const attrs = { id: 'c1', language: 'go', source: 'func f() {}' }
    const live = new CodeRenderer(new SieveBlock('code', attrs)).render()
    expect(/** @type {HTMLElement} */ (live.querySelector('pre')).getAttribute('contenteditable')).toBeNull()

    const record = new CodeRenderer(new SieveBlock('code', attrs), null, undefined, READ_ONLY).render()
    expect(record.querySelector('.sieve-block__badge')?.textContent).toBe('go')
    const pre = /** @type {HTMLElement} */ (record.querySelector('pre'))
    expect(pre.getAttribute('contenteditable')).toBe('false')
    expect(pre.style.pointerEvents).toBe('none')
  })

  it('log: the bar keeps what it SAYS and loses what it DOES', () => {
    const attrs = { id: 'l1', source: 'WARN a', logFormatName: 'syslog' }
    const live = new LogRenderer(new SieveBlock('log', attrs)).render()
    expect(live.querySelectorAll('button').length).toBeGreaterThan(0)

    const record = new LogRenderer(new SieveBlock('log', attrs), null, undefined, READ_ONLY).render()
    expect(record.querySelector('.sieve-block__badge')?.textContent).toBe('Log')
    expect(record.textContent).toContain('Format: syslog')     // a fact about the log
    // The raw/explore toggle is the one control that changes the BLOCK.
    expect(record.querySelector('.log-block__toggle')).toBeNull()
  })

  // A RECORD SHOWS WHAT PROCESSING ALREADY PRODUCED. `parsedAssetRef` is the
  // observable fact that the parse job ran (log_processor.go stamps it in the
  // job's Apply); the resolved url is whether this context can reach the result.
  describe('log: read-only honours the block\'s processed state', () => {
    const PARSED = {
      id: 'l2', source: '2026-08-27 11:04 WARN retry\n2026-08-27 11:05 ERROR gave up',
      parsedAssetRef: 'log-l2.json', resolvedAssetUrl: '/ui/assets/c/log-l2.json',
      status: 'COMPLETE',
    }
    /** @type {any} */ let realFetch
    /** @type {string[]} */ let fetched

    beforeEach(() => {
      fetched = []
      realFetch = globalThis.fetch
      globalThis.fetch = /** @type {any} */ ((url) => {
        fetched.push(String(url))
        return Promise.resolve({ json: () => Promise.resolve({ lines: [
          { lineNumber: '1', level: 'WARN', message: 'retry', raw: 'WARN retry', severity: 'warn' },
          { lineNumber: '2', level: 'ERROR', message: 'gave up', raw: 'ERROR gave up', severity: 'error' },
        ] }) })
      })
    })
    afterEach(() => { globalThis.fetch = realFetch })

    /** Drains the microtasks the asset load and its table render run on. */
    const settled = () => new Promise((r) => setTimeout(r, 0))

    it('renders the RICH view from the asset processing already produced', async () => {
      const provider = spyProvider()
      const renderer = new LogRenderer(new SieveBlock('log', PARSED), /** @type {any} */ (provider), undefined, READ_ONLY)
      const dom = renderer.render()
      await settled()

      expect(LogRenderer.recordMode(PARSED)).toBe('explore')
      expect(/** @type {HTMLElement} */ (dom.querySelector('.log-block__explore-area')).style.display).toBe('flex')
      expect(dom.querySelectorAll('.log-block__row').length).toBeGreaterThan(1)   // header + lines
      expect(dom.textContent).toContain('gave up')

      // It RESOLVED what existed and asked for nothing else: no job, no verb.
      expect(fetched).toEqual(['/ui/assets/c/log-l2.json'])
      expect(provider.calls).toEqual([])
      // The one control that changes the BLOCK is gone.
      expect(dom.querySelector('.log-block__toggle')).toBeNull()
    })

    // READ-ONLY FORBIDS MUTATION, NOT EXPLORATION. The filter and the column
    // buttons change how the log is READ, so a record keeps them live — and
    // holds what they say locally, because it has no block of its own to write.
    it('keeps its read affordances live, and writes none of them back', async () => {
      const provider = spyProvider()
      const renderer = new LogRenderer(new SieveBlock('log', PARSED), /** @type {any} */ (provider), undefined, READ_ONLY)
      const dom = renderer.render()
      document.body.appendChild(dom)
      await settled()

      const filter = /** @type {HTMLInputElement} */ (dom.querySelector('input'))
      expect(filter).toBeTruthy()
      expect(dom.querySelectorAll('.sieve-block__badge--clickable').length).toBeGreaterThan(0)  // column buttons
      const before = dom.querySelectorAll('.log-block__rows .log-block__row').length
      expect(before).toBe(2)

      filter.value = 'gave up'
      filter.dispatchEvent(new Event('input', { bubbles: true }))
      await settled()

      // The view MOVED — the filter is live, not decoration.
      const rows = Array.from(dom.querySelectorAll('.log-block__rows .log-block__row'))
      expect(rows.length).toBe(1)
      expect(rows[0].textContent).toContain('gave up')

      // A column button is live too.
      const col = /** @type {HTMLElement} */ (dom.querySelectorAll('.sieve-block__badge--clickable')[0])
      const label = col.textContent
      col.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      await settled()
      expect(dom.querySelector('.log-block__row--header')?.textContent).not.toContain(String(label).toLowerCase())

      // And NOTHING was written: no verb out, and the block's own attrs are as
      // they were — the reading lives with the record, not the block.
      expect(provider.calls).toEqual([])
      expect(PARSED.filter).toBeUndefined()
      expect(PARSED.disabledCols).toBeUndefined()
    })

    it('falls back to RAW when nothing was ever produced, and fetches nothing', async () => {
      const bare = { id: 'l3', source: 'WARN a' }
      const provider = spyProvider()
      const dom = new LogRenderer(new SieveBlock('log', bare), /** @type {any} */ (provider), undefined, READ_ONLY).render()
      await settled()

      expect(LogRenderer.recordMode(bare)).toBe('raw')
      expect(/** @type {HTMLElement} */ (dom.querySelector('.log-block__explore-area')).style.display).toBe('none')
      expect(fetched).toEqual([])
      expect(provider.calls).toEqual([])
    })

    it('a reference this context cannot resolve is not a rich view to show', async () => {
      const unresolvable = { id: 'l4', source: 'WARN a', parsedAssetRef: 'log-l4.json' }
      const dom = new LogRenderer(new SieveBlock('log', unresolvable), null, undefined, READ_ONLY).render()
      await settled()

      expect(LogRenderer.recordMode(unresolvable)).toBe('raw')
      expect(/** @type {HTMLElement} */ (dom.querySelector('.log-block__explore-area')).style.display).toBe('none')
      expect(fetched).toEqual([])

      // THE HEADER AGREES WITH THE BODY. Both read `mode` off the same view, so
      // a bar cannot offer EXPLORE controls over a body that fell back to raw —
      // a filter, and columns, for a table that is not there.
      expect(dom.querySelector('input')).toBeNull()
      const controls = Array.from(dom.querySelectorAll('.sieve-block__badge--clickable'))
      expect(controls.map((c) => c.textContent)).toEqual(['Toggle Noise'])   // the RAW view's own
    })
  })
})
