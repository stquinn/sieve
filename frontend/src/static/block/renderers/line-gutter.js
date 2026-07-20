// @ts-check
// line-gutter.js — LineGutter: the shared line-number gutter builder (survey
// item A2, docs/design/specs/2026-07-20-block-renderer-extraction.md, Phase 4
// / issue #47). 'code' (Phase 4) carried a private per-instance copy of this
// exact span-per-line builder (mirroring DiagramRenderer's Phase-2 shape);
// 'log' needs an identical one for its raw-text body, so at log's migration
// this is the SECOND real consumer and the method is hoisted to a shared
// class here, replacing both kinds' duplicate builders (CodeRenderer now
// calls LineGutter.sync too). Diagram's own private #updateGutter is
// deliberately left untouched — out of scope for this hoist (the survey
// scopes it to code+log); a future opportunity, not this change's job.
//
// PM-free: DOM in, DOM mutated. No renderer state, no attrs shape — just a
// gutter element and the source text whose line count it must track.

export class LineGutter {
  /**
   * Rebuilds gutterEl's line-number `<span>` children to match source's line
   * count — a no-op if the count hasn't changed (keeps repeated calls, e.g.
   * every keystroke via a MutationObserver, cheap).
   * @param {HTMLElement} gutterEl
   * @param {string} source
   */
  static sync(gutterEl, source) {
    const lines = (source || '').split('\n')
    const count = Math.max(lines.length, 1)
    if (gutterEl.childElementCount === count) return
    gutterEl.innerHTML = ''
    for (let i = 1; i <= count; i++) {
      const span = document.createElement('span')
      span.textContent = String(i)
      gutterEl.appendChild(span)
    }
  }
}
