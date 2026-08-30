// @ts-check
// BlockIdentity — the DOM markers a document block is resolved by, and the one
// way to take them off DOM that is NOT a document block.
//
// Every id resolver in the tree is an ANCESTOR walk (`closest('[data-id]')`), so
// a piece of DOM that presents one answers as the block that was gestured at. An
// ELEMENT — a block living inside another block's payload, drawn in a question
// or projected into an answer — has no coordinate in the document, so an
// extract, transform or delete aimed at it would name a block that does not
// exist. With no marker on it the nearest one is the block HOSTING it, which is
// the interactable unit.
//
// Stripping once is not enough: a kind may inject content long after it was
// drawn, and that content is not always Sieve's — a rendered mermaid diagram
// carries `data-id` on its own edges. So the strip has to survive whatever a
// kind draws later, which is what `keepAnonymous` is for.

export class BlockIdentity {
  /** The DOM markers a resolver reads a document block's identity from.
   *  @type {ReadonlyArray<string>} */
  static ATTRS = Object.freeze(['data-id', 'data-block-id'])

  /**
   * Strips every document-block identity marker off an element AND its subtree —
   * a kind's chrome may stamp identity deeper than its root.
   * @param {HTMLElement} dom
   * @returns {HTMLElement} the same element, for chaining onto a render()
   */
  static strip(dom) {
    for (const attr of BlockIdentity.ATTRS) {
      dom.removeAttribute(attr)
      for (const el of dom.querySelectorAll('[' + attr + ']')) el.removeAttribute(attr)
    }
    return dom
  }

  /**
   * Keeps `el` anonymous FOR AS LONG AS IT IS DRAWN: whatever a kind adds or
   * stamps later is stripped as it lands.
   * @param {HTMLElement} el
   * @returns {MutationObserver|null} the watcher, for the caller to disconnect
   *   when it releases the DOM; null where the environment has no observer
   */
  static keepAnonymous(el) {
    if (typeof MutationObserver !== 'function') return null
    const watcher = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes' && record.target.nodeType === 1) {
          BlockIdentity.strip(/** @type {HTMLElement} */ (record.target))
        }
        for (const node of Array.from(record.addedNodes)) {
          if (node.nodeType === 1) BlockIdentity.strip(/** @type {HTMLElement} */ (node))
        }
      }
    })
    watcher.observe(el, {
      subtree: true, childList: true,
      attributes: true, attributeFilter: /** @type {string[]} */ (BlockIdentity.ATTRS.slice()),
    })
    return watcher
  }
}
