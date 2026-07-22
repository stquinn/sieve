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

// happy-dom exposes window.getComputedStyle but not the bare browser global
// the production code calls — bridge it for this suite.
if (typeof globalThis.getComputedStyle === 'undefined') {
  globalThis.getComputedStyle = window.getComputedStyle.bind(window)
}

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
