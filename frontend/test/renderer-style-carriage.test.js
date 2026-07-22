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
import { REGION } from '../src/static/block/renderers/block-renderer.js'
import { SieveBlock } from '../src/static/block/sieve-block.js'
import { serviceRig } from './helpers/service-rig.js'

/** @param {object} [payload] */
function blk(payload) { return new SieveBlock('demo', payload || {}) }

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

describe('BlockRenderer (the renderer half — APPROVED contract rev 2)', () => {
  beforeEach(clearInjectedStyles)

  it('is abstract — direct instantiation throws ContractViolation', () => {
    expect(() => new BlockRenderer(blk())).toThrow(ContractViolation)
  })

  it('a subclass that does not implement update(block) throws ContractViolation at CONSTRUCTION', () => {
    class BareRenderer extends BlockRenderer {}
    expect(() => new BareRenderer(blk())).toThrow(ContractViolation)
  })

  it('construction with a raw attr map (the wire costume) throws ContractViolation — envelopes only', () => {
    class DemoRenderer extends BlockRenderer { update(block) { super.update(block) } }
    expect(() => new DemoRenderer(/** @type {any} */ ({ id: 'x' }))).toThrow(ContractViolation)
  })

  it('registers static styles exactly once across multiple instantiations of a concrete subclass', () => {
    class DemoRenderer extends BlockRenderer {
      static styles = '.demo { color: var(--theme-accentPrimary); }'
      update(block) { super.update(block) }
    }

    new DemoRenderer(blk())
    new DemoRenderer(blk())
    new DemoRenderer(blk())

    const matches = document.adoptedStyleSheets.filter((sheet) =>
      Array.from(sheet.cssRules).some((rule) => rule.cssText.indexOf('.demo') === 0))
    expect(matches.length).toBe(1)
  })

  it('render() builds DOM from the envelope alone, stamps data-id, and get body is a pure accessor', () => {
    class DemoRenderer extends BlockRenderer {
      static styles = '.demo2 { color: var(--theme-text); }'
      static rootClass = 'demo2-root'
      /** @returns {HTMLElement} */
      buildBody() {
        const el = document.createElement('div')
        el.className = 'demo2'
        el.textContent = /** @type {any} */ (this.block.payload).label
        return el
      }
      /** @param {SieveBlock} block */
      update(block) {
        super.update(block)
        if (this.body) this.body.textContent = /** @type {any} */ (block.payload).label
      }
    }

    const renderer = new DemoRenderer(blk({ id: 'demo-1', label: 'hello' }))
    const root = renderer.render()
    expect(root.className).toBe('demo2-root')
    expect(root.getAttribute('data-id')).toBe('demo-1')   // renderer stamps its own data-*
    const body = renderer.body
    expect(body?.textContent).toBe('hello')
    expect(renderer.body).toBe(body)  // pure accessor: same element, no side effect
    renderer.update(blk({ id: 'demo-1', label: 'updated' }))
    expect(body?.textContent).toBe('updated')
  })

  it('handleBuild claim (false) records the region as externally managed, skips the hook, and the container is the recorded region element', () => {
    let hookRan = false
    class DemoRenderer extends BlockRenderer {
      buildBody() { hookRan = true; return document.createElement('p') }
      update(block) { super.update(block) }
    }
    /** @type {HTMLElement|null} */
    let claimed = null
    const handleBuild = (_r, region, container) => {
      if (region !== REGION.BODY) return true
      container.className = 'lens-owned'      // the handler may DECORATE its claim
      claimed = container
      return false
    }
    const r = new DemoRenderer(blk({ id: 'demo-2' }), null, handleBuild)
    const root = r.render()
    expect(hookRan).toBe(false)                          // hook skipped
    expect(r.externallyManaged(REGION.BODY)).toBe(true)  // claim recorded
    expect(r.body).toBe(claimed)                         // container IS the region
    expect(claimed && root.contains(claimed)).toBe(true)
  })

  it('undeclared core verbs throw ContractViolation; declared base verbs route through the service; scratch instances are inert', () => {
    class DemoRenderer extends BlockRenderer { update(block) { super.update(block) } }

    // Scratch instance (no service): verbs that push are inert, never throw.
    const scratch = new DemoRenderer(blk({ id: 'demo-3' }))
    expect(() => scratch.retry()).not.toThrow()
    expect(() => scratch.setContent('x')).not.toThrow()
    // Undeclared verbs throw regardless of service.
    expect(() => scratch.setMode('render')).toThrow(ContractViolation)
    expect(() => scratch.expand()).toThrow(ContractViolation)

    // Live instance: base verbs frame blockId-addressed FROZEN ops on the
    // document's channel (issue #49 Phase 1 — appliers are retired; the base
    // setContent default maps to the `content` attr).
    const { service, sock } = serviceRig({ blocks: [{ id: 'demo-3', kind: 'demo' }] })
    const live = new DemoRenderer(blk({ id: 'demo-3' }), service)
    live.retry()
    live.setContent('new text')
    expect(sock.sent.map((x) => JSON.parse(x))).toEqual([
      { type: 'retry-block-job', uuid: 'doc-1', id: 'demo-3' },
      { type: 'block-op', uuid: 'doc-1', op: { type: 'update-block', blockId: 'demo-3', kind: 'demo', attrs: { content: 'new text' } } },
    ])
  })
})
