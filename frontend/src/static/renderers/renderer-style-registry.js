// @ts-check
// Register-once-per-class stylesheet carriage: a class declares `static styles`
// (CSS text using ONLY --theme-* vars for colour) and this registry injects that
// CSS into the document exactly once per class, the first time an instance of
// the class is constructed. BlockRenderer does it in its base constructor;
// non-renderer components call rendererStyles.register(TheClass) in their own.
//
// Two injection strategies sit behind one contract — `inject(cssText, key)` —
// chosen by feature detection at construction:
//   - AdoptedSheetStrategy — new CSSStyleSheet() + document.adoptedStyleSheets.
//     One parse, shared across every mount. The PRIMARY strategy.
//   - StyleElementStrategy — a single deduplicated <style data-sieve-renderer="…">
//     per class. The portable fallback for hosts without adoptedStyleSheets
//     (embedded/exported artefacts, older engines, non-browser hosts).

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

  // Feature detection, not an engine allowlist — a real runtime check, so the
  // fallback stays reachable for any host that lacks adoptedStyleSheets.
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

// The app-wide singleton every BlockRenderer subclass registers through.
export const rendererStyles = new RendererStyleRegistry()
