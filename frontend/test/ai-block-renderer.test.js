// @ts-check
// ai-block-renderer.test.js — DoD coverage for AiBlockRenderer (the ai-block
// kind's look-and-feel class, docs/design/archive/specs/2026-07-20-block-renderer-extraction.md
// Phase 3 / issue #46). Bare-page protocol: render() ALONE yields the complete
// block. Unlike the note lens (the adapter's handleBuild claim, in the adapter
// file), this PURE class BUILDS AND FILLS the body from bodyMarkdown() and
// the title from attrs.question — so a chat turn / embedded card gets a working
// block for free. (The note lens swaps an empty PM-managed body via buildBody.)
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import MarkdownIt from 'markdown-it'
import { AiBlockRenderer } from '../src/static/renderers/ai-block-renderer.js'
import { SieveBlock } from '../src/static/contract/sieve-block.js'

/** @param {object} payload */
function blk(payload) { return new SieveBlock('ai-block', payload) }

/** @typedef {import('../src/static/renderers/ai-block-renderer.js').AiBlockAttrs} AiBlockAttrs */

function clearInjectedStyles() {
  document.adoptedStyleSheets = []
  document.head.querySelectorAll('style[data-sieve-renderer]').forEach((el) => el.remove())
}

function installBareThemeVars() {
  const el = document.createElement('style')
  el.setAttribute('data-test-root-vars', '')
  el.textContent = `
    :root {
      --theme-bg:            #1a1b26;
      --theme-bgDark:        #16161e;
      --theme-border2:       #3b4261;
      --theme-accentPrimary: #7aa2f7;
      --theme-accentPurple:  #bb9af7;
      --theme-accentCyan:    #7dcfff;
      --theme-aiBlockBg:     rgba(122, 162, 247, 0.04);
      --theme-aiBlockBorder: rgba(122, 162, 247, 0.28);
      --theme-monoFont:      monospace;
    }
  `
  document.head.appendChild(el)
  return el
}

/** @type {AiBlockAttrs} */
const REPRESENTATIVE_ATTRS = {
  id: 'ai-a1b2',
  ref: 'wc-c3d4,ai-e5f6',
  type: 'ASK',
  status: 'COMPLETE',
  question: 'What does this function do?',
  response: 'It parses the fence.\n\n```js\nfunction f() { return 1 }\n```',
  createdAt: new Date().toISOString(),
}

/** render() ALONE = the complete block. */
function mount(attrs) {
  const renderer = new AiBlockRenderer(blk(attrs))
  const dom = renderer.render()
  return { renderer, dom }
}

describe('AiBlockRenderer (Phase 3 — bare-page DoD)', () => {
  /** @type {HTMLStyleElement} */
  let rootVars

  beforeAll(() => {
    clearInjectedStyles();
    /** @type {any} */ (globalThis).TipTap = /** @type {any} */ (globalThis).TipTap || {}
    Object.assign(/** @type {any} */ (globalThis).TipTap, { MarkdownIt })
  })
  afterAll(() => { delete /** @type {any} */ (globalThis).TipTap.MarkdownIt })
  beforeEach(() => { rootVars = installBareThemeVars() })
  afterEach(() => { rootVars.remove(); document.body.innerHTML = '' })

  it('registers its static styles exactly once across multiple instances (register-once contract)', () => {
    new AiBlockRenderer(blk({}))
    new AiBlockRenderer(blk({}))
    new AiBlockRenderer(blk({}))
    const matches = document.adoptedStyleSheets.filter((sheet) =>
      Array.from(sheet.cssRules).some((rule) => rule.cssText.indexOf('.ai-block') === 0))
    expect(matches.length).toBe(1)
  })

  it('render() builds the shell + badge + FILLED question title + FILLED response body, styled purely from --theme-* vars', () => {
    const { renderer, dom } = mount(REPRESENTATIVE_ATTRS)
    document.body.appendChild(dom)

    expect(dom.className).toBe('sieve-ai-block ai-block')
    expect(dom.getAttribute('data-id')).toBe('ai-a1b2')
    expect(dom.getAttribute('data-ai-ref')).toBe('wc-c3d4,ai-e5f6')

    const badge = dom.querySelector('.ai-block__badge')
    expect(badge?.textContent).toBe('ASK')

    // The PURE renderer fills the title (question) + body (response) itself.
    const title = dom.querySelector('.sieve-block__heading')
    expect(title?.textContent).toContain('What does this function do?')
    const body = dom.querySelector('.sieve-block__content.tiptap')
    expect(body).toBeTruthy()
    expect(renderer.body).toBe(body)
    expect(body?.textContent).toContain('It parses the fence')

    expect(getComputedStyle(/** @type {Element} */ (badge)).color.toLowerCase()).toBe('#7aa2f7')
  })

  it('badge state machine: PENDING (fresh) shows the thinking state, EXPLAIN types show EXPLAIN', () => {
    const { dom } = mount({ id: 'ai-b2c3', ref: 'doc', type: 'EXPLAIN', status: 'PENDING', createdAt: new Date().toISOString() })
    const badge = dom.querySelector('.ai-block__badge')
    expect(badge?.className).toBe('ai-block__badge ai-block__badge--thinking')
    expect(badge?.textContent).toBe('EXPLAIN')
  })

  it('badge state machine: a stale PENDING job (long past createdAt) reports the error state, not thinking', () => {
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const { dom } = mount({ id: 'ai-c3d4', ref: 'doc', type: 'ASK', status: 'PENDING', createdAt: stale })
    const badge = dom.querySelector('.ai-block__badge')
    expect(badge?.className).toBe('ai-block__badge ai-block__badge--error')
  })

  it('badge state machine: COMPLETE carries no state modifier class', () => {
    const { dom } = mount(REPRESENTATIVE_ATTRS)
    const badge = dom.querySelector('.ai-block__badge')
    expect(badge?.className).toBe('ai-block__badge')
  })

  it('badge state machine: a non-COMPLETE, non-PENDING/DISPATCHED status (ERROR) reports the error state', () => {
    const { dom } = mount({ id: 'ai-d4e5', ref: 'doc', type: 'ASK', status: 'ERROR' })
    const badge = dom.querySelector('.ai-block__badge')
    expect(badge?.className).toBe('ai-block__badge ai-block__badge--error')
  })

  it('update() patches the badge and data-id/data-ai-ref in place without rebuilding the shell', () => {
    const { renderer, dom } = mount({ id: 'ai-e5f6', ref: 'doc', type: 'ASK', status: 'PENDING', createdAt: new Date().toISOString() })
    const badgeBefore = dom.querySelector('.ai-block__badge')

    renderer.update(blk({ id: 'ai-e5f6', ref: 'wc-a1b2', type: 'ASK', status: 'COMPLETE' }))

    expect(dom.getAttribute('data-ai-ref')).toBe('wc-a1b2')
    const badgeAfter = dom.querySelector('.ai-block__badge')
    expect(badgeAfter).toBe(badgeBefore) // same element, patched in place
    expect(badgeAfter?.className).toBe('ai-block__badge')
  })

  it('destroy() is safe to call and does not throw (base no-op — no timers/observers)', () => {
    const { renderer } = mount(REPRESENTATIVE_ATTRS)
    expect(() => renderer.destroy()).not.toThrow()
  })
})

// ── Attachments (#74 P4) ─────────────────────────────────────────────────────
// The ai-block renders the documents its question attached, as chips in the
// FOOTER region — the same place the composer puts them, so a sent question and
// the answer that came back read alike.
//
// The ROW (.ai-block__attachments) is ai-block's; the CHIP inside it is the
// shared AttachmentChip (#38), so the assertions below name
// `.sieve-attachment-chip` — the component owns its class the way it owns its
// styles. What is tested HERE is ai-block's MAPPING onto it (which field labels
// a chip, what makes one dangling, when the row hides); the component's own
// contract is attachment-chip.test.js.

describe('AiBlockRenderer — the attachment chip row', () => {
  /** @type {HTMLStyleElement} */ let rootVars

  beforeAll(() => {
    clearInjectedStyles();
    /** @type {any} */ (globalThis).TipTap = /** @type {any} */ (globalThis).TipTap || {}
    Object.assign(/** @type {any} */ (globalThis).TipTap, { MarkdownIt })
  })
  afterAll(() => { delete /** @type {any} */ (globalThis).TipTap.MarkdownIt })
  beforeEach(() => { rootVars = installBareThemeVars() })
  afterEach(() => { rootVars.remove(); document.body.innerHTML = '' })

  const withAttachments = (attachments) => ({ ...REPRESENTATIVE_ATTRS, attachments })

  it('renders one chip per attachment, labelled with the cached title', () => {
    const { dom } = mount(withAttachments([
      { uri: 'container:9f2b', title: 'Auth Design' },
      { uri: 'container:1a2b', title: 'Retry RFC' },
    ]))
    const chips = dom.querySelectorAll('.sieve-attachment-chip')
    expect(chips.length).toBe(2)
    expect(chips[0].textContent).toContain('Auth Design')
    expect(chips[0].getAttribute('data-uri')).toBe('container:9f2b')
    expect(chips[1].textContent).toContain('Retry RFC')
  })

  it('duplicate titles stay two distinct chips — the ADDRESS is the identity', () => {
    const { dom } = mount(withAttachments([
      { uri: 'container:aaa', title: 'Notes' },
      { uri: 'container:bbb', title: 'Notes' },
    ]))
    const chips = dom.querySelectorAll('.sieve-attachment-chip')
    expect(Array.from(chips).map((c) => c.getAttribute('data-uri'))).toEqual(['container:aaa', 'container:bbb'])
  })

  it('an ai-block with no attachments renders no row at all (absent IS the empty case)', () => {
    const { dom } = mount(REPRESENTATIVE_ATTRS)
    expect(dom.querySelectorAll('.sieve-attachment-chip').length).toBe(0)
    const row = dom.querySelector('.ai-block__attachments')
    expect(/** @type {HTMLElement} */ (row).style.display).toBe('none')
  })

  it('a chip with nothing left to show renders MISSING — dangling is a normal state', () => {
    const { dom } = mount(withAttachments([{ uri: 'container:gone' }]))
    const chip = /** @type {HTMLElement} */ (dom.querySelector('.sieve-attachment-chip'))
    expect(chip.className).toContain('sieve-attachment-chip--missing')
    // Falls back to the address so the chip is still identifiable, never blank.
    expect(chip.textContent).toContain('container:gone')
  })

  it('clicking a chip reports the address to whoever registered for it (no window reach)', () => {
    const { renderer, dom } = mount(withAttachments([{ uri: 'container:9f2b', title: 'Auth Design' }]))
    /** @type {string[]} */ const opened = []
    const off = renderer.onOpenAttachment((uri) => opened.push(uri))

    const chip = /** @type {HTMLElement} */ (dom.querySelector('.sieve-attachment-chip'))
    chip.click()
    expect(opened).toEqual(['container:9f2b'])

    off()
    chip.click()
    expect(opened).toEqual(['container:9f2b'])   // unsubscribed
  })

  it('update() re-fills the chip row in place when server truth arrives', () => {
    const { renderer, dom } = mount(REPRESENTATIVE_ATTRS)
    const rowBefore = dom.querySelector('.ai-block__attachments')
    expect(dom.querySelectorAll('.sieve-attachment-chip').length).toBe(0)

    renderer.update(blk(withAttachments([{ uri: 'container:9f2b', title: 'Auth Design' }])))

    expect(dom.querySelector('.ai-block__attachments')).toBe(rowBefore)  // same element
    expect(dom.querySelectorAll('.sieve-attachment-chip').length).toBe(1)
  })

  it('the row is not editable — it is chrome inside a PM-managed block', () => {
    const { dom } = mount(withAttachments([{ uri: 'container:9f2b', title: 'Auth Design' }]))
    const row = /** @type {HTMLElement} */ (dom.querySelector('.ai-block__attachments'))
    expect(row.getAttribute('contenteditable')).toBe('false')
    expect(row.className).toContain('sieve-block__footer')
  })
})

// ── Dangling attachments (#82) ───────────────────────────────────────────────
// An attachment persists {uri, title} and nothing else, so a chip whose target
// document was deleted goes on showing the cached title. Given an AddressStatus
// the renderer ASKS, and greys the chip when the answer is "that resolves to
// nothing" — keeping the title readable, because the point is "orphaned but
// readable", never "error".
//
// The renderer stays transport-blind: what it holds is an oracle with a
// remembered verdict and an ask; it never learns there is a socket behind one.

describe('AiBlockRenderer — a chip whose target is gone', () => {
  /** @type {HTMLStyleElement} */ let rootVars

  beforeAll(() => {
    clearInjectedStyles();
    /** @type {any} */ (globalThis).TipTap = /** @type {any} */ (globalThis).TipTap || {}
    Object.assign(/** @type {any} */ (globalThis).TipTap, { MarkdownIt })
  })
  afterAll(() => { delete /** @type {any} */ (globalThis).TipTap.MarkdownIt })
  beforeEach(() => { rootVars = installBareThemeVars() })
  afterEach(() => { rootVars.remove(); document.body.innerHTML = '' })

  const AUTH = { uri: 'container:9f2b', title: 'Auth Design' }
  const withAttachments = (attachments) => ({ ...REPRESENTATIVE_ATTRS, attachments })

  /**
   * A stub AddressStatus: the same two-method contract, no wire, and the same
   * TIMING — a verdict lands only when the probe settles, which is what makes
   * the no-flicker assertion below meaningful. It deliberately does NOT memoise
   * its probes: capping them is the RENDERER's half of the discipline, and
   * `probes` is how that is counted.
   */
  function fakeAddresses(answers) {
    return {
      probes: /** @type {string[]} */ ([]),
      verdicts: new Map(),
      stateOf(uri) { return this.verdicts.get(uri) || 'unknown' },
      check(uri) {
        this.probes.push(uri)
        return Promise.resolve(answers[uri] || 'live').then((state) => {
          this.verdicts.set(uri, state)
          return state
        })
      },
    }
  }

  /** Drains the microtask queue the probes and their redraws run on. */
  const settled = () => new Promise((resume) => setTimeout(resume, 0))

  const chipOf = (dom) => /** @type {HTMLElement} */ (dom.querySelector('.sieve-attachment-chip'))

  it('renders NORMALLY until the answer arrives — a block never flickers through dangling', () => {
    const { renderer, dom } = mount(withAttachments([AUTH]))
    renderer.probeAttachmentsWith(/** @type {any} */ (fakeAddresses({ 'container:9f2b': 'dangling' })))
    // Synchronously, before the probe settles: nothing has been answered yet.
    expect(chipOf(dom).className).not.toContain('sieve-attachment-chip--missing')
  })

  it('greys the chip once the address answers DANGLING, keeping the cached title', async () => {
    const { renderer, dom } = mount(withAttachments([AUTH]))
    renderer.probeAttachmentsWith(/** @type {any} */ (fakeAddresses({ 'container:9f2b': 'dangling' })))
    await settled()

    const chip = chipOf(dom)
    expect(chip.className).toContain('sieve-attachment-chip--missing')
    expect(chip.textContent).toContain('Auth Design')          // orphaned but READABLE
    expect(chip.getAttribute('title')).toContain('no longer available')
    expect(chip.getAttribute('data-uri')).toBe('container:9f2b')   // and still clickable
  })

  it('leaves a LIVE address alone', async () => {
    const { renderer, dom } = mount(withAttachments([AUTH]))
    renderer.probeAttachmentsWith(/** @type {any} */ (fakeAddresses({ 'container:9f2b': 'live' })))
    await settled()

    const chip = chipOf(dom)
    expect(chip.className).not.toContain('sieve-attachment-chip--missing')
    expect(chip.getAttribute('title')).toBe('container:9f2b')
  })

  it('greys only the chip whose target is gone', async () => {
    const { renderer, dom } = mount(withAttachments([AUTH, { uri: 'container:1a2b', title: 'Retry RFC' }]))
    renderer.probeAttachmentsWith(/** @type {any} */ (fakeAddresses({ 'container:9f2b': 'dangling' })))
    await settled()

    const chips = dom.querySelectorAll('.sieve-attachment-chip')
    expect(chips[0].className).toContain('sieve-attachment-chip--missing')
    expect(chips[1].className).not.toContain('sieve-attachment-chip--missing')
  })

  it('a redraw asks NOTHING further — the verdict is remembered, not re-fetched', async () => {
    const { renderer, dom } = mount(withAttachments([AUTH]))
    const addresses = fakeAddresses({ 'container:9f2b': 'dangling' })
    renderer.probeAttachmentsWith(/** @type {any} */ (addresses))
    await settled()
    expect(addresses.probes).toEqual(['container:9f2b'])

    // Every keystroke inside the document redraws the block. None of them may
    // reach the oracle again — that is the whole cost discipline.
    for (let i = 0; i < 5; i++) renderer.update(blk(withAttachments([AUTH])))
    await settled()

    expect(addresses.probes).toEqual(['container:9f2b'])
    expect(chipOf(dom).className).toContain('sieve-attachment-chip--missing')
  })

  it('an attachment arriving later is probed on the update that brings it', async () => {
    const { renderer, dom } = mount(REPRESENTATIVE_ATTRS)
    const addresses = fakeAddresses({ 'container:9f2b': 'dangling' })
    renderer.probeAttachmentsWith(/** @type {any} */ (addresses))
    expect(addresses.probes).toEqual([])         // nothing attached yet

    renderer.update(blk(withAttachments([AUTH])))
    await settled()

    expect(addresses.probes).toEqual(['container:9f2b'])
    expect(chipOf(dom).className).toContain('sieve-attachment-chip--missing')
  })

  it('without an oracle the row renders exactly as it did before #82', () => {
    const { dom } = mount(withAttachments([AUTH]))
    const chip = chipOf(dom)
    expect(chip.className).not.toContain('sieve-attachment-chip--missing')
    expect(chip.textContent).toContain('Auth Design')
  })
})

// ── The question's @mentions (#74) ───────────────────────────────────────────
// The literal `@Auth Design` inside the rendered question is marked with the
// SAME accent its footer chip carries, so the inline mention and the chip read
// as one object. Only titles this block actually attached are marked — the data
// is the matcher, never a `@\w+` regex.

describe('AiBlockRenderer — @mentions inside the question', () => {
  /** @type {HTMLStyleElement} */ let rootVars

  beforeAll(() => {
    clearInjectedStyles();
    /** @type {any} */ (globalThis).TipTap = /** @type {any} */ (globalThis).TipTap || {}
    Object.assign(/** @type {any} */ (globalThis).TipTap, { MarkdownIt })
  })
  afterAll(() => { delete /** @type {any} */ (globalThis).TipTap.MarkdownIt })
  beforeEach(() => { rootVars = installBareThemeVars() })
  afterEach(() => { rootVars.remove(); document.body.innerHTML = '' })

  /** @param {Element|null} title */
  const mentions = (title) => Array.from(title?.querySelectorAll('.ai-block__mention') || []).map((m) => m.textContent)
  /** @param {HTMLElement} dom */
  const heading = (dom) => dom.querySelector('.sieve-block__heading')

  it('marks the attached title where it appears in the question, prose untouched', () => {
    const { dom } = mount({
      ...REPRESENTATIVE_ATTRS,
      question: 'How does @Auth Design handle retries?',
      attachments: [{ uri: 'container:9f2b', title: 'Auth Design' }],
    })
    const title = heading(dom)
    expect(mentions(title)).toEqual(['@Auth Design'])
    expect(title?.textContent?.trim()).toBe('How does @Auth Design handle retries?')
  })

  it('marks every occurrence — two attachments sharing a title mark both tokens', () => {
    const { dom } = mount({
      ...REPRESENTATIVE_ATTRS,
      question: 'Does @Notes agree with @Notes?',
      attachments: [{ uri: 'container:aaa', title: 'Notes' }, { uri: 'container:bbb', title: 'Notes' }],
    })
    expect(mentions(heading(dom))).toEqual(['@Notes', '@Notes'])
  })

  it('marks NOTHING that is not attached — an email, an unattached name, a stray @', () => {
    const { dom } = mount({
      ...REPRESENTATIVE_ATTRS,
      question: 'Mail stephen@example.com, ask @Retry RFC, mind the @ sign',
      attachments: [{ uri: 'container:9f2b', title: 'Auth Design' }],
    })
    expect(mentions(heading(dom))).toEqual([])
  })

  it('does not disturb the question\'s markdown rendering, and skips code spans', () => {
    const { dom } = mount({
      ...REPRESENTATIVE_ATTRS,
      question: '**Compare** `@Auth Design` with @Auth Design',
      attachments: [{ uri: 'container:9f2b', title: 'Auth Design' }],
    })
    const title = heading(dom)
    expect(title?.querySelector('strong')?.textContent).toBe('Compare')
    expect(title?.querySelector('code')?.textContent).toBe('@Auth Design')
    expect(mentions(title)).toEqual(['@Auth Design'])
    expect(title?.querySelector('code')?.querySelector('.ai-block__mention')).toBeNull()
  })

  it('an HTML-shaped title renders as INERT TEXT — no node is ever built from it (SEC-B #48)', () => {
    const evil = '<img src=x onerror="alert(1)">'
    const { dom } = mount({
      ...REPRESENTATIVE_ATTRS,
      question: 'What does @' + evil + ' say?',
      attachments: [{ uri: 'container:evil', title: evil }],
    })
    document.body.appendChild(dom)
    const title = heading(dom)
    expect(dom.querySelector('img')).toBeNull()
    expect(document.querySelectorAll('img').length).toBe(0)
    expect(mentions(title)).toEqual(['@' + evil])
    expect(title?.textContent?.trim()).toBe('What does @' + evil + ' say?')
  })

  it('only the QUESTION is marked — the answer is prose the AI wrote', () => {
    const { dom } = mount({
      ...REPRESENTATIVE_ATTRS,
      question: 'Summarise @Auth Design',
      response: 'The @Auth Design note says retries are capped.',
      attachments: [{ uri: 'container:9f2b', title: 'Auth Design' }],
    })
    expect(mentions(heading(dom))).toEqual(['@Auth Design'])
    expect(dom.querySelectorAll('.sieve-block__content .ai-block__mention').length).toBe(0)
  })

  it('update() marks the question when the server\'s attachments arrive after the block', () => {
    const { renderer, dom } = mount({ ...REPRESENTATIVE_ATTRS, status: 'PENDING', question: 'Summarise @Auth Design' })
    expect(mentions(heading(dom))).toEqual([])

    renderer.update(blk({
      ...REPRESENTATIVE_ATTRS,
      question: 'Summarise @Auth Design',
      attachments: [{ uri: 'container:9f2b', title: 'Auth Design' }],
    }))
    expect(mentions(heading(dom))).toEqual(['@Auth Design'])
  })

  it('a question with no attachments renders exactly as it did before the marking existed', () => {
    const { dom } = mount({ ...REPRESENTATIVE_ATTRS, question: 'What about @Auth Design?' })
    const title = heading(dom)
    expect(mentions(title)).toEqual([])
    expect(title?.textContent?.trim()).toBe('What about @Auth Design?')
  })
})
