// @ts-check
// LineGutter — the shared line-number gutter builder for the kinds with a
// raw-text body. PM-free: DOM in, DOM mutated. No renderer state, no attrs
// shape — just a gutter element and the source text whose line count it tracks.

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
      // The number is CSS pseudo-content (span::before { content: attr(data-ln) }),
      // never a text node: WebKit ignores user-select inside a contenteditable
      // host, so real text here leaks line numbers into copied selections.
      span.dataset.ln = String(i)
      gutterEl.appendChild(span)
    }
  }
}
