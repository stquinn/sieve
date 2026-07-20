// @ts-check
// block-renderer.js — BlockRenderer: the renderer half of the renderer/
// NodeView split (docs/design/archive/specs/2026-07-20-block-renderer-extraction.md;
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
//
// Body/title pull-back (docs/design/archive/specs/2026-07-20-block-renderer-extraction.md
// "Body/title pull-back", DEFECT SEC-B / issue #48): fillTitle/fillBody below
// are the renderer's fill CONTRACT for the two markdown content lanes.
// markdown-it is to text bodies what mermaid is to diagrams — an engine the
// RENDERER owns, never the framework seam or the editor's own instance.
// TITLE rendering is renderer-side in EVERY lens (PM included — titles are
// contentEditable=false static DOM everywhere); this retires the
// `titleEl.innerHTML = renderMarkdown(...)` SEC-B vector architecturally.
// BODY stays framework/PM-owned in the note lens (document membership —
// selection, targeting, decorations, round-trip — is a PM concern, not a
// markdown concern); fillBody exists for future non-PM hosts (chat turns,
// embedded cards) that claim no contentDOM at all.

import { rendererStyles } from './renderer-style-registry.js'
import { renderSanctionedMarkdown } from './sanctioned-markdown.js'
import { applyHighlighting } from './highlighting.js'

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

  /**
   * Default TITLE fill: the sanctioned markdown-it instance (html:false) →
   * innerHTML, then applyHighlighting (the sieve-rendered-content marker +
   * syntax colours for any fenced code the title happens to contain). PM-free
   * — runs identically in the note editor's NodeView adapter, a chat turn, an
   * embedded card, or the bare-page harness. Callers (the framework title
   * seam, or a future non-PM host) are expected to skip calling this for
   * empty text and to own show/hide of the containing region themselves —
   * this method only fills content into an element it's handed.
   * @param {HTMLElement} el
   * @param {string} text — non-empty markdown text
   */
  fillTitle(el, text) {
    el.innerHTML = renderSanctionedMarkdown(text)
    applyHighlighting(el)
  }

  /**
   * Default BODY fill for non-PM hosts. The note editor's PM lens suppresses
   * this and claims contentDOM directly instead (sieve-block-extension.js's
   * contentProvider seam): document membership — selection, targeting,
   * decorations, round-trip — is a PM concern, but markdown rendering itself
   * is editor-independent (§Content lanes), so a future non-PM host gets a
   * working body renderer for free by simply not suppressing this.
   * @param {HTMLElement} el
   * @param {string} markdown
   */
  fillBody(el, markdown) {
    el.innerHTML = markdown ? renderSanctionedMarkdown(markdown) : '<p></p>'
    applyHighlighting(el)
  }
}
