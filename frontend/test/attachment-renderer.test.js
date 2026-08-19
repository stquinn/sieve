// @ts-check
// attachment-renderer.test.js — the 'attachment' kind's look-and-feel class
// (#38, docs/design/specs/2026-08-19-attachment-block-design.md). Bare-page
// protocol: render() alone yields the complete block, with no ProseMirror, no
// editor and no window.* in sight.
//
// Four things here are load-bearing rather than mechanical, and each has a
// reason it can silently regress:
//
//   • DANGLING IS NOT THE ERROR STATUS. The processor settles a reference whose
//     target is gone as COMPLETE with a non-empty `error`, KEEPING the cached
//     face. A renderer that greys on `status === 'ERROR'` would draw every
//     dangling block as if it were fine.
//   • THE CHIP IS NOT A CARD. It shrink-wraps and it lifts the ai-block footer's
//     15rem clamp, because in a document the chip is the block's whole identity.
//   • DOUBLE click opens, single click does not. Single click belongs to the
//     shared interaction policy (it selects the block); a handler here would
//     fight it, and the two gestures differing is deliberate.
//   • THE INTENT NAMES NO MECHANISM. The renderer reports WHAT to open, never
//     how — a hosted build with no file manager has to be able to answer
//     differently without this class changing.
import { describe, it, expect, afterEach } from 'vitest'
import { AttachmentRenderer } from '../src/static/block/renderers/attachment-renderer.js'
import { SieveBlock } from '../src/static/block/sieve-block.js'

/** @param {object} payload */
function blk(payload) { return new SieveBlock('attachment', payload) }

/** render() alone = the complete block (bare-page protocol). */
function mount(payload) {
  const renderer = new AttachmentRenderer(blk(payload))
  const dom = renderer.render()
  document.body.appendChild(dom)
  return { renderer, dom }
}

const chipOf = (/** @type {HTMLElement} */ dom) =>
  /** @type {HTMLElement} */ (dom.querySelector('.sieve-attachment-chip'))
const partOf = (/** @type {HTMLElement} */ dom, /** @type {string} */ part) =>
  /** @type {HTMLElement|null} */ (dom.querySelector('.sieve-attachment-chip__' + part))
const chevronOf = (/** @type {HTMLElement} */ dom) =>
  /** @type {HTMLElement|null} */ (dom.querySelector('.attachment-block__chevron'))
const summaryOf = (/** @type {HTMLElement} */ dom) =>
  /** @type {HTMLElement} */ (dom.querySelector('.attachment-block__summary'))

/** A real bubbling double click on `el`. */
function dblclick(/** @type {HTMLElement} */ el) {
  el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
}

/** A held file, resolved. */
const HELD = {
  id: 'at-1', src: 'swagger.yml', uri: '', title: '', targetKind: 'yaml',
  summary: 'openapi: 3.0.0', bytes: '421888', mime: 'text/yaml',
  status: 'COMPLETE', error: '', createdAt: '2026-08-19T10:00:00Z',
}

/** A citation, resolved. */
const CITES = {
  id: 'at-2', src: '', uri: 'container:9f2b', title: 'Auth Design', targetKind: 'note',
  summary: 'Token rotation and session binding', bytes: '', mime: '',
  status: 'COMPLETE', error: '', createdAt: '2026-08-19T10:00:00Z',
}

afterEach(() => { document.body.innerHTML = '' })

describe('AttachmentRenderer — the block is a chip', () => {
  it('draws ONE chip inside a shrink-wrapping line, and no card shell', () => {
    const { dom } = mount(CITES)
    expect(dom.className).toBe('attachment-block')
    expect(dom.getAttribute('data-id')).toBe('at-2')
    expect(dom.getAttribute('data-kind')).toBe('attachment')
    expect(dom.querySelectorAll('.sieve-attachment-chip').length).toBe(1)
    expect(chipOf(dom).parentElement?.className).toBe('attachment-block__line')
    // No header bar, no toolbar, no status badge: that is card furniture.
    expect(dom.querySelector('.sieve-block__heading')).toBe(null)
    expect(dom.querySelector('.ai-block__badge')).toBe(null)
  })

  it('labels a citation with its cached title and carries the coordinate as identity', () => {
    const { dom } = mount(CITES)
    expect(partOf(dom, 'label')?.textContent).toBe('Auth Design')
    expect(chipOf(dom).getAttribute('data-uri')).toBe('container:9f2b')
    expect(chipOf(dom).getAttribute('title')).toBe('container:9f2b')
  })

  it('labels a held file with its filename when nothing has titled it, and is NOT addressed', () => {
    const { dom } = mount(HELD)
    expect(partOf(dom, 'label')?.textContent).toBe('swagger.yml')
    // A held file has no coordinate — the chip's own click activation is inert,
    // which is right: this block opens on a double click.
    expect(chipOf(dom).hasAttribute('data-uri')).toBe(false)
  })

  it('prefers an explicit title over the filename, and strips a path-qualified src', () => {
    const { dom } = mount({ ...HELD, title: 'Payments API' })
    expect(partOf(dom, 'label')?.textContent).toBe('Payments API')
    expect(AttachmentRenderer.filenameOf('.assets/swagger.yml')).toBe('swagger.yml')
    expect(AttachmentRenderer.filenameOf('a/b/c.pdf')).toBe('c.pdf')
  })

  it('is never blank — an attachment addressing nothing is still a label', () => {
    const { dom } = mount({ id: 'at-3', status: 'COMPLETE' })
    expect(partOf(dom, 'label')?.textContent).toBe('Attachment')
  })
})

describe('AttachmentRenderer — kind and size as quiet secondary text', () => {
  it('reads "yaml · 412 KB" after the label for a held file', () => {
    const { dom } = mount(HELD)
    expect(partOf(dom, 'detail')?.textContent).toBe('yaml · 412 KB')
  })

  it('shortens to the kind alone for a citation, and omits the slot entirely when neither is known', () => {
    expect(partOf(mount(CITES).dom, 'detail')?.textContent).toBe('note')
    document.body.innerHTML = ''
    expect(partOf(mount({ id: 'x', uri: 'container:1', status: 'PENDING' }).dom, 'detail')).toBe(null)
  })

  it('ignores the reserved `kind` attr — the block kind never describes the target', () => {
    // `kind` is the FRAMEWORK's attr (BASE_ATTRS) for the block's own kind, which
    // is why this processor spells its own as `targetKind`. A payload carrying
    // both must read the latter; regressing to `kind` would print "attachment"
    // as if it described the file.
    const { dom } = mount({ ...HELD, targetKind: '', kind: 'attachment' })
    expect(partOf(dom, 'detail')?.textContent).toBe('412 KB')
  })

  it('formats sizes the way the processor does, and renders nothing for an unparseable one', () => {
    expect(AttachmentRenderer.humanSize('900')).toBe('900 B')
    expect(AttachmentRenderer.humanSize('1536')).toBe('1.5 KB')
    expect(AttachmentRenderer.humanSize('421888')).toBe('412 KB')
    expect(AttachmentRenderer.humanSize('5242880')).toBe('5.0 MB')
    expect(AttachmentRenderer.humanSize('')).toBe('')
    expect(AttachmentRenderer.humanSize('later')).toBe('')
    expect(AttachmentRenderer.humanSize('-1')).toBe('')
  })
})

describe('AttachmentRenderer — dangling is a normal state', () => {
  const DANGLING = {
    ...CITES,
    status: 'COMPLETE',                                   // NOT 'ERROR' — the resolve completed
    error: 'nothing answers for container:9f2b any more', // and found nothing
  }

  it('greys a COMPLETE block carrying an error, KEEPING the face it cached', () => {
    const { dom } = mount(DANGLING)
    expect(chipOf(dom).className).toContain('sieve-attachment-chip--missing')
    // Still identifiable, still addressed: a reference whose target is gone
    // still says what it pointed at.
    expect(partOf(dom, 'label')?.textContent).toBe('Auth Design')
    expect(chipOf(dom).getAttribute('data-uri')).toBe('container:9f2b')
    expect(chipOf(dom).getAttribute('title')).toBe(DANGLING.error)
  })

  it('does not grey a COMPLETE block with no error — the ordinary case', () => {
    expect(chipOf(mount(CITES).dom).className).toBe('sieve-attachment-chip')
  })

  it('greys a genuinely FAILED job too — one predicate, because neither can be opened', () => {
    const { dom } = mount({ ...HELD, status: 'ERROR', error: 'attachment: read swagger.yml: no such asset' })
    expect(chipOf(dom).className).toContain('sieve-attachment-chip--missing')
    expect(partOf(dom, 'label')?.textContent).toBe('swagger.yml')
  })

  it('dims while the job is still in flight', () => {
    const { dom } = mount({ id: 'at-9', uri: 'container:9f2b', status: 'PENDING', createdAt: new Date().toISOString() })
    expect(dom.className).toContain('attachment-block--pending')
    expect(mount(CITES).dom.className).not.toContain('attachment-block--pending')
  })
})

describe('AttachmentRenderer — the chevron reads the asset in place', () => {
  it('offers no chevron when there is nothing to reveal', () => {
    const { dom } = mount({ ...CITES, summary: '' })
    expect(chevronOf(dom)).toBe(null)
    expect(summaryOf(dom).className).not.toContain('--shown')
  })

  it('reveals the summary on the chip, not in a header bar', () => {
    const { dom, renderer } = mount(CITES)
    const chevron = chevronOf(dom)
    expect(chevron).not.toBe(null)
    // ON the chip: a flex child of it, so the two hover as one object.
    expect(chevron?.parentElement?.className).toContain('sieve-attachment-chip')
    expect(summaryOf(dom).textContent).toBe(CITES.summary)
    expect(summaryOf(dom).className).not.toContain('--shown')

    chevron?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(renderer.expanded).toBe(true)
    expect(summaryOf(dom).className).toContain('attachment-block__summary--shown')
    expect(chevronOf(dom)?.getAttribute('aria-expanded')).toBe('true')

    chevronOf(dom)?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(renderer.expanded).toBe(false)
    expect(summaryOf(dom).className).not.toContain('--shown')
  })

  it('keeps the disclosure open across a render-back, and re-fills the revealed text', () => {
    const { dom, renderer } = mount(CITES)
    renderer.toggleSummary(true)
    renderer.update(blk({ ...CITES, summary: 'Rewritten by the resolve' }))
    expect(renderer.expanded).toBe(true)
    expect(summaryOf(dom).textContent).toBe('Rewritten by the resolve')
    expect(summaryOf(dom).className).toContain('--shown')
  })

  it('cannot be expanded into nothing', () => {
    const { renderer, dom } = mount({ ...CITES, summary: '' })
    expect(renderer.toggleSummary(true)).toBe(false)
    expect(summaryOf(dom).className).not.toContain('--shown')
  })
})

describe('AttachmentRenderer — double click opens, and names no mechanism', () => {
  it('reports the COORDINATE for a block that points', () => {
    const { dom, renderer } = mount(CITES)
    /** @type {any[]} */ const seen = []
    renderer.onOpen((t) => seen.push(t))
    dblclick(chipOf(dom))
    expect(seen).toEqual([{ uri: 'container:9f2b', src: '', title: 'Auth Design' }])
  })

  it('reports the ASSET for a block that holds — no URL, no path, no file manager', () => {
    const { dom, renderer } = mount(HELD)
    /** @type {any[]} */ const seen = []
    renderer.onOpen((t) => seen.push(t))
    dblclick(chipOf(dom))
    expect(seen).toEqual([{ uri: '', src: 'swagger.yml', title: 'swagger.yml' }])
  })

  it('resolves the (illegal) both-set case the way the processor does — uri wins', () => {
    expect(AttachmentRenderer.targetFor({ src: 'a.yml', uri: 'container:1', title: 'T' }))
      .toEqual({ uri: 'container:1', src: '', title: 'T' })
    expect(AttachmentRenderer.targetFor({})).toBe(null)
  })

  it('does NOT fire on a single click — selecting the block is the shared policy’s', () => {
    const { dom, renderer } = mount(CITES)
    let fired = 0
    renderer.onOpen(() => { fired++ })
    chipOf(dom).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(fired).toBe(0)
  })

  it('does NOT fire from the chevron — reading in place is not opening', () => {
    const { dom, renderer } = mount(CITES)
    let fired = 0
    renderer.onOpen(() => { fired++ })
    const chevron = chevronOf(dom)
    if (chevron) dblclick(chevron)
    expect(fired).toBe(0)
  })

  it('does nothing at all for a block that addresses nothing', () => {
    const { dom, renderer } = mount({ id: 'at-3', status: 'COMPLETE' })
    let fired = 0
    renderer.onOpen(() => { fired++ })
    dblclick(chipOf(dom))
    expect(fired).toBe(0)
  })

  it('unsubscribes cleanly, and survives a listener that throws', () => {
    const { dom, renderer } = mount(CITES)
    let good = 0
    const off = renderer.onOpen(() => { throw new Error('boom') })
    renderer.onOpen(() => { good++ })
    dblclick(chipOf(dom))
    expect(good).toBe(1)
    off()
    dblclick(chipOf(dom))
    expect(good).toBe(2)
  })

  it('copies the address, or the filename when it holds one', () => {
    expect(new AttachmentRenderer(blk(CITES)).copyText()).toBe('container:9f2b')
    expect(new AttachmentRenderer(blk(HELD)).copyText()).toBe('swagger.yml')
    expect(new AttachmentRenderer(blk({})).copyText()).toBe('')
  })
})

describe('AttachmentRenderer — the stylesheet', () => {
  // No clearing here: the registry's register-once set is a module singleton, so
  // emptying document.adoptedStyleSheets would prove nothing (the second
  // register is a no-op by design). Counting the sheets that survive every
  // instance built by this whole file is the property that matters.
  it('registers exactly once however many instances are built', () => {
    new AttachmentRenderer(blk(CITES))
    new AttachmentRenderer(blk(HELD))
    new AttachmentRenderer(blk({}))
    const mine = document.adoptedStyleSheets.filter((sheet) =>
      Array.from(sheet.cssRules).some((rule) => rule.cssText.indexOf('.attachment-block') === 0))
    expect(mine.length).toBe(1)
  })

  it('names no colour of its own — every one is a --theme-*/--chip-* token', () => {
    const css = AttachmentRenderer.styles
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(css).not.toMatch(/\brgba?\(/)
    expect(css).toContain('var(--theme-fg2)')
    expect(css).toContain('var(--chip-accent)')
  })

  it('shrink-wraps rather than filling the line, and lifts the footer chip’s clamp', () => {
    const css = AttachmentRenderer.styles
    expect(css).toContain('width: max-content')
    // `max-width: 100%` is the text column's bound and is fine; a bare
    // `width: 100%` would be the card behaviour this kind refuses.
    expect(css).not.toMatch(/(^|[^-])width: 100%/m)
    // The clamp is the ROW's to set: saying nothing here is what lets the block's
    // chip carry a full title, bounded only by the text column.
    expect(css).not.toContain('--chip-max-width')
  })

  it('flips the chevron by swapping its glyph — no transform inside a contentEditable', () => {
    expect(AttachmentRenderer.styles).not.toContain('transform')
  })
})
