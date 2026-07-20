// @ts-check
// block-renderer.js — BlockRenderer: the renderer half of the renderer/
// NodeView split (docs/design/specs/2026-07-20-block-renderer-extraction.md;
// shape documented in docs/how-to-intelligent-fenced-blocks.md "Renderer /
// NodeView split"). Re-exported from fenced-block-base.js — every fenced
// block extension already imports its shared machinery from there.
//
// A concrete renderer (a real ES class extending BlockRenderer, one per
// kind — Phase 2's diagram pilot is the first):
//   - builds DOM from attrs alone via mount()/update() — no ProseMirror
//     import, no editor/view reference, no window.* bus; it runs identically
//     in a chat turn, an embedded card, or the bare-page harness
//   - carries its own look-and-feel as `static styles` — CSS text using ONLY
//     --theme-* variables for colour (the host<->renderer styling contract) —
//     registered exactly once per class, the first time an instance is
//     constructed, via the shared RendererStyleRegistry
//
// The NodeView relates to a renderer by COMPOSITION, never inheritance: a
// NodeView adapter HOLDS a renderer instance (constructs it, calls
// mount/update/destroy, and separately owns PM-only concerns —
// ignoreMutation, selectNode, stopEvent, buildPlugins). A NodeView must never
// extend BlockRenderer — that would drag PM lifecycle into the one class this
// seam keeps PM-free.
//
// Phase 1 (#44) ships this base class undriven — no kind subclasses it yet.
// Phase 2 (#45, the diagram pilot) is the first real consumer and may correct
// the exact mount/update signature; this is deliberately the minimal shape
// the seam needs, not a speculative one.

import { rendererStyles } from './renderer-style-registry.js'

// ContractViolation — thrown when a BlockRenderer subclass omits a required
// override, or when BlockRenderer itself is instantiated directly
// (docs/how-to-idiomatic-js.md §6).
export class ContractViolation extends Error {}

export class BlockRenderer {
  /** CSS text using ONLY --theme-* vars for colour. Subclasses override. */
  static styles = ''

  constructor() {
    if (new.target === BlockRenderer) {
      throw new ContractViolation('BlockRenderer is abstract — extend it, never instantiate it directly')
    }
    rendererStyles.register(new.target)
  }

  /**
   * Build this renderer's DOM from attrs alone.
   * @param {object} attrs
   * @returns {HTMLElement}
   */
  mount(attrs) {
    throw new ContractViolation(`${this.constructor.name} must implement mount(attrs)`)
  }

  /**
   * Patch previously-mounted DOM for changed attrs.
   * @param {HTMLElement} dom
   * @param {object} attrs
   */
  update(dom, attrs) {
    throw new ContractViolation(`${this.constructor.name} must implement update(dom, attrs)`)
  }

  /**
   * Release timers/observers/listeners this renderer owns. Base is a no-op —
   * override only if mount()/update() acquired something to release.
   * @param {HTMLElement} dom
   */
  destroy(dom) {}
}
