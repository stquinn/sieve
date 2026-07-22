// @ts-check
// diagram-mermaid-init.test.js — pins the mermaid init config's error
// tolerance. A diagram's source is INVALID BY DEFINITION mid-typing; without
// suppressErrorRendering mermaid (v10.9+) appends its error element straight
// to document.body on every failed parse — a layout-breaking "banner" that
// survives until app reload (observed 2026-07-22 on the markdown→wysiwyg flip
// of a note with bad mermaid source). The renderer's own catch shows the
// in-block error panel; mermaid must never touch the document.
import { describe, it, expect } from 'vitest'
import { DiagramTheme } from '../src/static/block/renderers/diagram-renderer.styles.js'
import { codeStyles } from '../src/static/block/renderers/code-renderer.styles.js'

/**
 * Extracts the declaration map of the rule whose selector list matches
 * `selectorRe` in a CSS sheet string. Throws when the rule is absent —
 * a renamed selector must fail loudly, not pass vacuously.
 * @param {string} sheet @param {RegExp} selectorRe @returns {Record<string, string>}
 */
function ruleDecls(sheet, selectorRe) {
  const m = sheet.match(selectorRe)
  if (!m || typeof m[1] !== 'string') throw new Error('rule not found: ' + selectorRe)
  /** @type {Record<string, string>} */
  const out = {}
  for (const decl of m[1].split(';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim()
  }
  return out
}

/** @param {'code'|'diagram'} kind @returns {[RegExp, RegExp, RegExp]} edit-metrics, gutter, gutter-span rules */
function selectors(kind) {
  return [
    new RegExp(`\\.sieve-block--${kind} \\.sieve-block__highlight,\\s*\\.sieve-block--${kind} \\.sieve-block__edit \\{([^}]*)\\}`),
    new RegExp(`\\.sieve-block--${kind} \\.sieve-block__gutter \\{([^}]*)\\}`),
    new RegExp(`\\.sieve-block--${kind} \\.sieve-block__gutter span \\{([^}]*)\\}`),
  ]
}

// happy-dom exposes window.getComputedStyle but not the bare browser global
// the production code calls — bridge it for this suite.
if (typeof globalThis.getComputedStyle === 'undefined') {
  globalThis.getComputedStyle = window.getComputedStyle.bind(window)
}

describe('DiagramTheme.sheet — edit-surface metric parity with CodeTheme', () => {
  // The diagram and code edit surfaces are THE SAME AFFORDANCE (gutter +
  // layered source editor). Observed 2026-07-22: diagram carried its own px
  // metrics (12px/18px, px paddings, 10px gutter numbers) while code uses the
  // em set — visibly different text size, gutter typography, and alignment.
  // Pin the three metric rules to literal equality so the surfaces cannot
  // drift apart again; kind-specific structure (grid template, min-heights,
  // render body) stays free.
  const [codeEdit, codeGutter, codeSpan] = selectors('code').map((re) => ruleDecls(codeStyles, re))
  const [diaEdit, diaGutter, diaSpan] = selectors('diagram').map((re) => ruleDecls(DiagramTheme.sheet, re))

  it('edit/highlight layer metrics are identical', () => {
    expect(diaEdit).toEqual(codeEdit)
  })
  it('gutter metrics are identical', () => {
    expect(diaGutter).toEqual(codeGutter)
  })
  it('gutter line-number span metrics are identical', () => {
    expect(diaSpan).toEqual(codeSpan)
  })
})

describe('DiagramTheme.sheet — edit-mode inline-code neutralisation', () => {
  // editor.css's `.tiptap code` styles INLINE code as an accent-green pill
  // (background, padding, radius, 0.85em). The diagram edit surface's inner
  // <code> sits inside .tiptap, so without this kind-local reset the pill
  // (and its smaller line box) applies to the source text — the background-
  // behind-just-the-text + gutter misalignment defect. CodeTheme carries the
  // same reset; the two edit surfaces must stay visually identical.
  it('resets the global .tiptap code pill on both edit layers', () => {
    expect(DiagramTheme.sheet).toContain('.sieve-block--diagram .sieve-block__edit code')
    expect(DiagramTheme.sheet).toContain('.sieve-block--diagram .sieve-block__highlight code')
  })
})

describe('DiagramTheme.buildMermaidInit', () => {
  it('suppresses mermaid body-level error rendering (bad source is tolerated)', () => {
    const init = DiagramTheme.buildMermaidInit()
    expect(init.suppressErrorRendering).toBe(true)
  })

  it('never starts on load (render is renderer-driven)', () => {
    expect(DiagramTheme.buildMermaidInit().startOnLoad).toBe(false)
  })
})
