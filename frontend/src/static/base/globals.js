// @ts-check
// The ONE writer of window.GLOBALS: window-reachable app helpers for consumers
// that cannot import ES modules (index.html's inline scripts). Every member
// states why it must be reachable that way. No anonymous additions.
import { getSieveIcon } from '../renderers/block-kinds.js'
// getSieveIcon: the inline [data-sieve-kind] icon decorator in index.html. Goes
// when those inline readers become workspace calls.
window.GLOBALS = Object.freeze({ getSieveIcon })
