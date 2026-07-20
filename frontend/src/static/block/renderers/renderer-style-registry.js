// @ts-check
// renderer-style-registry.js — register-once-per-class stylesheet carriage for
// Sieve block renderers (docs/design/specs/2026-07-20-block-renderer-extraction.md,
// "Phase 1" — issue #44).
//
// A renderer class declares `static styles` (CSS text using ONLY --theme-* vars
// for colour — the host<->renderer styling protocol the spec commits to). This
// registry injects that CSS into the document exactly once per class, the first
// time an instance of the class is constructed (see BlockRenderer in
// fenced-block-base.js, which every renderer extends).
//
// Two injection strategies exist behind one contract — `inject(cssText, key)` —
// so the mechanism is swappable without touching callers:
//   - AdoptedSheetStrategy — new CSSStyleSheet() + document.adoptedStyleSheets.
//     One parse, shared across every mount. This is the PRIMARY strategy: the
//     app's real engine is WebKitGTK 2.52.5 (webkit2gtk-4.1, confirmed via
//     `pkg-config --modversion webkit2gtk-4.1` in the nix dev shell), which
//     comfortably post-dates the Safari 16.4-era engine that shipped
//     constructable stylesheets — no feature gap here.
//   - StyleElementStrategy — a single deduplicated <style data-sieve-renderer="…">
//     per class. Kept as the portable fallback (embedded/exported artefacts,
//     older engines, non-browser hosts) so the seam never hard-codes an engine
//     assumption — chosen automatically when adoptedStyleSheets isn't present.
//
// Strategy choice is feature-detected at construction; callers never need to
// know which one is live.

/**
 * @typedef {object} StyleInjectionStrategy
 * @property {(cssText: string, key: string) => void} inject
 */

class AdoptedSheetStrategy {
  /** @param {string} cssText */
  inject(cssText) {
    var sheet = new CSSStyleSheet()
    sheet.replaceSync(cssText)
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
  }
}

class StyleElementStrategy {
  /** @param {string} cssText @param {string} key */
  inject(cssText, key) {
    if (document.head.querySelector('style[data-sieve-renderer="' + key + '"]')) return
    var el = document.createElement('style')
    el.setAttribute('data-sieve-renderer', key)
    el.textContent = cssText
    document.head.appendChild(el)
  }
}

/** @typedef {{ styles?: string, name: string }} RendererClassLike */

export class RendererStyleRegistry {
  /** @type {Set<RendererClassLike>} */
  #registered = new Set()
  /** @type {StyleInjectionStrategy} */
  #strategy

  // Feature detection, not an engine allowlist. True on the app's real
  // WebKitGTK 2.52.5 target today; kept as a real runtime check (not a
  // hardcoded true) so the fallback stays reachable for any future host that
  // doesn't have it (embedded artefacts, older engines). A static on the
  // registry — the type that owns the strategy decision — per the
  // no-loose-functions rule.
  /** @returns {boolean} */
  static supportsAdoptedStyleSheets() {
    return typeof CSSStyleSheet !== 'undefined' &&
      typeof CSSStyleSheet.prototype.replaceSync === 'function' &&
      typeof document !== 'undefined' &&
      'adoptedStyleSheets' in document
  }

  /**
   * @param {StyleInjectionStrategy} [strategy] Override for tests, or a future
   *   engine swap. Defaults to feature detection: adopted stylesheets when
   *   supported, else the <style>-element fallback.
   */
  constructor(strategy) {
    this.#strategy = strategy || (RendererStyleRegistry.supportsAdoptedStyleSheets() ? new AdoptedSheetStrategy() : new StyleElementStrategy())
  }

  /**
   * Registers RendererClass.styles exactly once, ever, for this registry
   * instance — a no-op if the class carries no styles, or has already been
   * registered. Safe to call from every constructor invocation of the class;
   * only the first call actually injects anything.
   * @param {RendererClassLike} RendererClass
   */
  register(RendererClass) {
    if (!RendererClass || !RendererClass.styles) return
    if (this.#registered.has(RendererClass)) return
    this.#registered.add(RendererClass)
    this.#strategy.inject(RendererClass.styles, RendererClass.name)
  }
}

export { AdoptedSheetStrategy, StyleElementStrategy }

// rendererStyles — the app-wide singleton every BlockRenderer subclass
// registers through (composition-root-style singleton, not a window.* global —
// it is imported, never grabbed off `window`).
export const rendererStyles = new RendererStyleRegistry()
