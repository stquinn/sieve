// @ts-check
// renderer-style-carriage.test.js — Phase 1 (#44) of the block-renderer-
// extraction epic (#43). Exercises the register-once-per-class stylesheet
// seam: RendererStyleRegistry (both injection strategies) and the
// BlockRenderer base class that renderer classes will extend from Phase 2 on.
//
// happy-dom (this suite's environment, see vitest.config.js) supports
// constructable stylesheets + document.adoptedStyleSheets, including var()
// resolution through getComputedStyle — verified directly against the happy-dom
// package before writing these assertions, so the "bare page" test below is a
// real behavioural check, not a mechanical stub.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  RendererStyleRegistry,
  StyleElementStrategy,
} from '../src/static/block/renderers/renderer-style-registry.js'
import { BlockRenderer, ContractViolation } from '../src/static/base/fenced-block-base.js'

function clearInjectedStyles() {
  document.adoptedStyleSheets = []
  document.head.querySelectorAll('style[data-sieve-renderer]').forEach((el) => el.remove())
}

describe('RendererStyleRegistry', () => {
  beforeEach(clearInjectedStyles)

  it('feature-detects adoptedStyleSheets support in this test environment (true on happy-dom)', () => {
    expect(RendererStyleRegistry.supportsAdoptedStyleSheets()).toBe(true)
  })

  it('registers a class’s styles via adoptedStyleSheets exactly once, however many times register() is called', () => {
    class FakeRenderer {
      static styles = '.fake { color: var(--theme-text); }'
    }
    const registry = new RendererStyleRegistry()
    registry.register(FakeRenderer)
    registry.register(FakeRenderer)
    registry.register(FakeRenderer)

    expect(document.adoptedStyleSheets.length).toBe(1)
    expect(document.adoptedStyleSheets[0].cssRules[0].cssText).toContain('var(--theme-text)')
  })

  it('is a no-op for a class that declares no styles', () => {
    class NoStyleRenderer {}
    const registry = new RendererStyleRegistry()
    registry.register(NoStyleRenderer)
    expect(document.adoptedStyleSheets.length).toBe(0)
  })

  it('registers distinct classes independently', () => {
    class A { static styles = '.a { color: var(--theme-accentCyan); }' }
    class B { static styles = '.b { color: var(--theme-accentGreen); }' }
    const registry = new RendererStyleRegistry()
    registry.register(A)
    registry.register(B)
    expect(document.adoptedStyleSheets.length).toBe(2)
  })

  it('falls back to a single deduplicated <style data-sieve-renderer> element under the style-element strategy', () => {
    class FakeRenderer {
      static styles = '.fake2 { color: var(--theme-text); }'
    }
    const registry = new RendererStyleRegistry(new StyleElementStrategy())
    registry.register(FakeRenderer)
    registry.register(FakeRenderer)

    const els = document.head.querySelectorAll('style[data-sieve-renderer="FakeRenderer"]')
    expect(els.length).toBe(1)
    expect(els[0].textContent).toContain('var(--theme-text)')
    // adoptedStyleSheets is untouched by this strategy.
    expect(document.adoptedStyleSheets.length).toBe(0)
  })

  it('resolves a registered stylesheet’s theme-var colour given ONLY :root vars on the page (the bare-page contract)', () => {
    // Bare page: nothing but the theme vars this renderer's DOM would see in
    // any host — no app stylesheet, no editor.css.
    const rootVars = document.createElement('style')
    rootVars.textContent = ':root { --theme-text: #c0caf5; }'
    document.head.appendChild(rootVars)

    class DemoRenderer {
      static styles = '.demo-bare { color: var(--theme-text); }'
    }
    new RendererStyleRegistry().register(DemoRenderer)

    const el = document.createElement('div')
    el.className = 'demo-bare'
    document.body.appendChild(el)

    expect(getComputedStyle(el).color.toLowerCase()).toBe('#c0caf5')

    document.body.removeChild(el)
    document.head.removeChild(rootVars)
  })
})

describe('BlockRenderer (the renderer half of the renderer/NodeView split)', () => {
  beforeEach(clearInjectedStyles)

  it('is abstract — direct instantiation throws ContractViolation', () => {
    expect(() => new BlockRenderer()).toThrow(ContractViolation)
  })

  it('a subclass that does not implement mount()/update() throws ContractViolation when called', () => {
    class BareRenderer extends BlockRenderer {}
    const r = new BareRenderer()
    expect(() => r.mount({})).toThrow(ContractViolation)
    expect(() => r.update(document.createElement('div'), {})).toThrow(ContractViolation)
  })

  it('registers static styles exactly once across multiple instantiations of a concrete subclass', () => {
    class DemoRenderer extends BlockRenderer {
      static styles = '.demo { color: var(--theme-accentPrimary); }'
      /** @param {object} attrs */
      mount(attrs) {
        const dom = document.createElement('div')
        dom.className = 'demo'
        return dom
      }
      /** @param {HTMLElement} dom @param {object} attrs */
      update(dom, attrs) {}
    }

    new DemoRenderer()
    new DemoRenderer()
    new DemoRenderer()

    const matches = document.adoptedStyleSheets.filter((sheet) =>
      Array.from(sheet.cssRules).some((rule) => rule.cssText.indexOf('.demo') === 0))
    expect(matches.length).toBe(1)
  })

  it('a concrete renderer instance builds DOM from attrs alone, with no PM/editor/window.* touchpoints', () => {
    class DemoRenderer extends BlockRenderer {
      static styles = '.demo2 { color: var(--theme-text); }'
      /** @param {{ label: string }} attrs */
      mount(attrs) {
        const dom = document.createElement('div')
        dom.className = 'demo2'
        dom.textContent = attrs.label
        return dom
      }
      /** @param {HTMLElement} dom @param {{ label: string }} attrs */
      update(dom, attrs) { dom.textContent = attrs.label }
    }

    const renderer = new DemoRenderer()
    const dom = renderer.mount({ label: 'hello' })
    expect(dom.textContent).toBe('hello')
    renderer.update(dom, { label: 'updated' })
    expect(dom.textContent).toBe('updated')
  })
})
