// sieve-block-extension.js — Sieve block node factory + the node-view registry.
//
// A block KIND is contributed by registering an ADAPTER (historically "renderer")
// with the registry: `registerSieveRenderer('code', CodeNodeView)` mints a TipTap
// node named 'sieve-code' from the adapter's schema/attrs and wires its NodeView.
// getSieveNodes() then includes it automatically — no editor wiring per kind.
//
// The adapter contract is the typedef below (supersedes the old prose "Renderer
// interface" comment): it documents every member the factory actually reads —
// surveyed from the real call sites, nothing aspirational.
//
// @typedef {Object} SieveNodeView
//   The object an adapter's makeNodeView returns — a TipTap NodeView, plus the
//   optional `renderer` handle migrated kinds expose.
// @property {HTMLElement} dom                  block root element (required)
// @property {HTMLElement} [contentDOM]         editable content host (live PM body)
// @property {(node: any) => boolean} [update]  TipTap NodeView update hook
// @property {(event: Event) => boolean} [stopEvent] TipTap NodeView stopEvent hook
// @property {import('../../../renderers/block-renderer.js').BlockRenderer} [renderer]
//   the BlockRenderer instance a MIGRATED kind exposes — enables the framework's
//   PM body projection (bodyMarkdown) and TITLE fill (fillTitle).
//
// @typedef {Object} SieveBlockAdapter
//   The kind contract registered via registerSieveRenderer. All members are
//   optional except makeNodeView; the factory feature-detects each.
// @property {(node: any, editor: any, getPos: (() => number), ctx: object) => SieveNodeView} makeNodeView
//   Builds the NodeView (required).
// @property {{atom?: boolean, selectable?: boolean, draggable?: boolean,
//   content?: string, marks?: string, code?: boolean, defining?: boolean}} [nodeConfig]
//   ProseMirror schema overrides (schema-level, fixed at editor-init time). There
//   is no `group`/`inline` knob: EVERY registered kind is a top-level member of
//   the document list (group 'sieveBlock', a <div>). Inline blocks were removed
//   with smart-link — docs/design/archive/specs/2026-07-27-inline-block-removal-links-decision.md.
// @property {Record<string, any>} [attrs]      kind-specific TipTap attr defs (merged with BASE_ATTRS).
// @property {(data: object) => Record<string, any>} [parseAttrs]
//   Parsed-YAML → the extra data-* attributes the kind needs on initial parse.
// @property {(type: any) => any[]} [buildPlugins]           per-kind ProseMirror plugins.
// @property {(node: any) => ({mimeType: string, content: string, context?: object}[]|null)} [asContentEntry]
//   the kind's own clipboard/text views (code → source, diagram → mermaid, …).
// @property {(arg: {node: any, editorPane: any, getPos: Function, provider: any, getEditor: Function}) => any[]} [buildContextMenuItems]
//   kind-specific context-menu items, prepended before the framework items.
// @property {(node: any) => ({contextLabel?: string, imageIds?: string[]})} [buildAiCtx]
//   customises the "Ask About [X]" label / included image ids.
// @property {Partial<import('../interaction-policy.js').InteractionPolicy>} [interactionPolicy]
//   declared interaction policy — the behaviours this kind opts into, by name.
//   Typed against the real DEFAULT_POLICY shape (it read `{expandable?: boolean}`
//   until 2026-07-29, so every other flag a kind declared went unchecked and a
//   typo'd name silently fell back to the default).
// @property {(node: any, dom: HTMLElement) => any} [getExpandContent]  lightbox/expand spec, or null.
// @property {(node?: any) => string} [getFriendlyName]      display name for menus/labels.
// @property {(data: object) => string} [getInitialContentHTML]  initial inner HTML for a non-atom kind.
// @property {(sourceNode: any, entries: any[], dispatch: Function, opts: {operation: string}) => any[]} [getExtractionMenuItems]
//   kind-authored extraction menu items (else the framework builds a default).
//   A kind implements this to offer a CHOICE the framework cannot know about
//   (web-clip's Fetch/Summarise) — never to reword the action. The VERB must be
//   DERIVED from labelForAction (renderers/action-label.js), which is the one verb map
//   and the one regression gate; restating it is how web-clip drifted into a
//   private "Upgrade to" (#67).
// @property {(state: any, node: any) => void} [markdownSerialize]  markdown-storage serialize override.
// @property {{render: (attrs: object, ctx: object) => HTMLElement}} [headerProvider]  LEGACY header seam.
// @property {string|((attrs: object) => any)} [titleProvider]                        LEGACY title seam.
// @property {string|((attrs: object) => any)} [contentProvider]                      LEGACY content seam.
// @property {string|((attrs: object) => any)} [markdownProvider]                     LEGACY content seam (alias).
// @property {string} [markdownAttr]                                                  LEGACY content seam (alias).
//
// Adding a new block kind:
//   1. Create lens/document-editor/surfaces/node-views/<kind>-node-view.js implementing the adapter above.
//   2. Add <script type="module" src="/ui/static/lens/document-editor/surfaces/node-views/<kind>-node-view.js">
//      to index.html AFTER lens/document-editor/surfaces/sieve-block-extension.js (the node-view
//      registers at its own top level; the registry must exist first).

import { esc } from '../../../renderers/html-escape.js'
import { isJobStale } from '../../../renderers/job-status.js'
import { getLowlight, applyHighlighting } from '../../../renderers/highlighting.js'
import { renderSanctionedMarkdown } from '../../../renderers/sanctioned-markdown.js'
import { T } from './tiptap-vendor.js'
import { registerBlockKind, getBlockBehaviour, containsChildBlocks } from '../../../renderers/block-kinds.js'
import { labelForAction } from '../../../renderers/action-label.js'
import { expandBlock } from '../../../ui/media-lightbox.js'
import { HeaderBar } from '../../../renderers/header-bar.js'
import { SieveBlock } from '../../../contract/sieve-block.js'
import { BlockSelection } from '../block-selection.js'

// sieveBlockFor — the SEAM's block constructor for adapters (block-first
// flow, contract §typed block). MODEL-FIRST (issue #96): the node's id
// resolves the mounted container's follower model — what Go holds — and on a hit
// that block's attrs are the base, with the kind-owned live overlay applied on
// top (overlay wins). On a MISS — no provider, no id, or an id the container does
// not hold (a node the user just typed, a scratch instance) — it falls back to
// SieveBlock.from(node), the PM-RESURRECT path. Overlay precedence is uniform
// across both paths: overlay > model.
/**
 * @param {{ type: { name: string }, attrs: Record<string, any> }} node
 * @param {Record<string, any>} [overlay]  kind-owned live fields (e.g. {source: textContent})
 * @param {{ getBlock: (id: string) => ({kind: string, attrs: Record<string, any>}|null) }} [provider]
 *   the mounted container's provider (node-views pass ctx.provider)
 * @returns {SieveBlock}
 */
export function sieveBlockFor(node, overlay, provider) {
  const id = node && node.attrs && node.attrs.id
  const hit = (provider && id) ? provider.getBlock(id) : null
  if (hit) return new SieveBlock(hit.kind, Object.assign({}, hit.attrs, overlay || {}))
  return SieveBlock.from(node, overlay)
}

// ── TITLE slot fill decision ─────────────────────────────────────────────────
// syncBlockTitle — the TITLE slot's fill decision (pure DOM, no PM). Body/title
// pull-back (docs/design/archive/specs/2026-07-20-block-renderer-extraction.md
// "Body/title pull-back", DEFECT SEC-B / issue #48): TITLE rendering is
// renderer-side in every lens, PM included — this seam DELEGATES to the held
// renderer's fillTitle (a BlockRenderer instance the NodeView adapter exposes
// as `view.renderer`, e.g. lens/surfaces/node-views/ai-block-node-view.js,
// lens/surfaces/node-views/web-clip-node-view.js) instead of writing innerHTML
// itself. Kinds with no split renderer (prose — native, no NodeView) have no
// `view.renderer` — the fallback uses the SANCTIONED instance
// (renderSanctionedMarkdown, html:false) directly, never the editor's html:true
// one, so every path here is SEC-B-safe regardless of migration state.
export function syncBlockTitle(titleEl, renderer, text) {
  var h = (text || '').trim()
  if (!h) {
    titleEl.innerHTML = ''
    titleEl.style.display = 'none'   // empty → no region, no divider
    return
  }
  if (renderer && typeof renderer.fillTitle === 'function') {
    renderer.fillTitle(titleEl, h)
  } else {
    titleEl.innerHTML = renderSanctionedMarkdown(h)
    applyHighlighting(titleEl)
  }
  titleEl.style.display = ''
}

// serializeNode turns a single block node into markdown via the editor's OWN
// markdown serialiser. The serialiser sizes code fences longer than any backtick
// run in the content, so this is the only safe way to render a node to a fence —
// never hand-build ```. The node is wrapped in a fresh doc so the serialiser has a
// valid root. Returns '' on failure (e.g. a node the serialiser can't handle).
export function serializeNode(editor, node) {
  try {
    var wrapper = editor.state.schema.topNodeType.create(null, node)
    return (editor.storage.markdown.serializer.serialize(wrapper) || '').trim()
  } catch (err) {
    console.error('[sieve] serializeNode failed', err)
    return ''
  }
}

// sieveBlockAttrs returns a plain own-property copy of a sieve node's attrs — the
// canonical serialisable representation of a block. Single source of truth so every
// wire path (extraction entries, single-block clipboard, sieve/slice) serialises a
// block identically, and none reaches for the retired serialisedForm.
export function sieveBlockAttrs(node) {
  var attrs = {}
  for (var k in node.attrs) {
    if (Object.prototype.hasOwnProperty.call(node.attrs, k)) attrs[k] = node.attrs[k]
  }
  return attrs
}

// sieveFrameworkEntry is the universal "sieve/<kind>" view every block exposes:
// its attrs as a JSON map. The backend (block.SieveAttrs) keys off the kind and
// reads the attrs — rebuilding a block or reading fields, its choice.
function sieveFrameworkEntry(node) {
  return { mimeType: 'sieve/' + node.attrs.kind, content: JSON.stringify(sieveBlockAttrs(node)) }
}

// sieveBlockEntries is the ContentEntry array describing a sieve block: the
// renderer's own custom views (asContentEntry, e.g. a diagram's raw source) PLUS
// the framework's sieve/<kind> view. Both the context-menu extraction push and the
// clipboard copy path use this, so the backend always receives the same two views.
export function sieveBlockEntries(node, renderer) {
  var entries = []
  if (renderer && typeof renderer.asContentEntry === 'function') {
    var custom = renderer.asContentEntry(node)
    if (custom && custom.length) entries = entries.concat(custom)
  }
  entries.push(sieveFrameworkEntry(node))
  return entries
}

// resolveEntriesForKind looks up the behaviour for ANY block via the uniform
// block-kind registry — prose (native) resolves identically to structured kinds,
// no special-case fork.
export function resolveEntriesForKind(kind, sourceNode, entries) {
  var h = getBlockBehaviour && getBlockBehaviour(kind)
  if (h && typeof h.resolveEntries === 'function') {
    return h.resolveEntries(sourceNode, entries)
  }
  return entries
}

// ── Base attributes shared by every sieve block kind ─────────────────────────

var BASE_ATTRS = {
  kind:             { default: '',        parseHTML: function (el) { return el.getAttribute('data-kind')        || '' } },
  id:               { default: '',        parseHTML: function (el) { return el.getAttribute('data-id')          || '' } },
  status:           { default: 'PENDING', parseHTML: function (el) { return el.getAttribute('data-status')      || 'PENDING' } },
  createdAt:        { default: null,      parseHTML: function (el) { return el.getAttribute('data-created-at')  || null } },
  supportsEmbedding: { default: false, parseHTML: function (el) { return el.getAttribute('data-supports-embedding') === 'true' } },
  smartPaste: { default: false, parseHTML: function (el) { return el.getAttribute('data-smart-paste') === 'true' } },
}

// draggable:false — reordering is done via the custom gutter handle (block-chrome.js),
// not ProseMirror's native node drag.  Native node-drag on a draggable block stole
// textarea/text-selection gestures (a drag inside a code textarea moved the whole block).
var DEFAULT_NODE_CONFIG = { atom: true, selectable: true, draggable: false }

// ── NodeViewRegistry ─────────────────────────────────────────────────────────
// The typed registry that OWNS kind→adapter registration and lookup, plus the
// node factory that mints each kind's TipTap node. Replaces the former
// `export let` + registration-IIFE rebinding: registry state is #private, the
// registration entry point is a real method, and thin named-export delegators
// below keep every existing import site unchanged. When the TipTap runtime is
// absent (unit tests importing the pure helpers), #runtime is null and register()
// is an inert no-op — the exact "nothing registers without a runtime" property
// the IIFE's early return used to provide.
class NodeViewRegistry {
  /** @type {Record<string, any>} kind → minted TipTap node */
  #nodes = {}
  /** @type {Record<string, SieveBlockAdapter>} kind → adapter */
  #adapters = {}
  /** @type {{Node: any, mergeAttributes: any}|null} */
  #runtime

  constructor() {
    this.#runtime = (typeof window !== 'undefined' && T.Node)
      ? { Node: T.Node, mergeAttributes: T.mergeAttributes }
      : null
  }

  /**
   * Register a kind's adapter: mint its TipTap node, remember the adapter, and
   * record it in the shared block-kind registry (native:false — a sieve-<kind>
   * NodeView renders its payload; prose registers native:true in prose-block.js).
   * No-op without a runtime (unit-test import of the pure helpers).
   * @param {string} kind @param {SieveBlockAdapter} adapter
   */
  register(kind, adapter) {
    if (!this.#runtime) return
    this.#nodes[kind] = this.#createSieveNode(kind, adapter)
    this.#adapters[kind] = adapter
    if (registerBlockKind) {
      registerBlockKind({ kind: kind, native: false, renderer: adapter })
    }
  }

  /** @param {string} kind @returns {SieveBlockAdapter|undefined} */
  adapterFor(kind) { return this.#adapters[kind] }

  /**
   * The minted nodes, sieve-prose FIRST. PM's createAndFill auto-fill grabs the
   * FIRST instantiable node type in the required group (schema-declaration
   * order); listing prose first makes every auto-fill (empty doc, trailing/gap
   * fill) a prose block, not a stray ai-block atom.
   * @returns {any[]}
   */
  nodes() {
    var reg = this.#nodes
    var keys = Object.keys(reg).sort(function (a, b) {
      return a === 'prose' ? -1 : b === 'prose' ? 1 : 0
    })
    return keys.map(function (k) { return reg[k] })
  }

  // Canonical friendly name for a sieve block node — the ONE source the live
  // label, the context menu, and the commit path share. Reuses each adapter's
  // optional buildAiCtx(node).contextLabel (e.g. a code block surfacing its
  // language), falling back to a title-cased kind.
  /** @param {any} node @returns {string} */
  blockLabel(node) {
    var kind = node && node.attrs ? node.attrs.kind : ''
    var r = this.#adapters[kind]
    var base = (r && typeof r.buildAiCtx === 'function') ? r.buildAiCtx(node) : null
    var fallback = kind ? (kind.charAt(0).toUpperCase() + kind.slice(1).replace(/-/g, ' ')) : 'Block'
    return (base && base.contextLabel) || fallback
  }

  // buildBlockHTML assembles a structured block's data-* div from its PROPERTIES
  // map (data) — the single builder shared by the markdownit fence rule
  // (load-from-markdown) and block-render.js (load-from-attrs), so both emit
  // byte-identical HTML that each adapter's parseHTML consumes. The block model
  // is properties-in: block-render passes Go-sent attrs straight in, no fence parse.
  /** @param {string} kind @param {object} data @returns {string} */
  buildBlockHTML(kind, data) {
    var renderer = this.#adapters[kind]
    if (!renderer || !data || !data.id) return ''
    var cfg = Object.assign({}, DEFAULT_NODE_CONFIG, renderer.nodeConfig || {})
    var dataType = 'sieve-' + kind

    var htmlAttrs = [
      'data-type="'     + dataType + '"',
      'data-kind="'     + esc(kind) + '"',
      'data-id="'       + esc(data.id) + '"',
      'data-status="'   + esc(data.status || 'PENDING') + '"',
    ]
    if (renderer.parseAttrs) {
      var extra = renderer.parseAttrs(data)
      Object.keys(extra).forEach(function (k) {
        var kebab = k.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
        htmlAttrs.push('data-' + kebab + '="' + esc(String(extra[k] != null ? extra[k] : '')) + '"')
      })
    }
    if (data.createdAt) {
      htmlAttrs.push('data-created-at="' + esc(data.createdAt) + '"')
    }
    if (data.supportsEmbedding) {
      htmlAttrs.push('data-supports-embedding="true"')
    }
    if (data.smartPaste) {
      htmlAttrs.push('data-smart-paste="true"')
    }

    var innerHTML = ''
    if (!cfg.atom && renderer.getInitialContentHTML) {
      innerHTML = renderer.getInitialContentHTML(data)
    }

    return '<div ' + htmlAttrs.join(' ') + '>' + innerHTML + '</div>\n'
  }

  // The backend returns [{kind, actions}]. The frontend is a dumb renderer: it
  // shows each offered (kind, action) and plays back {operation}.
  //
  // sourceRange ({from,to}, optional) says the source is a RANGE INSIDE a block
  // rather than the block itself — a prose link, which has no block id of its
  // own (#67). It is carried, untouched, to editor.extract, which owns the
  // playback difference; nothing here branches on it.
  detectAndAppendExtractions({ sourceNode, sourceKind, entries, blockId, sourcePos, sourceRange, extractSourceLabel, editor }) {
    // Capability discovery is a facade QUERY: the lens asks its container which
    // kinds this content could become, and is answered with offers — never with
    // document content, and never over a transport it can see. Reached via the
    // editor host's provider (the same host whose .extract plays the chosen offer
    // back). No host/provider → nothing to discover (the menu items would be dead
    // anyway, since dispatch needs the editor).
    var self = this
    var provider = editor && editor.provider
    if (!provider || typeof provider.detectExtractions !== 'function') return
    provider.detectExtractions(sourceKind, entries).then(function (offers) {
      if (!offers || offers.length === 0) return
      if (!window.SieveContextMenu || !window.SieveContextMenu.appendItems) return

      var IC = window.SieveIcons || {}
      var headerLabel = 'FROM ' + (extractSourceLabel || sourceKind).toUpperCase().replace('-', ' ')
      var extraItems = [{ type: 'divider' }, { type: 'header', label: headerLabel }]

      var FRIENDLY = { prose: 'Text' }
      offers.forEach(function (offer) {
        var icon = IC[offer.kind] || IC.code
        var r = self.adapterFor(offer.kind)
        var prettyKind = FRIENDLY[offer.kind]
          || (r && typeof r.getFriendlyName === 'function'
            ? r.getFriendlyName()
            : offer.kind.split('-').map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1) }).join(' '))

        // Menu offers the source-mutating ops (extract/transform/undo-smart-paste); paste is never shown here.
        ;(offer.actions || []).forEach(function (action) {
          if (action !== 'extract' && action !== 'transform' && action !== 'undo-smart-paste') return

          var dispatch = function (context) {
            if (!editor) return
            editor.extract({
              blockId: blockId || (sourceNode && sourceNode.attrs ? sourceNode.attrs.id : null),
              targetKind: offer.kind,
              operation: action,
              sourceNode: sourceNode,
              sourcePos: sourcePos,
              sourceRange: sourceRange,
              entries: entries,
              context: context || {}
            })
          }

          if (r && typeof r.getExtractionMenuItems === 'function') {
            var items = r.getExtractionMenuItems(sourceNode, entries, dispatch, { operation: action })
            if (items && items.length) { items.forEach(function (it) { extraItems.push(it) }); return }
          }
          // Prose's TRANSFORM is the universal "flatten this block into the document"
          // affordance — it is NOT "convert to a block kind" (an image embeds as a plain
          // image, code as a fence, etc.), so "Convert to Text" misnames it. Label it
          // "Embed in Document" (the wording the retired bespoke item used).
          var isEmbed = offer.kind === 'prose' && action === 'transform'
          extraItems.push({
            icon: isEmbed ? (IC.promote || icon) : icon,
            label: (labelForAction || function (a, k) { return a + ' ' + k })(action, prettyKind, offer, sourceKind),
            action: function () { dispatch({}) }
          })
        })
      })
      window.SieveContextMenu.appendItems(extraItems)
      // Discovery is an OFFER: a document with no channel answers none, so the
      // only way here is a wire timeout or a broken menu build. Neither should
      // take the menu down — the base items are already open — but neither is
      // "nothing to extract" either, so it is said out loud rather than eaten.
    }).catch(function (err) { console.warn('[sieve-block] extraction offers unavailable', err) })
  }

  // extractContentEntryFromEditor inspects whatever DOM element was clicked
  // (event.target) and, if it sits on something extractable, returns the
  // ContentEntry array detection needs — the INPUT STAGE of the registry's
  // context-menu extraction pipeline (detectAndAppendExtractions). Static: it
  // needs no registry state, only the event + editor. Shared by two callers: the
  // Sieve-block NodeView (real DOM event) and the editor context menu (a
  // synthetic { target: elementFromPoint(x,y) } — see context-menu.js). It reads
  // ONLY event.target; nothing else off the event.
  static extractContentEntryFromEditor(event, editor) {
    var entries = null;
    var extractSourceLabel = "";
    var view = editor.view;

    //an image would be interesting to extract, and we can get a data-uri for it if needed.
    var closestImg = event.target.tagName === 'IMG' ? event.target : (event.target.closest ? event.target.closest('img') : null);
    if (closestImg && closestImg.src && view.dom.contains(closestImg)) {
      // A native <img> is a NATIVE source → use a NATIVE mime so recognition offers
      // TRANSFORM (Convert), not EXTRACT. (The old 'sieve/image' mime made it look like
      // a Sieve-block source.) A data: URI needs an image/* mime; a served asset URL is
      // matched by smart-image's isImageURL on the content, so any non-sieve mime works.
      var imgSrc = closestImg.src
      var imgMime = imgSrc.indexOf('data:') === 0 ? (imgSrc.slice(5).split(/[;,]/)[0] || 'image/png') : 'text/uri-list'
      entries = [{ mimeType: imgMime, content: imgSrc }];
      extractSourceLabel = 'image';
    }

    // Anchor click
    var closestA = event.target.tagName === 'A' ? event.target : (event.target.closest ? event.target.closest('a') : null);
    if (!entries && closestA && closestA.href && view.dom.contains(closestA)) {
      entries = [{ mimeType: 'text/uri-list', content: closestA.href }];
      extractSourceLabel = 'link';
    }

    if (!entries) {
      var closestPre = event.target.closest && event.target.closest('pre');
      if (closestPre && view.dom.contains(closestPre)) {
        // Resolve the clicked <pre> back to its ProseMirror codeBlock node so the
        // markdown serialiser can fence it correctly (nested ``` runs and all). A
        // Sieve block's rendered <pre> is NodeView DOM, not a real codeBlock node — it
        // resolves to no codeBlock here and is left to asContentEntry / the sieve/<kind>
        // entry instead, which is the correct path for those.
        var codeNode = null;
        try {
          var $pos = view.state.doc.resolve(view.posAtDOM(closestPre, 0));
          for (var d = $pos.depth; d >= 0; d--) {
            if ($pos.node(d).type.name === 'codeBlock') { codeNode = $pos.node(d); break; }
          }
        } catch (err) { /* pre isn't a mappable PM position — fall through */ }

        if (codeNode) {
          var fenced = serializeNode(editor, codeNode);
          if (fenced) {
            entries = [{ mimeType: 'text/plain', content: fenced }];
            extractSourceLabel = codeNode.attrs.language === 'mermaid' ? 'diagram' : 'code';
          }
        }
      }
    }
    return { entries, extractSourceLabel };
  }

  // ── Node factory ─────────────────────────────────────────────────────────────
  // Mints the TipTap node for a kind from its adapter (`renderer`). Called only
  // from register(), so the runtime is guaranteed present. `self` closes the
  // registry over the deep TipTap callbacks (where `this` rebinds to the node).
  /** @param {string} kind @param {SieveBlockAdapter} renderer */
  #createSieveNode(kind, renderer) {
    var self = this
    var Node = this.#runtime.Node
    var mergeAttributes = this.#runtime.mergeAttributes

    var cfg      = Object.assign({}, DEFAULT_NODE_CONFIG, renderer.nodeConfig || {})
    var nodeName = 'sieve-' + kind   // e.g. 'sieve-code', 'sieve-diagram'
    var dataType = 'sieve-' + kind   // value of the data-type HTML attribute

    return Node.create({
      name:       nodeName,
      // Step 5: sieve blocks form the "sieveBlock" group — the ONLY thing the doc
      // top level allows besides native prose. That keeps the top level all-blocks
      // (no bare paragraphs) and, because prose content is the "block" group,
      // excludes sieve blocks from inside prose (kind-homogeneity). EVERY kind is
      // a document-list member: there is no inline mode (removed with smart-link,
      // docs/design/archive/specs/2026-07-27-inline-block-removal-links-decision.md).
      group:      'sieveBlock',
      atom:       cfg.atom,
      selectable: cfg.selectable,
      draggable:  cfg.draggable,
      content:    cfg.content,
      marks:      cfg.marks,
      code:       cfg.code,
      defining:   cfg.defining,

      addProseMirrorPlugins() {
        return renderer.buildPlugins ? renderer.buildPlugins(this.type) : []
      },

      addAttributes() {
        return Object.assign({}, BASE_ATTRS, renderer.attrs || {})
      },

      parseHTML() {
        return [{ tag: 'div[data-type="' + dataType + '"]' }]
      },

      renderHTML({ HTMLAttributes }) {
        return ['div', mergeAttributes({ 'data-type': dataType }, HTMLAttributes)]
      },

      renderText({ node }) {
        // Plain-text view of the block for native copy / textBetween: the renderer's
        // own text/plain view (code → source, diagram → mermaid) if it tailors one,
        // else the node's text. Not markdown — Go owns that.
        if (renderer && typeof renderer.asContentEntry === 'function') {
          var ents = renderer.asContentEntry(node)
          if (ents) {
            for (var i = 0; i < ents.length; i++) {
              if (ents[i].mimeType === 'text/plain' && ents[i].content) return ents[i].content
            }
          }
        }
        return node.textContent || ''
      },

      addNodeView() {
        return function ({ node, editor: editorPane, getPos }) {
          // ctx — the per-block handle, shared by the header seam AND makeNodeView
          // (passed as the 4th arg; other renderers ignore it). Provider instances
          // are stateless/shared, so per-block state lives here. Durable changes →
          // ctx.updateAttributes (routes through the ContainerTransport, the wire owner —
          // no global CustomEvent); transient view state → ctx.state. attrs
          // is a LIVE read. refreshHeader re-renders the toolbar — for a renderer that
          // must rebuild it after async data lands (e.g. log's column toggles once the
          // parsed JSON loads). getEditor reaches the parent Editor's PUBLIC API through
          // the pane the surface stamped (editorPane.sieveHost) — the ONLY way a
          // NodeView touches the Editor; it never speaks to the backend directly.
          var renderHeaderBar   // assigned by the header seam below
          var blockCtx = {
            id: node.attrs.id,
            kind: kind,
            editorPane: editorPane,
            getPos: getPos,
            state: {},
            get attrs() {
              var p = (typeof getPos === 'function') ? getPos() : -1
              if (p != null && p >= 0 && p < editorPane.state.doc.content.size) {
                var cur = editorPane.state.doc.nodeAt(p)
                if (cur && cur.attrs) return cur.attrs
              }
              return node.attrs
            },
            getAttribute: function (name) { return blockCtx.attrs[name] },
            getEditor: function () { return editorPane.sieveHost || null },
            // The mounted container's provider (issue #96 — the Lens↔Host wall),
            // stamped on the pane by the surface as sieveHost is. Renderers
            // receive it at construction and speak facade verbs through it; no
            // transport is reachable from here.
            get provider() { return editorPane.blockProvider || null },
            // What the editor knows about whether the coordinates a block
            // renders still resolve (#82). Reached through the HOST rather than
            // a pane stamp, and read lazily like getEditor, because the surface
            // stamps sieveHost only after the pane is built — a NodeView made
            // during that build would capture nothing.
            get addressStatus() {
              var host = editorPane.sieveHost
              return (host && host.addressStatus) || null
            },
            updateAttributes: function (patch) {
              var p = blockCtx.provider
              if (p) p.requestSetBlock(node.attrs.id, patch)
            },
            retry: function () {
              // Go's retry handler writes PENDING and echoes immediately — the
              // echo is the paint (the old editor-side optimistic PM reset died
              // with the editor verb, deliberately).
              var p = blockCtx.provider
              if (p) p.requestRetry(node.attrs.id)
            },
            refreshHeader: function () { if (renderHeaderBar) renderHeaderBar() },
          }
          var view = renderer.makeNodeView(node, editorPane, getPos, blockCtx)
          if (view.dom) {
            // Inject the chrome host slot as the FIRST child.
            // BlockChrome will find it via .block-chrome-host and populate it
            // with the line number, drag handle, and rail.  Must be
            // contenteditable="false" so PM never tries to edit it.
            var chromeHost = document.createElement('div')
            chromeHost.className = 'block-chrome-host'
            chromeHost.setAttribute('contenteditable', 'false')
            view.dom.insertBefore(chromeHost, view.dom.firstChild)

            // data-kind: migrated renderers stamp their own identity data-* from
            // the block (contract: adapters never write renderer DOM); this
            // fallback covers any kind whose DOM the framework still assembles
            // via the LEGACY provider seam below.
            if (!view.dom.hasAttribute('data-kind')) view.dom.setAttribute('data-kind', kind)

            // Explicitly non-editable: prevents the block root from inheriting
            // contentEditable="true" from the ProseMirror root, which would let
            // the browser treat it as an editable area and break PM atom snapping.
            // Only apply this to blocks without a contentDOM (i.e., pure atoms).
            if (!view.contentDOM) {
              view.dom.contentEditable = 'false'
            }

            view.dom.addEventListener('contextmenu', function (e) {
              e.preventDefault()
              e.stopPropagation()
              var currentNode = (typeof getPos === 'function') ? editorPane.state.doc.nodeAt(getPos()) : node
              var n = currentNode || node
              var IC = window.SieveIcons || {}

              // The provider is passed so a menu item can COMMIT a change (e.g.
              // toggling a persisted rendering attribute) through the wall,
              // instead of reaching for a window.* global the way view-layer code
              // without ctx has had to (X-B debt).
              // getEditor is passed for the same reason: items that need the
              // document uuid (smart-image's Copy Image, to resolve an asset URL)
              // were already CALLING ctx.getEditor() and throwing "ctx.getEditor
              // is not a function" on their first line, because this ctx is
              // assembled here and never carried it.
              var items = renderer.buildContextMenuItems
                ? renderer.buildContextMenuItems({
                    node: n, editorPane: editorPane, getPos: getPos,
                    provider: blockCtx.provider,
                    getEditor: blockCtx.getEditor,
                  })
                : []

              // Expand — universal for kinds declaring the `expandable` policy,
              // shown only when there is something to expand right now.
              if (renderer.interactionPolicy && renderer.interactionPolicy.expandable &&
                  typeof renderer.getExpandContent === 'function') {
                var exSpec = renderer.getExpandContent(n, view.dom)
                if (exSpec) {
                  items = items.concat([
                    { type: 'divider' },
                    { icon: IC.expand || IC.search, label: 'Expand', action: function () {
                      expandBlock(renderer.getExpandContent(n, view.dom))
                    }},
                  ])
                }
              }

              // Ask AI + Explain — universal for every sieve block. The intent enters
              // the SELECTION stream: setNodeSelection(getPos()) makes THIS block the
              // resolved AI target (context.target), so the Ask/Explain handlers pull it
              // live — no precomputed side-channel (P3.D). Go's BuildContext +
              // expandAIBlockRefs assemble context server-side from the block id.
              items = items.concat([
                { type: 'divider' },
                { icon: IC.sparkle, label: 'Ask AI…', action: function () {
                  if (typeof getPos === 'function') editorPane.chain().focus().setNodeSelection(getPos()).run()
                  else editorPane.commands.focus()
                  document.dispatchEvent(new CustomEvent('sieve:ai-ask'))
                }},
                { icon: IC.info,    label: 'Explain',  action: function () {
                  if (typeof getPos === 'function') editorPane.chain().focus().setNodeSelection(getPos()).run()
                  else editorPane.commands.focus()
                  document.dispatchEvent(new CustomEvent('sieve:ai-explain'))
                }},
              ])

              // Delete — universal for every sieve block.
              items = items.concat([
                { type: 'divider' },
                { icon: IC.trash, label: 'Delete', action: function () {
                  if (typeof getPos === 'function') {
                    var pos = getPos()
                    editorPane.view.dispatch(editorPane.state.tr.delete(pos, pos + n.nodeSize))
                  }
                }},
              ])

              // Retry / Replay — automatic for all sieve blocks with a job lifecycle.
              // PENDING/DISPATCHED = stale if job no longer active and createdAt > 15s ago.
              var status = n.attrs.status || 'PENDING'
              var isStale = (status === 'PENDING' || status === 'DISPATCHED') && isJobStale(n.attrs.createdAt, n.attrs.id)
              var isError = status === 'ERROR' || status === 'TIMEOUT'
              if (isStale || isError || status === 'COMPLETE') {
                items = items.concat([
                  { type: 'divider' },
                  { icon: IC.refresh, label: (isStale || isError) ? 'Retry' : 'Replay',
                    action: function () { blockCtx.retry() }
                  },
                ])
              }

              document.dispatchEvent(new CustomEvent('sieve:contextmenu', {
                detail: { x: e.clientX, y: e.clientY, context: { type: 'sieveBlock', items: items } },
              }))

              //now lets see if we clicked on something interesting within the block that we can extract data from.
              var { entries, extractSourceLabel } = NodeViewRegistry.extractContentEntryFromEditor( e, editorPane);

              if(entries == undefined || !entries) {
                //nothign more intersting than the sieve block itself was clicked on,
                // but if the renderer supports it, we can extract a content entry from
                extractSourceLabel = renderer.getFriendlyName ? renderer.getFriendlyName(n) : n.attrs.kind || 'block';
                // The block's own views (asContentEntry) PLUS the framework's
                // universal sieve/<kind> JSON view — the same array the clipboard emits.
                entries = sieveBlockEntries(n, renderer);
              } else {
                // Specific sub-content was clicked. Stamp parentId ONLY when n is a true
                // CONTAINER — a block that holds child blocks (schema content 'block+':
                // ai-block, web-clip). Then the clicked thing is a genuine nested child, and
                // an in-place TRANSFORM would ReplaceBlock(n.id) and clobber the parent's
                // other content (e.g. an AI block's response) — defect #1, data loss; the
                // backend demotes TRANSFORM→EXTRACT so the copy lands after the surviving
                // parent. For a LEAF block (code/diagram 'text*', smart-image atom) the
                // clicked content IS the block itself — no parentId, so its own in-place
                // TRANSFORM ("Embed in Document") survives.
                if (n.attrs && n.attrs.id && containsChildBlocks(n)) {
                  entries.forEach(function (en) {
                    en.context = Object.assign({}, en.context, { parentId: n.attrs.id });
                  });
                }
                // Still hand the backend the framework view so it can key off the source kind/attrs.
                entries.push(sieveFrameworkEntry(n));
              }
              // A renderer may have no content entry (e.g. a prose block) → ensure
              // an array so we never crash on null.
              if (!entries) entries = [];


              if (entries) {
                self.detectAndAppendExtractions({
                  sourceNode: n,
                  sourceKind: n.attrs.kind,
                  entries: entries,
                  blockId: n.attrs.id,
                  extractSourceLabel: extractSourceLabel,
                  editor: blockCtx.getEditor()
                })
              }
            })

            // ── Click-to-own-selection ────────────────────────────────────────────
            // A click anywhere in the block makes it the caret/selection owner: a
            // NodeSelection at the block's position + editor focus, so keyboard
            // chords (Mod+Enter mode toggle, arrows, escape) route through the
            // policy extension uniformly — no per-renderer click/keydown handling.
            // BlockSelection.shouldClaim filters out controls/chrome, editable text
            // (PM's own caret), and a text drag-select (copy). mouseup (not
            // mousedown) so a drag that selects text is left intact.
            view.dom.addEventListener('mouseup', function (event) {
              if (typeof getPos !== 'function') return
              var domSel = (typeof window !== 'undefined' && window.getSelection) ? window.getSelection() : null
              if (!BlockSelection.shouldClaim(event.target, view.dom, view.contentDOM, domSel)) return
              var pos = getPos()
              if (pos == null || pos < 0 || pos >= editorPane.state.doc.content.size) return
              try {
                var sel = T.NodeSelection.create(editorPane.state.doc, pos)
                editorPane.view.dispatch(editorPane.state.tr.setSelection(sel))
                editorPane.view.focus()
              } catch (e) {}
            })
          }

          // ── Central stopEvent: shield interactive sub-elements from ProseMirror ──
          // Now that every sieve block is selectable+draggable (uniform schema),
          // we must stop clicks/typing inside a block's own form controls from
          // reaching ProseMirror — otherwise a click in a code textarea would
          // create/clear a NodeSelection and fight the editor caret.  Renderers
          // may also define their own stopEvent (e.g. key handling); we compose
          // with it rather than replacing it.
          var rendererStopEvent = view.stopEvent
          view.stopEvent = function (event) {
            var t = event.target
            // 1. Modifier keyboard shortcuts (Ctrl/Cmd + C/V/S/E…) must reach the
            //    main editor keymap — never stop them here.
            if ((event.type === 'keydown' || event.type === 'keyup' || event.type === 'keypress') &&
                (event.ctrlKey || event.metaKey)) {
              return false
            }
            // 2. Drag handle / gutter chrome → let ProseMirror see it (drag-reorder,
            //    whole-block selection are wired off these).
            if (t && t.closest && t.closest('.block-chrome-host, .block-chrome-handle, .drag-handle')) {
              return false
            }
            // 3. Interactive form controls inside the block → shield from PM so
            //    editing/clicking them doesn't disturb the document selection.
            if (t && t.closest &&
                t.closest('textarea, input, button, select, option, a[href], .CodeMirror, .cm-editor')) {
              return true
            }
            // 4. Otherwise defer to the renderer's own stopEvent (if any), else let PM handle it.
            if (typeof rendererStopEvent === 'function') return rendererStopEvent.call(view, event)
            return false
          }

          // ── Block anatomy: Header · Title · Body ─────────────────────────────
          // MIGRATED kinds (their adapter exposes a BlockRenderer instance as
          // view.renderer) BUILD THEMSELVES — the renderer owns the header, title
          // and body chrome via its own render()/update(); the framework does NOT
          // assemble anything around it. The one remaining framework job for them
          // is the PM BODY PROJECTION (contract chain of custody,
          // docs/design/archive/specs/2026-07-21-block-renderer-contract.md): a FRESH
          // SCRATCH renderer instance per pass authors the body markdown from Go
          // truth (the live instance's body region is externally managed — PM's),
          // and this seam parses it into contentDOM as live document nodes via a
          // tracked transaction (selection/targeting/round-trip is a PM concern).
          // A renderer without bodyMarkdown (diagram/code/log's raw-text bodies)
          // needs no projection. Kinds with NO split renderer yet fall to the
          // LEGACY provider seam below.

          // syncMdInto — parse markdown → a tracked PM replace of contentDOM's
          // content. Shared by the migrated body projection and the legacy
          // contentProvider seam; getPos can be stale by the time this deferred
          // sync runs, and doc.nodeAt THROWS for an out-of-range pos, so
          // bounds-check before touching the doc.
          var syncMdInto = function (md) {
            setTimeout(function () {
              if (!editorPane || !editorPane.view) return
              var html = renderSanctionedMarkdown(md || '') || '<p></p>'
              var tmp = document.createElement('div')
              tmp.innerHTML = html
              var PMDP = T.ProseMirrorDOMParser || T.DOMParser
              var slice = PMDP.fromSchema(editorPane.state.schema).parseSlice(tmp)
              var pos = typeof getPos === 'function' ? getPos() : -1
              var pmDoc = editorPane.state.doc
              if (pos == null || pos < 0 || pos >= pmDoc.content.size) return
              var cur = pmDoc.nodeAt(pos)
              if (!cur || !cur.type.name.startsWith('sieve-')) return
              var tr = editorPane.state.tr
              tr.replace(pos + 1, pos + 1 + cur.content.size, slice)
              tr.setMeta('sieve-md-sync', true)
              tr.setMeta('addToHistory', false)
              editorPane.view.dispatch(tr)
            }, 0)
          }

          if (view.renderer) {
            // ── MIGRATED: the renderer owns its chrome. Only project the body. ──
            if (view.contentDOM && typeof view.renderer.bodyMarkdown === 'function') {
              // SCRATCH-INSTANCE AUTHORING: one fresh instance per pass, built
              // from the node's block, guards nothing, fires no effects (no
              // service), and is discarded once its bodyMarkdown is extracted.
              var RendererClass = /** @type {any} */ (view.renderer).constructor
              var resolveBodyM = function (n) {
                return new RendererClass(sieveBlockFor(n, undefined, blockCtx.provider)).bodyMarkdown()
              }
              var lastMdM = resolveBodyM(node)
              if (lastMdM) syncMdInto(lastMdM)
              var origUpdateM = (typeof view.update === 'function') ? view.update.bind(view) : null
              view.update = function (updatedNode) {
                var ok = origUpdateM ? origUpdateM(updatedNode) : true
                if (!ok) return false
                var nextMd = resolveBodyM(updatedNode)
                if (nextMd !== lastMdM) { lastMdM = nextMd; syncMdInto(nextMd) }
                return true
              }
            }
            return view
          }

          // ── LEGACY provider seam (unmigrated kinds only) ─────────────────────
          // headerProvider (→ top toolbar), titleProvider (→ metadata lead),
          // contentProvider (→ live PM body). Inert for kinds declaring none.
          var resolve = function (p) {
            return (typeof p === 'function') ? p : function (attrs) { return attrs[p] }
          }

          // HEADER (toolbar) — a header provider instance → the top bar, placed
          // right after the gutter chrome host, re-rendered on attr change.
          var headerProvider = renderer.headerProvider
          var headerBarEl
          if (headerProvider && typeof headerProvider.render === 'function') {
            renderHeaderBar = function () {
              var fresh = headerProvider.render(blockCtx.attrs, blockCtx)
              if (renderer.interactionPolicy && renderer.interactionPolicy.expandable &&
                  typeof renderer.getExpandContent === 'function') {
                var pos = (typeof getPos === 'function') ? getPos() : -1
                var curNode = (pos >= 0 && pos < editorPane.state.doc.content.size)
                  ? editorPane.state.doc.nodeAt(pos) : node
                if (curNode && renderer.getExpandContent(curNode, view.dom)) {
                  var xb = document.createElement('button')
                  xb.className = 'sieve-block__expand-btn'
                  xb.setAttribute('aria-label', 'Expand')
                  xb.innerHTML = (window.SieveIcons && window.SieveIcons.expand) || '⤢'
                  xb.addEventListener('mousedown', function (e) {
                    e.preventDefault(); e.stopPropagation()
                    var p = (typeof getPos === 'function') ? getPos() : -1
                    var nd = (p >= 0 && p < editorPane.state.doc.content.size)
                      ? editorPane.state.doc.nodeAt(p) : curNode
                    expandBlock(renderer.getExpandContent(nd, view.dom))
                  })
                  fresh.appendChild(xb)
                }
              }
              var focusSnap = headerBarEl ? HeaderBar.adoptFocusedControl(headerBarEl, fresh) : null
              if (headerBarEl && headerBarEl.parentNode) {
                headerBarEl.parentNode.replaceChild(fresh, headerBarEl)
              } else {
                var anchor = view.dom.querySelector(':scope > .block-chrome-host')
                view.dom.insertBefore(fresh, anchor ? anchor.nextSibling : view.dom.firstChild)
              }
              headerBarEl = fresh
              HeaderBar.restoreFocusedControl(focusSnap)
            }
            renderHeaderBar()
          }

          // TITLE — static metadata region inserted before contentDOM.
          var titleProvider = renderer.titleProvider
          var resolveTitle, lastTitle, syncTitle
          if (view.contentDOM && titleProvider) {
            resolveTitle = resolve(titleProvider)
            var titleEl = document.createElement('div')
            titleEl.className = 'sieve-block__heading'
            titleEl.contentEditable = 'false'
            view.contentDOM.parentNode.insertBefore(titleEl, view.contentDOM)
            syncTitle = function (h) { syncBlockTitle(titleEl, view.renderer, h) }
          }

          // CONTENT — live PM nodes in contentDOM via the editor schema.
          var contentProvider = renderer.contentProvider || renderer.markdownProvider || renderer.markdownAttr
          var resolveBody, lastMd, syncMd
          if (view.contentDOM && contentProvider) {
            resolveBody = resolve(contentProvider)
            syncMd = syncMdInto
          }

          if (syncTitle) { lastTitle = resolveTitle(node.attrs); syncTitle(lastTitle) }
          if (syncMd) { lastMd = resolveBody(node.attrs); if (lastMd) syncMd(lastMd) }
          if (renderHeaderBar || syncTitle || syncMd) {
            var origUpdate = (typeof view.update === 'function') ? view.update.bind(view) : null
            view.update = function (updatedNode) {
              var ok = origUpdate ? origUpdate(updatedNode) : true
              if (!ok) return false
              if (renderHeaderBar) renderHeaderBar()
              if (syncTitle) {
                var nh = resolveTitle(updatedNode.attrs)
                if (nh !== lastTitle) { lastTitle = nh; syncTitle(nh) }
              }
              if (syncMd) {
                var nextMd = resolveBody(updatedNode.attrs)
                if (nextMd !== lastMd) { lastMd = nextMd; syncMd(nextMd) }
              }
              return true
            }
          }

          return view
        }
      },

      addStorage() {
        return {
          markdown: {
            // Go owns ALL markdown generation (disk + markdown mode, derived from
            // the authoritative tree). The frontend never serialises a structured
            // block to markdown, so this default is a no-op — it is reached only by
            // serializeNode for a structured node (e.g. clipboard text/plain), whose
            // real payload is the sieve/<kind> + custom views, not markdown.
            //
            // markdownSerialize override: a TRANSPARENT node (e.g. sieve-prose) owns
            // real prose children and must serialise them; it takes full control here.
            serialize: renderer.markdownSerialize ? renderer.markdownSerialize : function (state, node) {
              state.closeBlock(node)
            },

            parse: {
              // Wrap the markdownit fence rule. Only intercepts fences whose info
              // string matches this kind AND whose YAML body contains an id field.
              // All other fences fall through to the previous handler in the chain.
              //
              // A FENCE is the only shape a block loads from: the inline
              // `[!kind]{json}[!kind-end]` ruler was removed with smart-link (see
              // the header) — residual inline markers now read as literal prose.
              setup: function (markdownit) {
                var prevFence = markdownit.renderer.rules.fence
                markdownit.renderer.rules.fence = function (tokens, idx, options, env, self2) {
                  var token     = tokens[idx]
                  var tokenKind = (token.info || '').trim()

                  if (tokenKind !== kind) {
                    return prevFence
                      ? prevFence(tokens, idx, options, env, self2)
                      : self2.renderToken(tokens, idx, options)
                  }

                  var data
                  try { data = window.jsyaml.load(token.content) } catch (e) { data = null }
                  if (!data || !data.id) {
                    return prevFence
                      ? prevFence(tokens, idx, options, env, self2)
                      : self2.renderToken(tokens, idx, options)
                  }

                  // The fence reconstructs the properties map (data) by parsing
                  // its YAML; build the data-* div from it via the SAME helper
                  // block-render.js uses with Go-sent attrs — one builder, exact
                  // parity across the load-from-markdown and load-from-attrs paths.
                  return self.buildBlockHTML(kind, data)
                }
              },
            },
          },
        }
      },
    })
  }
}

// ── The singleton + thin named-export delegators ─────────────────────────────
// One registry per app. The delegators preserve every existing import site
// (registerSieveRenderer, buildSieveBlockHTML, getSieveNodes, getSieveBlockLabel,
// rendererFor, detectAndAppendExtractions) — the machinery moved to a class, the
// public surface did not.

const registry = new NodeViewRegistry()

/** @param {string} kind @param {SieveBlockAdapter} adapter */
export function registerSieveRenderer(kind, adapter) { registry.register(kind, adapter) }
/** @param {string} kind @param {object} data @returns {string} */
export function buildSieveBlockHTML(kind, data) { return registry.buildBlockHTML(kind, data) }
/** @returns {any[]} */
export function getSieveNodes() { return registry.nodes() }
/** @param {any} node @returns {string} */
export function getSieveBlockLabel(node) { return registry.blockLabel(node) }
/** @param {string} kind @returns {SieveBlockAdapter|undefined} */
export function rendererFor(kind) { return registry.adapterFor(kind) }
export function detectAndAppendExtractions(spec) { return registry.detectAndAppendExtractions(spec) }

export { NodeViewRegistry }

// ── Native Code Block (syntax highlighting via CodeBlockLowlight) ─────────────
// Uses CodeBlockLowlight's decoration system for highlighting. Visual appearance
// is handled by the existing .tiptap .code-block CSS + .hljs-* token colours.
// Import-time side-effect (guarded on the runtime), same as before — replaces the
// registration IIFE's equivalent block.
if (typeof window !== 'undefined' && T.CodeBlockLowlight) {
  window.SieveNativeCodeBlock = T.CodeBlockLowlight.extend({
    // The bundled tiptap-markdown serialiser for code blocks hardcodes a
    // 3-backtick fence. A code block whose own content contains a ``` run
    // (e.g. a ````markdown block wrapping ```http) therefore has its fence
    // collapsed to 3 ticks on save, which corrupts the document on reload.
    // Override the serialiser to size the fence longer than any backtick run
    // in the content (standard prosemirror-markdown behaviour). The parse
    // spec is replicated verbatim from the bundle so loading is unaffected.
    addStorage() {
      var parent = (this.parent && this.parent()) || {}
      var out = {}
      Object.keys(parent).forEach(function (k) { out[k] = parent[k] })
      out.markdown = {
        serialize: function (state, node) {
          var content = node.textContent || ''
          var longest = 0
          var runs = content.match(/`+/g)
          if (runs) runs.forEach(function (r) { if (r.length > longest) longest = r.length })
          var fence = new Array(Math.max(3, longest + 1) + 1).join('`')
          state.write(fence + (node.attrs.language || '') + '\n')
          state.text(content, false)
          state.ensureNewLine()
          state.write(fence)
          state.closeBlock(node)
        },
        parse: {
          setup: function (markdownit) {
            markdownit.set({ langPrefix: 'language-' })
          },
          updateDOM: function (el) {
            el.innerHTML = el.innerHTML.replace(/\n<\/code><\/pre>/g, '</code></pre>')
          },
        },
      }
      return out
    },
  }).configure({
    lowlight: getLowlight(),
    HTMLAttributes: { class: 'code-block' },
  })
}
