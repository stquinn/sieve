// @ts-check
// The shared reference-chip vocabulary. ReferenceChip is a sibling of
// StatusBadge and LineGutter: PM-free, lens-blind, spec in → element out.
//
// Two properties beyond the DOM shape are load-bearing:
//   • A CHIP IS NEVER BLANK. Whatever survived — a title, or only an address —
//     labels it.
//   • THE TOKENS ARE THE EXTENSION POINT. The sheet must read `--chip-*` rather
//     than restating literals, or a caller that differs can only differ by
//     copying the appearance.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ReferenceChip } from '../src/static/renderers/reference-chip.js'
import { RendererStyleRegistry } from '../src/static/renderers/renderer-style-registry.js'

const q = (/** @type {HTMLElement} */ el, /** @type {string} */ part) =>
  /** @type {HTMLElement|null} */ (el.querySelector('.sieve-reference-chip__' + part))

describe('ReferenceChip — the chip itself', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('draws a labelled chip carrying its address as identity', () => {
    const el = new ReferenceChip({ uri: 'sieve://9f2b', label: 'Auth Design' }).element
    expect(el.className).toBe('sieve-reference-chip')
    expect(el.getAttribute('data-uri')).toBe('sieve://9f2b')
    expect(q(el, 'label')?.textContent).toBe('Auth Design')
    expect(el.textContent).toContain('Auth Design')
  })

  it('falls back to the address when there is no label — a chip is never blank', () => {
    const el = new ReferenceChip({ uri: 'sieve://gone' }).element
    expect(q(el, 'label')?.textContent).toBe('sieve://gone')
  })

  it('renders the optional trailing detail, and omits the element entirely when absent', () => {
    const withDetail = new ReferenceChip({ uri: 'sieve://doc-1/swagger.yml', label: 'swagger.yml', detail: 'OpenAPI · 412 KB' }).element
    expect(q(withDetail, 'detail')?.textContent).toBe('OpenAPI · 412 KB')

    const without = new ReferenceChip({ uri: 'sieve://doc-1/swagger.yml', label: 'swagger.yml' }).element
    expect(q(without, 'detail')).toBe(null)
  })

  it('carries the tooltip that tells two same-labelled chips apart', () => {
    const el = new ReferenceChip({ uri: 'sieve://aaa', label: 'Notes', tooltip: 'Library / Notes' }).element
    expect(el.getAttribute('title')).toBe('Library / Notes')
    expect(new ReferenceChip({ uri: 'sieve://aaa', label: 'Notes' }).element.hasAttribute('title')).toBe(false)
  })

  it('MISSING is a modifier and a marker, not an error — still labelled, still addressed', () => {
    const el = new ReferenceChip({ uri: 'sieve://gone', missing: true }).element
    expect(el.className).toBe('sieve-reference-chip sieve-reference-chip--missing')
    expect(q(el, 'icon')?.textContent).toBe('⚠')
    expect(q(el, 'label')?.textContent).toBe('sieve://gone')
    expect(el.getAttribute('data-uri')).toBe('sieve://gone')
  })

  it('the icon is decorative and overridable', () => {
    const icon = q(new ReferenceChip({ uri: 'sieve://1', label: 'x' }).element, 'icon')
    expect(icon?.getAttribute('aria-hidden')).toBe('true')
    expect(q(new ReferenceChip({ uri: 'sieve://1', label: 'x', icon: '◎' }).element, 'icon')?.textContent).toBe('◎')
  })

  it('a label is TEXT, never markup — a title comes from a document nobody here wrote', () => {
    const evil = '<img src=x onerror="alert(1)">'
    const el = new ReferenceChip({ uri: 'sieve://evil', label: evil }).element
    expect(el.querySelector('img')).toBe(null)
    expect(q(el, 'label')?.textContent).toBe(evil)
  })

  it('trims the spec — whitespace is not a label and not an address', () => {
    const el = new ReferenceChip({ uri: '  sieve://9f2b  ', label: '   ' }).element
    expect(el.getAttribute('data-uri')).toBe('sieve://9f2b')
    expect(q(el, 'label')?.textContent).toBe('sieve://9f2b')
  })

  it('survives an empty spec, and no spec at all', () => {
    expect(() => new ReferenceChip()).not.toThrow()
    const el = new ReferenceChip({}).element
    expect(el.hasAttribute('data-uri')).toBe(false)
    expect(q(el, 'label')?.textContent).toBe('')
  })
})

describe('ReferenceChip — activation', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('reports the address to whoever registered for it, and stops on unsubscribe', () => {
    const chip = new ReferenceChip({ uri: 'sieve://9f2b', label: 'Auth Design' })
    /** @type {string[]} */ const opened = []
    const off = chip.onActivate((uri) => opened.push(uri))

    chip.element.click()
    expect(opened).toEqual(['sieve://9f2b'])

    off()
    chip.element.click()
    expect(opened).toEqual(['sieve://9f2b'])
  })

  it('fans out to every listener, and one that throws does not silence the rest', () => {
    const chip = new ReferenceChip({ uri: 'sieve://9f2b', label: 'Auth Design' })
    /** @type {string[]} */ const seen = []
    chip.onActivate(() => { throw new Error('boom') })
    chip.onActivate((uri) => seen.push(uri))
    expect(() => chip.element.click()).not.toThrow()
    expect(seen).toEqual(['sieve://9f2b'])
  })

  it('a chip with no address is inert — there is nothing to open', () => {
    const chip = new ReferenceChip({ label: 'orphan' })
    let fired = 0
    chip.onActivate(() => { fired++ })
    chip.element.click()
    expect(fired).toBe(0)
    expect(chip.uri).toBe('')
  })

  it('a click never reaches the block behind it, and mousedown never starts a selection', () => {
    const chip = new ReferenceChip({ uri: 'sieve://9f2b', label: 'Auth Design' })
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
// The component carries its own sheet and that sheet reads TOKENS. The sheet is
// what makes the chip drawable in any lens; the tokens are what let the composer
// — which cannot import a renderer — draw the same chip without a second copy of
// the appearance.

describe('ReferenceChip — styles', () => {
  beforeEach(() => {
    document.adoptedStyleSheets = []
    document.head.querySelectorAll('style[data-sieve-renderer]').forEach((el) => el.remove())
  })

  it('carries a stylesheet keyed on its own class, hanging off its own selector', () => {
    expect(ReferenceChip.styles).toContain('.sieve-reference-chip')
    expect(ReferenceChip.ROOT_CLASS).toBe('sieve-reference-chip')
  })

  it('registers that sheet through the shared registry, and it parses into real rules', () => {
    new RendererStyleRegistry().register(ReferenceChip)
    expect(document.adoptedStyleSheets.length).toBe(1)
    const rules = Array.from(document.adoptedStyleSheets[0].cssRules)
    expect(rules.length).toBeGreaterThan(3)
    expect(rules[0].cssText.indexOf('.sieve-reference-chip')).toBe(0)
  })

  it('draws EVERY shared value from a --chip-* token, not a literal', () => {
    for (const token of [
      'var(--chip-gap)', 'var(--chip-padding)', 'var(--chip-radius)',
      'var(--chip-border-color)', 'var(--chip-accent)', 'var(--chip-max-width)',
      'var(--chip-tint-strength)', 'var(--chip-tint-strength-hover)',
    ]) {
      expect(ReferenceChip.styles).toContain(token)
    }
  })

  // --doc-size is declared on .editor-panel, not :root, so a :root token derived
  // from it substitutes against nothing and the whole declaration goes invalid —
  // every chip would inherit its parent's size (measured: 40px in a 40px body).
  // A block chip scales with the document; panel chrome does not. Not a token.
  it('scales its type off --doc-size in its own rule, never through a :root token', () => {
    expect(ReferenceChip.styles).toContain('font-size: calc(var(--doc-size) * 0.72)')
    expect(ReferenceChip.styles).not.toContain('var(--chip-font-size)')
  })

  // A custom property whose value contains var() is substituted where it is
  // DECLARED and inherits already-resolved. A pre-mixed `--chip-tint` at :root
  // would therefore freeze at :root's accent and strength, and the dangling
  // variant below would keep the blue fill — which is exactly what the first cut
  // of this change did, caught by computing both rule sets in a real engine.
  it('mixes the fill where it PAINTS, never from a pre-derived tint token', () => {
    expect(ReferenceChip.styles).toContain('color-mix(in srgb, var(--chip-accent) var(--chip-tint-strength), transparent)')
    expect(ReferenceChip.styles).toContain('color-mix(in srgb, var(--chip-accent) var(--chip-tint-strength-hover), transparent)')
    expect(ReferenceChip.styles).not.toContain('var(--chip-tint)')
    expect(ReferenceChip.styles).not.toContain('var(--chip-tint-hover)')
  })

  it('states the dangling variant as token overrides, so the base rules grey themselves out', () => {
    expect(ReferenceChip.styles).toContain('--chip-accent: var(--theme-muted)')
    expect(ReferenceChip.styles).toContain('--chip-tint-strength-hover: 12%')
  })

  it('names no colour literal — every colour is a --theme-* or --chip-* var (house rule)', () => {
    expect(ReferenceChip.styles).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(ReferenceChip.styles).not.toMatch(/\brgba?\(/)
  })
})
