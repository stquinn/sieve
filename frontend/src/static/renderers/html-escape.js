// @ts-check
// html-escape.js — esc: HTML-escape a string for safe interpolation into an
// attribute value or element markup.
//
// A single-purpose, single-export module (not a Utilities grab-bag): the block
// HTML builders that assemble data-* divs by string concatenation — the node
// registry's buildBlockHTML + the code/log/diagram node-views' rendered
// innerHTML — all need the same escape, and none of them OWNS it (it is a pure
// string transform). It lives in renderers/ (the HTML-rendering package)
// beside the other renderer engines (sanctioned-markdown, highlighting). Moved
// here from base/fenced-block-base.js when that grab-bag dissolved (issue #49
// P5; retires TECH-DEBT X-D).

/** @param {any} str @returns {string} */
export function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
