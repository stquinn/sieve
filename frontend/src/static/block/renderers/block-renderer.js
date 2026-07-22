// @ts-check
// block-renderer.js — BlockRenderer: the renderer half of the renderer/
// NodeView split. NORMATIVE contract:
// docs/design/specs/2026-07-21-block-renderer-contract.md (APPROVED rev 2).
//
// A renderer is a LIVE, STATEFUL, LENS-BLIND, PROTOCOL-BLIND object that
// BUILDS ITSELF and speaks BUSINESS VERBS. Contract:
//
//   constructor(block, blockService?, handleBuild?)
//       - block        : the typed SieveBlock envelope (NEVER a raw attr map —
//                        raw maps are the wire costume and cross no consumer
//                        signature)
//       - blockService : the outbound effect boundary (BlockService). Omitted
//                        for SCRATCH (authoring) instances — live-vs-scratch
//                        reads directly off the constructor call.
//       - handleBuild  : nullable region-build interceptor (paste-handler
//                        idiom: HANDLE IT OR I WILL) — the one channel a lens
//                        uses to take over a region's content:
//                          handleBuild(renderer, region, container, block) → bool
//                          absent/true → base builds the region normally
//                          false       → region is EXTERNALLY MANAGED: the base
//                                        places `container`, records the claim,
//                                        skips the hook — and update() skips it
//                                        permanently (the kind's ref-guarded
//                                        patches never saw slot refs recorded)
//
//   render()  — base TEMPLATE (subclasses NEVER override): stamps data-id,
//               builds the shell, then per region [consult handler → default:
//               invoke build hook] in canonical order (Header · Title · Body ·
//               Footer). render() ALONE yields the complete block; each build
//               hook runs EXACTLY once; adapters never write renderer DOM.
//
//   update(block) — THE inbound truth channel. Kind-authored override; MUST
//               call super.update(block) first (stores the envelope), then
//               patch via recorded slot refs.
//
//   Core semantic API — consumers NEVER see an attribute name or wire value:
//     setMode(mode)    MODE enum; declared kinds override (ContractViolation
//                      otherwise), mapping the enum to their wire strings
//                      privately via _pushAttrs.
//     setContent(text) outbound truth report (the editor lens's sync closure
//                      ends here, never at a socket).
//     retry()          re-run the block's backend job (kind-blind).
//     expand()         one behaviour, three triggers (chord / header / menu);
//                      expandable kinds override.
//   Kind-specific verbs live on the subclass (resize, setColumns, …) under the
//   abstract-consumer rule: self-invoked by the kind's own chrome, or called by
//   a consumer that constructed the concrete type. Never instanceof-sniffed.
//
//   _pushAttrs/_pushContent — the ONLY places semantic verbs become schema
//   (each attr name appears in exactly one class: the kind's renderer).
//   @protected by convention: JS #private fields don't cross the subclass
//   boundary, so these are underscore-marked instead — same contract.
//
// A renderer NEVER imports ProseMirror, never receives an editor/view
// reference, never touches window.* app buses, and its public API names no PM
// concept. Header layout uses the header-provider family + HeaderBar
// (header-bar.js) as collaborators inside buildHeader().

import { rendererStyles } from './renderer-style-registry.js'
import { renderSanctionedMarkdown } from './sanctioned-markdown.js'
import { applyHighlighting } from './highlighting.js'
import { SieveBlock, ContractViolation } from '../sieve-block.js'

// ContractViolation lives at the leaf (sieve-block.js) so services import it
// downward; re-exported here for the established import path (incl.
// fenced-block-base.js's re-export).
export { ContractViolation }

/** The block anatomy's region tokens (frozen, string-valued — DOM/debug legible). */
export const REGION = Object.freeze({ HEADER: 'header', TITLE: 'title', BODY: 'body', FOOTER: 'footer' })

export class BlockRenderer {
  /** CSS text using ONLY --theme-* vars for colour. Subclasses override. */
  static styles = ''

  /**
   * Root element class(es), declared as DATA — the block roots are
   * heterogeneous (`sieve-block--diagram`, `sieve-ai-block ai-block`,
   * `web-clip-block`, `image-block node-image`, …), so the shell class stays
   * kind-owned rather than canonical.
   * @type {string}
   */
  static rootClass = ''

  /** @type {SieveBlock} */ #block
  /** @type {import('../block-service.js').BlockService|null} */ #service
  /** @type {((renderer: BlockRenderer, region: string, container: HTMLElement, block: SieveBlock) => boolean)|null} */ #handleBuild
  /** @type {Set<string>} */ #external = new Set()
  /** @type {HTMLElement|null} */ #root = null
  /** @type {HTMLElement|null} */ #header = null
  /** @type {HTMLElement|null} */ #title = null
  /** @type {HTMLElement|null} */ #footer = null
  /** @type {HTMLElement|null} */ #body = null

  /**
   * @param {SieveBlock} block  the typed envelope
   * @param {import('../block-service.js').BlockService|null} [blockService]  omitted for scratch instances
   * @param {(renderer: BlockRenderer, region: string, container: HTMLElement, block: SieveBlock) => boolean} [handleBuild]
   */
  constructor(block, blockService, handleBuild) {
    if (new.target === BlockRenderer) {
      throw new ContractViolation('BlockRenderer is abstract — extend it, never instantiate it directly')
    }
    if (!(block instanceof SieveBlock)) {
      throw new ContractViolation(`${new.target.name}: construct with a SieveBlock envelope, never a raw attr map`)
    }
    if (this.update === BlockRenderer.prototype.update) {
      throw new ContractViolation(`${new.target.name} must implement update(block)`)
    }
    rendererStyles.register(new.target)
    this.#block = block
    this.#service = blockService || null
    this.#handleBuild = handleBuild || null
  }

  // ── Accessors ─────────────────────────────────────────────────────────────
  /** The current typed envelope (updated by update(block)). */
  get block() { return this.#block }
  /** The block id (from the envelope). */
  get id() { return this.#block.id }
  /** The block root element (available after render()). */
  get root() { return this.#root }
  /** The recorded HEADER region element, or null. */
  get header() { return this.#header }
  /** The recorded TITLE region element, or null. */
  get title() { return this.#title }
  /** The recorded BODY region element (hook-built, or the externally-managed
   *  container a lens claimed via handleBuild). */
  get body() { return this.#body }
  /** The recorded FOOTER region element, or null. */
  get footer() { return this.#footer }
  /** Is this region externally managed (claimed via handleBuild)? @param {string} region */
  externallyManaged(region) { return this.#external.has(region) }

  // ── Template method (NOT overridden) ──────────────────────────────────────

  /**
   * Build the complete block DOM — shell then Header · Title · Body · Footer.
   * Per region: consult handleBuild (claim → base places the claim container,
   * records it, skips the hook); default → invoke the build hook exactly once
   * and append its result directly (no wrapper).
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
      // The one uniform region class the framework stamps.
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
   * One region: consult the interceptor, else run the hook. Claimed regions
   * get a base-made container the handler may DECORATE (classes, attributes)
   * before returning false; the hook is skipped and never sees the region.
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

  // ── Hooks ─────────────────────────────────────────────────────────────────

  /** Build the HEADER region, or null. @returns {Node|null} */
  buildHeader() { return null }
  /** Build the TITLE region, or null. @returns {HTMLElement|null} */
  buildTitle() { return null }
  /** Build the FOOTER region, or null. Ships unused. @returns {Node|null} */
  buildFooter() { return null }
  /** Build + fill the BODY, recording slot refs. @returns {Node|null} */
  buildBody() { return null }

  /**
   * THE inbound truth channel. Kind overrides MUST call super.update(block)
   * first (stores the envelope), then patch via recorded slot refs — claimed
   * regions recorded no refs, so ref-guarded patches skip them naturally.
   * @param {SieveBlock} block
   */
  update(block) {
    if (!(block instanceof SieveBlock)) {
      throw new ContractViolation(`${this.constructor.name}.update: expects a SieveBlock envelope`)
    }
    this.#block = block
  }

  /** Release timers/observers/listeners this renderer owns. Base is a no-op. */
  destroy() {}

  // ── Core semantic API ─────────────────────────────────────────────────────

  /**
   * Switch presentation mode (MODE enum). Kinds declaring modes override,
   * mapping the enum to their wire strings privately.
   * @param {string} _mode
   */
  setMode(_mode) {
    throw new ContractViolation(`${this.constructor.name} does not declare modes (setMode)`)
  }

  /**
   * Outbound content truth report/command. Never paints the displayed body —
   * in an editor lens that body is PM's; truth returns via update(block).
   * @param {string} text
   */
  setContent(text) { this._pushContent(text) }

  /** Re-run the block's backend job. Kind-blind — Go knows what retry means. */
  retry() {
    if (this.#service) this.#service.retry(this.id)
  }

  /** Expand into the lightbox. Expandable kinds override. */
  expand() {
    throw new ContractViolation(`${this.constructor.name} is not expandable (expand)`)
  }

  // ── Schema push seam (@protected by convention — see file header) ─────────

  /**
   * The ONLY place a kind's semantic verbs become wire schema. Scratch
   * instances (no service) are inert — they author, never effect.
   * @protected @param {Record<string, any>} patch
   */
  _pushAttrs(patch) {
    if (this.#service) this.#service.updateAttributes(this.id, patch)
  }

  /** @protected @param {string} text */
  _pushContent(text) {
    if (this.#service) this.#service.setContent(this.id, text)
  }

  // ── Internal sanctioned-markdown fill helpers ─────────────────────────────

  /**
   * TITLE/BODY markdown fill via the SANCTIONED markdown-it instance
   * (html:false — SEC-B #48, never the editor's html:true one), then highlight.
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
   * Fill a markdown body (empty → an empty paragraph). Same SEC-B invariant.
   * @param {HTMLElement} el @param {string} markdown
   */
  fillBody(el, markdown) {
    el.innerHTML = markdown ? renderSanctionedMarkdown(markdown) : '<p></p>'
    applyHighlighting(el)
  }
}
