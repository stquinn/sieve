// @ts-check
// BlockRenderer: a LIVE, STATEFUL, LENS-BLIND, PROTOCOL-BLIND object that BUILDS
// ITSELF and speaks BUSINESS VERBS.
//
//   constructor(block, provider?, handleBuild?)
//       - block        : the typed SieveBlock, never a raw attr map
//       - provider     : the outbound effect boundary — a BlockContainerProvider.
//                        A renderer speaks facade verbs and never a transport.
//                        Omitted for SCRATCH instances, which are inert.
//       - handleBuild  : nullable region-build interceptor (HANDLE IT OR I WILL),
//                        the one channel a lens uses to take over a region:
//                        handleBuild(renderer, region, container, block) → bool.
//                        false → EXTERNALLY MANAGED: the base places `container`,
//                        records the claim, skips the hook, and update() skips
//                        the region permanently.
//
//   render()  — base TEMPLATE (subclasses NEVER override): the shell, then per
//               region [consult handler → else invoke the build hook] in canonical
//               order (Header · Title · Body · Footer). render() ALONE yields the
//               complete block; each build hook runs EXACTLY once.
//
//   update(block) — THE inbound truth channel. A kind-authored override MUST call
//               super.update(block) first, then patch via recorded slot refs.
//
//   Core semantic API (setMode · setContent · retry · expand) — consumers NEVER
//   see an attribute name or wire value. Kind-specific verbs live on the
//   subclass, self-invoked by its own chrome or called by a consumer that
//   constructed the concrete type. Never instanceof-sniffed.
//
//   _pushAttrs/_pushContent — the ONLY places semantic verbs become schema, so
//   each attr name appears in exactly one class: the kind's renderer.
//
// A renderer NEVER imports ProseMirror, never receives an editor/view reference,
// never touches window.* app buses, and its public API names no PM concept.

import { rendererStyles } from './renderer-style-registry.js'
import { renderSanctionedMarkdown } from './sanctioned-markdown.js'
import { applyHighlighting } from './highlighting.js'
import { SieveBlock, ContractViolation } from '../contract/sieve-block.js'

export { ContractViolation }

/** The block anatomy's region tokens (frozen, string-valued — DOM/debug legible). */
export const REGION = Object.freeze({ HEADER: 'header', TITLE: 'title', BODY: 'body', FOOTER: 'footer' })

export class BlockRenderer {
  /** CSS text using ONLY --theme-* vars for colour. Subclasses override. */
  static styles = ''

  /**
   * Root element class(es), declared as DATA. The block roots are heterogeneous
   * (`sieve-block--diagram`, `sieve-ai-block ai-block`, `web-clip-block`, …), so
   * the shell class stays kind-owned rather than canonical.
   * @type {string}
   */
  static rootClass = ''

  /** @type {SieveBlock} */ #block
  /** @type {import('../contract/container-provider.js').BlockContainerProvider|null} */ #provider
  /** @type {((renderer: BlockRenderer, region: string, container: HTMLElement, block: SieveBlock) => boolean)|null} */ #handleBuild
  /** @type {Set<string>} */ #external = new Set()
  /** @type {HTMLElement|null} */ #root = null
  /** @type {HTMLElement|null} */ #header = null
  /** @type {HTMLElement|null} */ #title = null
  /** @type {HTMLElement|null} */ #footer = null
  /** @type {HTMLElement|null} */ #body = null

  /**
   * @param {SieveBlock} block  the typed block
   * @param {import('../contract/container-provider.js').BlockContainerProvider|null} [provider]  omitted for scratch instances
   * @param {(renderer: BlockRenderer, region: string, container: HTMLElement, block: SieveBlock) => boolean} [handleBuild]
   */
  constructor(block, provider, handleBuild) {
    if (new.target === BlockRenderer) {
      throw new ContractViolation('BlockRenderer is abstract — extend it, never instantiate it directly')
    }
    if (!(block instanceof SieveBlock)) {
      throw new ContractViolation(`${new.target.name}: construct with a SieveBlock, never a raw attr map`)
    }
    if (this.update === BlockRenderer.prototype.update) {
      throw new ContractViolation(`${new.target.name} must implement update(block)`)
    }
    rendererStyles.register(new.target)
    this.#block = block
    this.#provider = provider || null
    this.#handleBuild = handleBuild || null
  }

  get block() { return this.#block }
  get id() { return this.#block.id }
  /** The block root element (available after render()). */
  get root() { return this.#root }
  get header() { return this.#header }
  get title() { return this.#title }
  /** The recorded BODY region: hook-built, or a container a lens claimed. */
  get body() { return this.#body }
  get footer() { return this.#footer }
  /** Is this region externally managed (claimed via handleBuild)? @param {string} region */
  externallyManaged(region) { return this.#external.has(region) }

  /**
   * Build the complete block DOM — shell, then Header · Title · Body · Footer.
   * @returns {HTMLElement}
   */
  render() {
    if (this.#root) return this.#root   // guard against a double render()
    const root = document.createElement('div')
    const cls = /** @type {typeof BlockRenderer} */ (this.constructor).rootClass
    if (cls) root.className = cls
    if (this.id) root.setAttribute('data-id', this.id)
    if (this.#block.kind) root.setAttribute('data-kind', this.#block.kind)
    this.#root = root

    const header = this.#buildRegion(root, REGION.HEADER, () => this.buildHeader())
    this.#header = header && header.nodeType === 1 ? /** @type {HTMLElement} */ (header) : null

    const title = this.#buildRegion(root, REGION.TITLE, () => this.buildTitle(), (el) => {
      el.classList.add('sieve-block__heading')
      el.contentEditable = 'false'
    })
    this.#title = title && title.nodeType === 1 ? /** @type {HTMLElement} */ (title) : null

    const body = this.#buildRegion(root, REGION.BODY, () => this.buildBody())
    this.#body = body && body.nodeType === 1 ? /** @type {HTMLElement} */ (body) : null

    const footer = this.#buildRegion(root, REGION.FOOTER, () => this.buildFooter(), (el) => {
      el.classList.add('sieve-block__footer')
    })
    this.#footer = footer && footer.nodeType === 1 ? /** @type {HTMLElement} */ (footer) : null

    return root
  }

  /**
   * One region: consult the interceptor, else run the hook. A claimed region gets
   * a base-made container the handler may DECORATE before returning false; the
   * hook is skipped and never sees the region.
   * @param {HTMLElement} root @param {string} region @param {() => Node|null} hook
   * @param {(el: HTMLElement) => void} [stamp]  uniform framework stamping
   * @returns {Node|null}
   */
  #buildRegion(root, region, hook, stamp) {
    if (this.#handleBuild) {
      const container = document.createElement('div')
      if (this.#handleBuild(this, region, container, this.#block) === false) {
        this.#external.add(region)
        if (stamp) stamp(container)
        root.appendChild(container)
        return container
      }
    }
    const el = hook()
    if (el) {
      if (stamp && el.nodeType === 1) stamp(/** @type {HTMLElement} */ (el))
      root.appendChild(el)
    }
    return el
  }

  /** Build the HEADER region, or null. @returns {Node|null} */
  buildHeader() { return null }
  /** Build the TITLE region, or null. @returns {HTMLElement|null} */
  buildTitle() { return null }
  /** Build the FOOTER region, or null. Ships unused. @returns {Node|null} */
  buildFooter() { return null }
  /** Build + fill the BODY, recording slot refs. @returns {Node|null} */
  buildBody() { return null }

  /**
   * THE inbound truth channel. A kind override MUST call super.update(block)
   * first, then patch via recorded slot refs — claimed regions recorded no refs,
   * so ref-guarded patches skip them naturally.
   * @param {SieveBlock} block
   */
  update(block) {
    if (!(block instanceof SieveBlock)) {
      throw new ContractViolation(`${this.constructor.name}.update: expects a SieveBlock`)
    }
    this.#block = block
  }

  /** Release timers/observers/listeners this renderer owns. Base is a no-op. */
  destroy() {}

  /**
   * The plain text a consumer copies for this block: the kind's own
   * bodyMarkdown() when it exposes one, else ''. Kinds with a cleaner raw value
   * override it.
   * @returns {string}
   */
  copyText() {
    const self = /** @type {any} */ (this)
    return typeof self.bodyMarkdown === 'function' ? String(self.bodyMarkdown() || '') : ''
  }

  /**
   * Switch presentation mode (MODE enum). Kinds declaring modes override.
   * @param {string} _mode
   */
  setMode(_mode) {
    throw new ContractViolation(`${this.constructor.name} does not declare modes (setMode)`)
  }

  /**
   * Outbound content truth report. Never paints the displayed body — in an editor
   * lens that body is PM's; truth returns via update(block).
   * @param {string} text
   */
  setContent(text) { this._pushContent(text) }

  /** Re-run the block's backend job. Kind-blind — Go knows what retry means. */
  retry() {
    if (this.#provider) this.#provider.requestRetry(this.id)
  }

  /** Expand into the lightbox. Expandable kinds override. */
  expand() {
    throw new ContractViolation(`${this.constructor.name} is not expandable (expand)`)
  }

  /**
   * The ONLY place a kind's semantic verbs become wire schema. Scratch instances
   * have no provider and are inert: they author, never effect.
   * @protected @param {Record<string, any>} patch
   */
  _pushAttrs(patch) {
    if (this.#provider) this.#provider.requestSetBlock(this.id, patch)
  }

  /**
   * Hand the block's own text over. Which attr a kind keeps its text in is the
   * host's to resolve, so nothing here names one.
   * @protected @param {string} text
   */
  _pushContent(text) {
    if (this.#provider) this.#provider.flush(this.id, text)
  }

  /**
   * TITLE/BODY markdown fill via the SANCTIONED markdown-it instance (html:false,
   * never the editor's html:true one), then highlight.
   * @param {HTMLElement} el @param {string} text — non-empty markdown text
   */
  fillTitle(el, text) {
    el.innerHTML = renderSanctionedMarkdown(text)
    applyHighlighting(el)
  }

  /**
   * Fill a title region from possibly-empty text, or HIDE it when empty (no
   * region, no divider).
   * @param {HTMLElement} el @param {string} [text]
   */
  fillTitleSlot(el, text) {
    const h = (text || '').trim()
    if (!h) { el.innerHTML = ''; el.style.display = 'none'; return }
    this.fillTitle(el, h)
    el.style.display = ''
  }

  /**
   * Fill a markdown body (empty → an empty paragraph).
   * @param {HTMLElement} el @param {string} markdown
   */
  fillBody(el, markdown) {
    el.innerHTML = markdown ? renderSanctionedMarkdown(markdown) : '<p></p>'
    applyHighlighting(el)
  }
}
