// @ts-check
// attachment-chip.test.js — the shared attachment-chip vocabulary (#38,
// docs/design/specs/2026-08-19-attachment-block-design.md, "The chip is now a
// shared component"). AttachmentChip is a sibling of StatusBadge and LineGutter:
// PM-free, lens-blind, spec in → element out.
//
// Two things are worth testing beyond the obvious DOM shape, because both are
// load-bearing for the de-duplication:
//   • A CHIP IS NEVER BLANK. Whatever survived — a title, only an address —
//     labels it, because a chip nobody can identify has stopped being one.
//   • THE TOKENS ARE THE EXTENSION POINT. The sheet must read `--chip-*` rather
//     than restating literals, or a caller that differs has no way to differ
//     except by copying the appearance, which is the duplication this removed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AttachmentChip } from '../src/static/block/renderers/attachment-chip.js'
import { RendererStyleRegistry } from '../src/static/block/renderers/renderer-style-registry.js'

const q = (/** @type {HTMLElement} */ el, /** @type {string} */ part) =>
  /** @type {HTMLElement|null} */ (el.querySelector('.sieve-attachment-chip__' + part))

describe('AttachmentChip — the chip itself', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('draws a labelled chip carrying its address as identity', () => {
    const el = new AttachmentChip({ uri: 'container:9f2b', label: 'Auth Design' }).element
    expect(el.className).toBe('sieve-attachment-chip')
    expect(el.getAttribute('data-uri')).toBe('container:9f2b')
    expect(q(el, 'label')?.textContent).toBe('Auth Design')
    expect(el.textContent).toContain('Auth Design')
  })

  it('falls back to the address when there is no label — a chip is never blank', () => {
    const el = new AttachmentChip({ uri: 'container:gone' }).element
    expect(q(el, 'label')?.textContent).toBe('container:gone')
  })

  it('renders the optional trailing detail, and omits the element entirely when absent', () => {
    const withDetail = new AttachmentChip({ uri: 'block:1', label: 'swagger.yml', detail: 'OpenAPI · 412 KB' }).element
    expect(q(withDetail, 'detail')?.textContent).toBe('OpenAPI · 412 KB')

    const without = new AttachmentChip({ uri: 'block:1', label: 'swagger.yml' }).element
    expect(q(without, 'detail')).toBe(null)
  })

  it('carries the tooltip that tells two same-labelled chips apart', () => {
    const el = new AttachmentChip({ uri: 'container:aaa', label: 'Notes', tooltip: 'Library / Notes' }).element
    expect(el.getAttribute('title')).toBe('Library / Notes')
    expect(new AttachmentChip({ uri: 'container:aaa', label: 'Notes' }).element.hasAttribute('title')).toBe(false)
  })

  it('MISSING is a modifier and a marker, not an error — still labelled, still addressed', () => {
    const el = new AttachmentChip({ uri: 'container:gone', missing: true }).element
    expect(el.className).toBe('sieve-attachment-chip sieve-attachment-chip--missing')
    expect(q(el, 'icon')?.textContent).toBe('⚠')
    expect(q(el, 'label')?.textContent).toBe('container:gone')
    expect(el.getAttribute('data-uri')).toBe('container:gone')
  })

  it('the icon is decorative and overridable', () => {
    const icon = q(new AttachmentChip({ uri: 'container:1', label: 'x' }).element, 'icon')
    expect(icon?.getAttribute('aria-hidden')).toBe('true')
    expect(q(new AttachmentChip({ uri: 'container:1', label: 'x', icon: '◎' }).element, 'icon')?.textContent).toBe('◎')
  })

  it('a label is TEXT, never markup — a title comes from a document nobody here wrote', () => {
    const evil = '<img src=x onerror="alert(1)">'
    const el = new AttachmentChip({ uri: 'container:evil', label: evil }).element
    expect(el.querySelector('img')).toBe(null)
    expect(q(el, 'label')?.textContent).toBe(evil)
  })

  it('trims the spec — whitespace is not a label and not an address', () => {
    const el = new AttachmentChip({ uri: '  container:9f2b  ', label: '   ' }).element
    expect(el.getAttribute('data-uri')).toBe('container:9f2b')
    expect(q(el, 'label')?.textContent).toBe('container:9f2b')
  })

  it('survives an empty spec, and no spec at all', () => {
    expect(() => new AttachmentChip()).not.toThrow()
    const el = new AttachmentChip({}).element
    expect(el.hasAttribute('data-uri')).toBe(false)
    expect(q(el, 'label')?.textContent).toBe('')
  })
})

describe('AttachmentChip — activation', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('reports the address to whoever registered for it, and stops on unsubscribe', () => {
    const chip = new AttachmentChip({ uri: 'container:9f2b', label: 'Auth Design' })
    /** @type {string[]} */ const opened = []
    const off = chip.onActivate((uri) => opened.push(uri))

    chip.element.click()
    expect(opened).toEqual(['container:9f2b'])

    off()
    chip.element.click()
    expect(opened).toEqual(['container:9f2b'])
  })

  it('fans out to every listener, and one that throws does not silence the rest', () => {
    const chip = new AttachmentChip({ uri: 'container:9f2b', label: 'Auth Design' })
    /** @type {string[]} */ const seen = []
    chip.onActivate(() => { throw new Error('boom') })
    chip.onActivate((uri) => seen.push(uri))
    expect(() => chip.element.click()).not.toThrow()
    expect(seen).toEqual(['container:9f2b'])
  })

  it('a chip with no address is inert — there is nothing to open', () => {
    const chip = new AttachmentChip({ label: 'orphan' })
    let fired = 0
    chip.onActivate(() => { fired++ })
    chip.element.click()
    expect(fired).toBe(0)
    expect(chip.uri).toBe('')
  })

  it('a click never reaches the block behind it, and mousedown never starts a selection', () => {
    const chip = new AttachmentChip({ uri: 'container:9f2b', label: 'Auth Design' })
    const host = document.createElement('div')
    host.appendChild(chip.element)
    document.body.appendChild(host)

    let bubbled = 0
    host.addEventListener('click', () => { bubbled++ })
    chip.element.click()
    expect(bubbled).toBe(0)

    const down = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true })
    chip.element.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
  })
})

// ── Style carriage + the token seam ──────────────────────────────────────────
// The component carries its own sheet (#43's convention) and that sheet reads
// TOKENS. Both halves matter: the sheet is what makes the chip drawable in any
// lens, and the tokens are what let the composer — which cannot import a
// renderer — draw the same chip without a second copy of the appearance.

describe('AttachmentChip — styles', () => {
  beforeEach(() => {
    document.adoptedStyleSheets = []
    document.head.querySelectorAll('style[data-sieve-renderer]').forEach((el) => el.remove())
  })

  it('carries a stylesheet keyed on its own class, hanging off its own selector', () => {
    expect(AttachmentChip.styles).toContain('.sieve-attachment-chip')
    expect(AttachmentChip.ROOT_CLASS).toBe('sieve-attachment-chip')
  })

  it('registers that sheet through the shared registry, and it parses into real rules', () => {
    new RendererStyleRegistry().register(AttachmentChip)
    expect(document.adoptedStyleSheets.length).toBe(1)
    const rules = Array.from(document.adoptedStyleSheets[0].cssRules)
    expect(rules.length).toBeGreaterThan(3)
    expect(rules[0].cssText.indexOf('.sieve-attachment-chip')).toBe(0)
  })

  it('draws EVERY shared value from a --chip-* token, not a literal', () => {
    for (const token of [
      'var(--chip-gap)', 'var(--chip-padding)', 'var(--chip-radius)',
      'var(--chip-border-color)', 'var(--chip-accent)', 'var(--chip-max-width)',
      'var(--chip-tint-strength)', 'var(--chip-tint-strength-hover)',
    ]) {
      expect(AttachmentChip.styles).toContain(token)
    }
  })

  // --doc-size is declared on .editor-panel, not :root, so a :root token derived
  // from it substitutes against nothing and the whole declaration goes invalid —
  // every chip would inherit its parent's size (measured: 40px in a 40px body).
  // A block chip scales with the document; panel chrome does not. Not a token.
  it('scales its type off --doc-size in its own rule, never through a :root token', () => {
    expect(AttachmentChip.styles).toContain('font-size: calc(var(--doc-size) * 0.72)')
    expect(AttachmentChip.styles).not.toContain('var(--chip-font-size)')
  })

  // A custom property whose value contains var() is substituted where it is
  // DECLARED and inherits already-resolved. A pre-mixed `--chip-tint` at :root
  // would therefore freeze at :root's accent and strength, and the dangling
  // variant below would keep the blue fill — which is exactly what the first cut
  // of this change did, caught by computing both rule sets in a real engine.
  it('mixes the fill where it PAINTS, never from a pre-derived tint token', () => {
    expect(AttachmentChip.styles).toContain('color-mix(in srgb, var(--chip-accent) var(--chip-tint-strength), transparent)')
    expect(AttachmentChip.styles).toContain('color-mix(in srgb, var(--chip-accent) var(--chip-tint-strength-hover), transparent)')
    expect(AttachmentChip.styles).not.toContain('var(--chip-tint)')
    expect(AttachmentChip.styles).not.toContain('var(--chip-tint-hover)')
  })

  it('states the dangling variant as token overrides, so the base rules grey themselves out', () => {
    expect(AttachmentChip.styles).toContain('--chip-accent: var(--theme-muted)')
    expect(AttachmentChip.styles).toContain('--chip-tint-strength-hover: 12%')
  })

  it('names no colour literal — every colour is a --theme-* or --chip-* var (house rule)', () => {
    expect(AttachmentChip.styles).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(AttachmentChip.styles).not.toMatch(/\brgba?\(/)
  })
})
