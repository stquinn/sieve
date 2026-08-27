// @ts-check
// QuestionListView — a question DRAWN: the blocks it IS, rendered by the kind
// each one is. Exercised through AiBlockRenderer, its host today, so what is
// pinned is the whole path a question takes from attrs to DOM.
//
// The shapes are not invented here: they are read out of the SHOWCASE NOTE
// (`sieve/block/processors/testdata/question-list-showcase/`), the same file
// Go's fold tests load. It exercises every element role the model allows —
// whole-document target, local target, foreign target, prose, code, log,
// attachments by declared role and by address fallback — so a renderer that
// cannot draw one of them fails HERE rather than in a user's document.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import jsyaml from 'js-yaml'
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import MarkdownIt from 'markdown-it'
import { AiBlockRenderer } from '../src/static/renderers/ai-block-renderer.js'
import { QuestionListView } from '../src/static/renderers/question-list-view.js'
import { SieveBlock } from '../src/static/contract/sieve-block.js'

// The DOCUMENT's own cascade, as the app serves it (editor.css). Installed so
// the whitespace assertions below have teeth: these are the margins a question's
// elements inherit by being blocks, and beating them is the point.
function installDocumentCascade() {
  const el = document.createElement('style')
  el.setAttribute('data-test-doc-cascade', '')
  el.textContent = `
    .sieve-block { margin-top: 1.5rem; margin-bottom: 2rem; }
    p { margin-top: 1em; margin-bottom: 1em; }
  `
  document.head.appendChild(el)
  return el
}

// A window.mermaid STUB, for the same reason diagram-renderer.test.js installs
// one: a render-mode diagram injects a real <script src> when the global is
// absent, and happy-dom fetches it synchronously against no server.
function installMermaidStub() {
  /** @type {any} */ (window).mermaid = {
    initialize() {},
    render() { return Promise.resolve({ svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }) },
  }
}

// The worktree-relative read the JS suites already use for cross-tree fixtures
// (see contract-purity.test.js): `import.meta.url` is not a file specifier under
// vite's transform.
const SHOWCASE = path.resolve(process.cwd(), '../sieve/block/processors/testdata/question-list-showcase')

/** The document the showcase note IS — what its own addresses resolve against. */
const SELF = '0198c1a0-0000-7000-8000-000000000001'

/**
 * The showcase note's ai-blocks, in document order, as the attr maps Go stores.
 * Read straight off the fence so a change to the note lands in front of this
 * suite the same way it lands in front of Go's.
 * @returns {Array<Record<string, any>>}
 */
function showcaseBlocks() {
  const md = readdirSync(SHOWCASE).filter((f) => f.endsWith('.md'))
  expect(md.length).toBe(1)
  const text = readFileSync(path.join(SHOWCASE, md[0]), 'utf8')
  const fences = text.match(/```ai-block\n([\s\S]*?)\n```/g) || []
  return fences.map((fence) => /** @type {any} */ (jsyaml.load(fence.replace(/^```ai-block\n/, '').replace(/\n```$/, ''))))
}

/** Mounts an answered ai-block carrying `question` in `container` and returns its
 *  drawn question region. @param {any} question @param {string} [container] */
function draw(question, container) {
  const uuid = container === undefined ? SELF : container
  const provider = /** @type {any} */ ({ getUuid: () => uuid })
  const renderer = new AiBlockRenderer(new SieveBlock('ai-block', {
    id: '0198c1a0-0000-7000-8000-000000000020', type: 'ASK', status: 'COMPLETE',
    question: question, response: 'an answer',
  }), provider)
  const dom = renderer.render()
  const el = /** @type {HTMLElement} */ (dom.querySelector('.ai-block__question'))
  const rows = Array.from(el.querySelectorAll('.ai-block__element'))
  return { renderer, dom, el, count: rows.length, rows }
}

/** @param {Element[]} rows */
const kindsOf = (rows) => rows.map((r) => r.getAttribute('data-kind'))

describe('the ai-block question — the showcase note, drawn', () => {
  /** @type {Array<Record<string, any>>} */ let blocks

  beforeAll(() => {
    Object.assign(/** @type {any} */ (globalThis).TipTap, { MarkdownIt })
    installMermaidStub()
    blocks = showcaseBlocks()
  })
  afterAll(() => { delete /** @type {any} */ (globalThis).TipTap.MarkdownIt })
  afterEach(() => { document.body.innerHTML = '' })

  it('the note holds the two ai-blocks the whole model is exercised through', () => {
    expect(blocks.length).toBe(2)
    expect(blocks[0].question.map((/** @type {any} */ el) => el.kind)).toEqual([
      'reference', 'reference', 'reference', 'prose', 'code', 'log', 'log', 'diagram', 'prose', 'reference', 'reference', 'reference',
    ])
  })

  it('draws the body, in authored order, and no reference at all', () => {
    const { rows } = draw(blocks[0].question)
    // POINTING HAS NO ENTRY. The three targets show as the lineage affordances
    // on what they point at; the three attachments as the block's footer chips.
    // TWO log elements: the read-only log's two arms side by side — one whose
    // parse job ran, one that was never processed.
    expect(kindsOf(rows)).toEqual(['prose', 'code', 'log', 'log', 'diagram', 'prose'])
    expect(rows.some((r) => r.querySelector('.sieve-reference-chip'))).toBe(false)
  })

  it('renders each kind through its own renderer, not as one joined string', () => {
    const { el, rows } = draw(blocks[0].question)

    expect(rows[0].textContent).toContain('Compare these accounts of the retry policy.')

    const code = rows[1].querySelector('.sieve-block--code')
    expect(code).toBeTruthy()
    expect(code?.querySelector('.sieve-block__badge')?.textContent).toBe('go')
    expect(code?.querySelector('code')?.textContent).toContain('func retry()')
    // The inner fence the fixture carries survives into the drawn code.
    expect(code?.querySelector('code')?.textContent).toContain('```go')

    expect(rows[2].querySelector('.sieve-block--log')).toBeTruthy()
    expect(rows[2].querySelector('code')?.textContent).toContain('giving up after 4 attempts')
    expect(rows[3].querySelector('.sieve-block--log')).toBeTruthy()

    // A DIAGRAM element proves the dispatch is the registry's and not a switch:
    // nothing here knows the kind, and it renders through DiagramRenderer.
    expect(rows[4].querySelector('.sieve-block--diagram')).toBeTruthy()

    expect(rows[5].textContent).toContain('Answer in two sentences.')

    // Two prose elements are two ROWS. A joined title string is exactly what
    // this must never become.
    expect(el.querySelectorAll('.ai-block__element[data-kind="prose"]').length).toBe(2)
  })

  // READ-ONLY IS THE MECHANISM. Each kind renders its whole anatomy — chrome
  // included — and disables its own editing and mutating affordances, because
  // the question list constructs it with the framework's readOnly flag rather
  // than knowing what any kind's affordances are.
  it('a log element keeps its badge and loses the control that changes the block', () => {
    const { rows } = draw(blocks[0].question)
    const log = rows[2]
    expect(log.querySelector('.sieve-block__header .sieve-block__badge')?.textContent).toBe('Log')
    // The raw/explore toggle persists a mode; a record's surface is decided by
    // what processing produced, so it is not offered. (This element was never
    // processed, so its read affordances — filter, columns — have no table to
    // act on either; renderer-read-only.test.js covers the processed case.)
    expect(log.querySelector('.log-block__toggle')).toBeNull()
    expect(log.querySelectorAll('input, select').length).toBe(0)
  })

  it('a diagram element is the RENDERED diagram, with no edit toggle to leave it', () => {
    const { rows } = draw(blocks[0].question)
    const diagram = rows[4]
    expect(diagram.querySelector('.diagram-block__toggle')).toBeNull()
    expect(diagram.querySelector('.diagram-block__engine')).toBeNull()   // the picker rewrites the block
    expect(diagram.querySelector('.diagram-block__engine-wrap')?.textContent).toBe('mermaid')
  })

  // THE SHOWCASE CARRIES BOTH READ-ONLY LOG ARMS. The unprocessed one falls back
  // to its raw text; the processed one resolves the asset its parse job produced
  // and shows the table — the exact path a reader exercises on the loaded note.
  it('shows the raw arm for the unprocessed log and the rich arm for the processed one', async () => {
    const realFetch = globalThis.fetch
    /** @type {string[]} */ const fetched = []
    globalThis.fetch = /** @type {any} */ ((url) => {
      fetched.push(String(url))
      return Promise.resolve({ json: () => Promise.resolve({ lines: [
        { lineNumber: '5', level: 'ERROR', logger: 'c.s.retry.BackoffPolicy', thread: 'retry-worker-3',
          message: 'giving up after 4 attempts', raw: 'giving up after 4 attempts', severity: 'error' },
      ] }) })
    })
    try {
      const { rows } = draw(blocks[0].question)
      await new Promise((r) => setTimeout(r, 0))

      const unprocessed = rows[2], processed = rows[3]
      expect(/** @type {HTMLElement} */ (unprocessed.querySelector('.log-block__explore-area')).style.display).toBe('none')
      expect(/** @type {HTMLElement} */ (processed.querySelector('.log-block__explore-area')).style.display).toBe('flex')

      // It resolved the ref the parse job stamped, against the note's own uuid.
      expect(fetched).toEqual(['/ui/assets/' + SELF + '/0198c1a0-0000-7000-8000-00000000010e-parsed.json'])
      expect(processed.querySelector('input')).toBeTruthy()          // filter, live
      expect(processed.textContent).toContain('giving up after 4 attempts')
      expect(unprocessed.querySelector('input')).toBeNull()          // raw arm offers none
    } finally {
      globalThis.fetch = realFetch
    }
  })

  // THE COMPOSED PATH, which is the one a reader exercises. The renderer's own
  // suite drives it bare; this drives it through the view, because the view is
  // what once stood between a keystroke and the control it was aimed at — a
  // capture-phase stopPropagation let the character land in the box while the
  // filter never fired, so the box filled and the table did not move. Asserting
  // the INPUT'S VALUE would have passed in that state: assert the table.
  it('the filter inside a drawn question narrows the table, and writes nothing', async () => {
    const realFetch = globalThis.fetch
    /** @type {string[]} */ const fetched = []
    globalThis.fetch = /** @type {any} */ ((url) => {
      fetched.push(String(url))
      return Promise.resolve({ json: () => Promise.resolve({ lines: [
        { lineNumber: '3', level: 'WARN', message: 'attempt 3 scheduled', raw: 'WARN attempt 3 scheduled', severity: 'warn' },
        { lineNumber: '5', level: 'ERROR', message: 'giving up after 4 attempts', raw: 'ERROR giving up after 4 attempts', severity: 'error' },
      ] }) })
    })
    const provider = { calls: /** @type {string[]} */ ([]), getUuid: () => SELF,
      requestSetBlock() { provider.calls.push('set') },
      requestRetry() { provider.calls.push('retry') },
      flush() { provider.calls.push('flush') } }
    try {
      const processed = blocks[0].question.find((/** @type {any} */ el) => el.attrs && el.attrs.parsedAssetRef)
      expect(processed).toBeTruthy()
      const attrsBefore = JSON.stringify(processed.attrs)

      const renderer = new AiBlockRenderer(new SieveBlock('ai-block', {
        id: '0198c1a0-0000-7000-8000-000000000020', type: 'ASK', status: 'COMPLETE',
        response: 'an answer', question: blocks[0].question,
      }), /** @type {any} */ (provider))
      const dom = renderer.render()
      document.body.appendChild(dom)
      await new Promise((r) => setTimeout(r, 0))

      const rich = /** @type {HTMLElement} */ (dom.querySelectorAll('.ai-block__question .ai-block__element[data-kind="log"]')[1])
      expect(fetched).toEqual(['/ui/assets/' + SELF + '/0198c1a0-0000-7000-8000-00000000010e-parsed.json'])
      expect(rich.querySelectorAll('.log-block__rows .log-block__row').length).toBe(2)

      const filter = /** @type {HTMLInputElement} */ (rich.querySelector('input'))
      filter.value = 'giving up'
      filter.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 0))

      // BOTH halves: the character landed AND the table moved.
      expect(filter.value).toBe('giving up')
      const rows = Array.from(rich.querySelectorAll('.log-block__rows .log-block__row'))
      expect(rows.length).toBe(1)
      expect(rows[0].textContent).toContain('giving up')

      // And nothing was written: no verb, and the element's own attrs untouched.
      expect(provider.calls).toEqual([])
      expect(JSON.stringify(processed.attrs)).toBe(attrsBefore)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('a code element keeps its language badge and stops being an editing surface', () => {
    const { rows } = draw(blocks[0].question)
    const pre = /** @type {HTMLElement} */ (rows[1].querySelector('pre'))
    expect(rows[1].querySelector('.sieve-block__badge')?.textContent).toBe('go')
    expect(pre.getAttribute('contenteditable')).toBe('false')
  })

  it('an element carries no document-addressable id — nothing resolves one', () => {
    const { el } = draw(blocks[0].question)
    expect(el.querySelectorAll('[data-id]').length).toBe(0)
    expect(el.querySelectorAll('[data-block-id]').length).toBe(0)
  })

  it('the follow-up draws only its prose — its target is the exchange above it', () => {
    const { rows } = draw(blocks[1].question)
    expect(kindsOf(rows)).toEqual(['prose'])
    expect(rows[0].textContent).toContain('Now give me the counter-argument.')
  })

  it('read from ANOTHER document the body is the same — pointing is never drawn', () => {
    const { rows } = draw(blocks[0].question, '0198c1a0-eeee-7000-8000-0000000000ee')
    expect(kindsOf(rows)).toEqual(['prose', 'code', 'log', 'log', 'diagram', 'prose'])
  })
})

describe('the ai-block question — what it draws and what it leaves alone', () => {
  beforeAll(() => { Object.assign(/** @type {any} */ (globalThis).TipTap, { MarkdownIt }); installMermaidStub() })
  afterAll(() => { delete /** @type {any} */ (globalThis).TipTap.MarkdownIt })
  afterEach(() => { document.body.innerHTML = '' })

  /** @param {string} uri @param {string} [rel] */
  const ref = (uri, rel) => ({ kind: 'reference', attrs: rel ? { uri, rel } : { uri } })

  it('a scalar question draws as the one prose element it is', () => {
    const { rows } = draw('What does this function do?')
    expect(kindsOf(rows)).toEqual(['prose'])
    expect(rows[0].textContent).toContain('What does this function do?')
  })

  it('an empty question draws nothing, so the caller hides the region', () => {
    expect(draw('').count).toBe(0)
    expect(draw([]).count).toBe(0)
    expect(draw(null).count).toBe(0)
    expect(draw(undefined).count).toBe(0)
  })

  it('a question of references alone draws nothing, whatever their addresses', () => {
    expect(draw([
      ref('sieve://' + SELF, 'target'),
      ref('sieve://' + SELF + '?version=3', 'target'),
      ref('sieve://0198c1a0-ffff-7000-8000-0000000000ff', 'target'),
      ref('container:9f2b', 'target'),
      ref('sieve://0198c1a0-aaaa-7000-8000-0000000000aa', 'attach'),
      ref('sieve://0198c1a0-bbbb-7000-8000-0000000000bb', 'quote'),
      ref('sieve://not-a-uuid'),
    ]).count).toBe(0)
  })

  it('a kind NOTHING has registered still shows its name and its text', () => {
    const { rows } = draw([{ kind: 'spreadsheet', attrs: { source: 'A1,B1' } }])
    expect(rows[0].getAttribute('data-kind')).toBe('spreadsheet')
    expect(rows[0].querySelector('.ai-block__element-plain')).toBeTruthy()
    expect(rows[0].textContent).toContain('spreadsheet')
    expect(rows[0].textContent).toContain('A1,B1')
  })

  it('a redraw replaces the list rather than appending to it', () => {
    const view = new QuestionListView()
    const el = document.createElement('div')
    view.fill(el, [{ kind: 'prose', attrs: { content: 'first' } }])
    view.fill(el, [{ kind: 'prose', attrs: { content: 'second' } }])
    expect(el.querySelectorAll('.ai-block__element').length).toBe(1)
    expect(el.textContent).toContain('second')
    expect(el.textContent).not.toContain('first')
  })

  // A gesture inside the question must land on the ai-block. Every id resolver
  // in the tree is an ANCESTOR walk — `sieve-block-extension.js` installs the
  // contextmenu listener on the ai-block's NodeView root and reads its node
  // through PM's getPos(), and the two DOM-side readers (`workspace.js`'s
  // block-hover and `wysiwyg-surface.js`'s block cursor) both ask
  // `closest('[data-id]')`. So the ONE thing the question list must guarantee is
  // that nothing inside it answers that walk.
  it('every gesture inside the question resolves to the PARENT ai-block, never an element', () => {
    const block = document.createElement('div')
    block.className = 'sieve-ai-block ai-block'
    block.setAttribute('data-id', '0198c1a0-0000-7000-8000-000000000020')
    block.setAttribute('data-kind', 'ai-block')
    const question = document.createElement('div')
    block.appendChild(question)
    document.body.appendChild(block)

    new QuestionListView().fill(question, [
      { kind: 'prose', attrs: { id: 'el-1', content: 'why?' } },
      { kind: 'code', attrs: { id: 'el-2', language: 'go', source: 'func f() {}' } },
      { kind: 'log', attrs: { id: 'el-3', source: 'WARN a\nERROR b' } },
      { kind: 'diagram', attrs: { id: 'el-4', source: 'graph TD; a-->b' } },
      { kind: 'reference', attrs: { id: 'el-5', uri: 'sieve://0198c1a0-ffff-7000-8000-0000000000ff' } },
    ])

    const descendants = Array.from(question.querySelectorAll('*'))
    expect(descendants.length).toBeGreaterThan(10)
    for (const node of descendants) {
      expect(node.closest('[data-id]')).toBe(block)
      expect(node.closest('[data-block-id]')).toBeNull()
    }
  })

  // THE FLAG IS THE MECHANISM, and this is the list's half of it: whatever a
  // kind's mutating affordance turns out to be, the list constructs the renderer
  // read-only so the kind disables it. Fired here through a kind's real chrome.
  it('an action fired inside the list changes nothing — the elements are read-only', () => {
    const provider = { calls: /** @type {string[]} */ ([]), getUuid: () => SELF,
      requestSetBlock() { provider.calls.push('set') },
      requestRetry() { provider.calls.push('retry') },
      flush() { provider.calls.push('flush') } }
    const renderer = new AiBlockRenderer(new SieveBlock('ai-block', {
      id: '0198c1a0-0000-7000-8000-000000000020', type: 'ASK', status: 'COMPLETE', response: 'an answer',
      question: [
        { kind: 'log', attrs: { id: 'el-1', source: 'WARN a' } },
        { kind: 'diagram', attrs: { id: 'el-2', mode: 'edit', source: 'graph TD; a-->b' } },
      ],
    }), /** @type {any} */ (provider))
    const dom = renderer.render()
    document.body.appendChild(dom)

    const question = /** @type {HTMLElement} */ (dom.querySelector('.ai-block__question'))
    // Whatever chrome survives, clicking all of it reaches nothing outside the
    // record: no verb goes out.
    for (const el of Array.from(question.querySelectorAll('*'))) {
      /** @type {HTMLElement} */ (el).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }
    expect(provider.calls).toEqual([])
  })

  // A kind may inject content long after it was composed, and it is not always
  // Sieve's — a rendered mermaid diagram stamps data-id on its own SVG edges.
  it('content a kind injects LATER is stripped of identity too', async () => {
    const view = new QuestionListView()
    const el = document.createElement('div')
    view.fill(el, [{ kind: 'prose', attrs: { content: 'why?' } }])

    const late = document.createElement('span')
    late.setAttribute('data-id', 'L_A_B_0')          // mermaid's own edge id
    const host = /** @type {HTMLElement} */ (el.querySelector('.ai-block__element'))
    host.appendChild(late)
    await new Promise((r) => setTimeout(r, 0))       // the observer runs on a microtask

    expect(el.querySelectorAll('[data-id]').length).toBe(0)
    view.destroy()
  })

  // THE QUESTION HUGS ITS CONTENT. An element is a whole block, and a block in a
  // document carries the margins that separate it from its neighbours there;
  // inside a question those are somebody else's spacing, and they showed as
  // blank bands above the first element and below the last.
  it('leaves no leading or trailing blank space, whatever it opens and closes with', () => {
    const cascade = installDocumentCascade()
    try {
      for (const question of [
        'a plain single-prose ask',
        [{ kind: 'prose', attrs: { content: 'opens with prose' } },
         { kind: 'code', attrs: { language: 'go', source: 'func f() {}' } },
         { kind: 'prose', attrs: { content: 'closes with prose' } }],
        [{ kind: 'code', attrs: { language: 'go', source: 'func f() {}' } },
         { kind: 'log', attrs: { source: 'WARN a' } }],
      ]) {
        const { el, rows } = draw(question)
        document.body.appendChild(el)

        for (const [row, edge] of [[rows[0], 'marginTop'], [rows[rows.length - 1], 'marginBottom']]) {
          const block = /** @type {Element} */ (/** @type {Element} */ (row).querySelector('.sieve-block'))
          expect(getComputedStyle(block)[edge]).toBe('0px')
        }
        const first = el.querySelector('.sieve-block__content > *')
        if (first) expect(getComputedStyle(first).marginTop).toBe('0px')
        el.remove()
      }
    } finally {
      cascade.remove()
    }
  })

  it('an HTML-shaped element renders as inert text — no node is built from it', () => {
    const { el } = draw([
      { kind: 'prose', attrs: { content: '<img src=x onerror="alert(1)">' } },
      { kind: 'code', attrs: { language: 'html', source: '<img src=x onerror="alert(1)">' } },
    ])
    document.body.appendChild(el)
    expect(document.querySelectorAll('img').length).toBe(0)
    expect(el.textContent).toContain('<img src=x onerror="alert(1)">')
  })
})
