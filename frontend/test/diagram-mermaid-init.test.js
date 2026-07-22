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

describe('DiagramTheme.buildMermaidInit', () => {
  it('suppresses mermaid body-level error rendering (bad source is tolerated)', () => {
    const init = DiagramTheme.buildMermaidInit()
    expect(init.suppressErrorRendering).toBe(true)
  })

  it('never starts on load (render is renderer-driven)', () => {
    expect(DiagramTheme.buildMermaidInit().startOnLoad).toBe(false)
  })
})
