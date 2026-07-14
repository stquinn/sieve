// @ts-check
// globals.js — the ONE writer of window.GLOBALS: window-reachable app helpers
// for consumers that cannot import ES modules (index.html inline scripts).
// Each member carries a reason + death date. No anonymous additions.
import { getSieveIcon } from '../block/block-kinds.js'
// getSieveIcon: index.html inline [data-sieve-kind] icon decorator (DOMContentLoaded) — dies P4.F (inline readers → workspace.X()).
window.GLOBALS = Object.freeze({ getSieveIcon })
