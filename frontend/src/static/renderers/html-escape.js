// @ts-check
// esc — HTML-escape a string for safe interpolation into an attribute value or
// element markup. A single-purpose, single-export module: the block HTML
// builders that assemble data-* divs by string concatenation all need the same
// escape, and none of them OWNS it (it is a pure string transform).

/** @param {any} str @returns {string} */
export function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
