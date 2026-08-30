// Sieve block node factory + the node-view registry.
//
// A block KIND is contributed by registering an ADAPTER with the registry:
// `registerSieveRenderer('code', CodeNodeView)` mints a TipTap node named
// 'sieve-code' from the adapter's schema/attrs and wires its NodeView.
// getSieveNodes() then includes it automatically — no editor wiring per kind.
//
// @typedef {Object} SieveNodeView
//   The object an adapter's makeNodeView returns: a TipTap NodeView, plus the
//   optional `renderer` handle migrated kinds expose.
// @property {HTMLElement} dom                  block root element (required)
// @property {HTMLElement} [contentDOM]         editable content host (live PM body)
// @property {(node: any) => boolean} [update]  TipTap NodeView update hook
// @property {(event: Event) => boolean} [stopEvent] TipTap NodeView stopEvent hook
// @property {import('../../../renderers/block-renderer.js').BlockRenderer} [renderer]
//   the BlockRenderer a MIGRATED kind exposes — enables the framework's PM body
//   projection and TITLE fill (fillTitle). The body is taken from
//   `bodyElements()` when the renderer offers one and it answers a list — each
//   element is projected as a node of its own kind — and from `bodyMarkdown()`
//   otherwise.
//
// @typedef {Object} SieveBlockAdapter
//   The kind contract registered via registerSieveRenderer. Every member is
//   optional except makeNodeView; the factory feature-detects each.
// @property {(node: any, editor: any, getPos: (() => number), ctx: object) => SieveNodeView} makeNodeView
//   Builds the NodeView (required).
// @property {{atom?: boolean, selectable?: boolean, draggable?: boolean,
//   content?: string, marks?: string, code?: boolean, defining?: boolean}} [nodeConfig]
//   ProseMirror schema overrides, fixed at editor-init time. There is no
//   `group`/`inline` knob: EVERY registered kind is a top-level member of the
//   document list (group 'sieveBlock', a <div>).
// @property {Record<string, any>} [attrs]      kind-specific TipTap attr defs (merged with BASE_ATTRS).
// @property {(data: object) => Record<string, any>} [parseAttrs]
//   Parsed-YAML to the extra data-* attributes the kind needs on initial parse.
// @property {(type: any) => any[]} [buildPlugins]           per-kind ProseMirror plugins.
// @property {(node: any) => ({mimeType: string, content: string, context?: object}[]|null)} [asContentEntry]
//   the kind's own clipboard/text views (code → source, diagram → mermaid, …).
// @property {(arg: {node: any, editorPane: any, getPos: Function, provider: any, getEditor: Function}) => any[]} [buildContextMenuItems]
//   kind-specific context-menu items, prepended before the framework items.
// @property {(node: any) => ({contextLabel?: string, imageIds?: string[]})} [buildAiCtx]
//   customises the "Ask About [X]" label and included image ids.
// @property {Partial<import('../interaction-policy.js').InteractionPolicy>} [interactionPolicy]
//   the behaviours this kind opts into, by name.
// @property {(node: any, dom: HTMLElement) => any} [getExpandContent]  lightbox/expand spec, or null.
// @property {(node?: any) => string} [getFriendlyName]      display name for menus/labels.
// @property {(data: object) => string} [getInitialContentHTML]  initial inner HTML for a non-atom kind.
// @property {(sourceNode: any, entries: any[], dispatch: Function, opts: {operation: string}) => any[]} [getExtractionMenuItems]
//   kind-authored extraction menu items, else the framework builds a default. A
//   kind implements this to offer a CHOICE the framework cannot know about
//   (web-clip's Fetch/Summarise) — never to reword the action. The VERB must be
//   DERIVED from labelForAction (renderers/action-label.js), the one verb map.
// @property {(state: any, node: any) => void} [markdownSerialize]  markdown-storage serialize override.
// @property {{render: (attrs: object, ctx: object) => HTMLElement}} [headerProvider]  LEGACY header seam.
// @property {string|((attrs: object) => any)} [titleProvider]                        LEGACY title seam.
// @property {string|((attrs: object) => any)} [contentProvider]                      LEGACY content seam.
// @property {string|((attrs: object) => any)} [markdownProvider]                     LEGACY content seam (alias).
// @property {string} [markdownAttr]                                                  LEGACY content seam (alias).
//
// Adding a new block kind:
//   1. Create node-views/<kind>-node-view.js implementing the adapter above.
//   2. Add its <script type="module"> to index.html AFTER this module — the
//      node-view registers at its own top level, so the registry must exist first.

import { esc } from '../../../renderers/html-escape.js'
import { isJobStale } from '../../../renderers/job-status.js'
import { getLowlight, applyHighlighting } from '../../../renderers/highlighting.js'
import { renderSanctionedMarkdown } from '../../../renderers/sanctioned-markdown.js'
import { T } from './tiptap-vendor.js'
import { registerBlockKind, getBlockBehaviour, containsChildBlocks } from '../../../renderers/block-kinds.js'
import { BlockIdentity } from '../../../renderers/block-identity.js'
import { labelForAction } from '../../../renderers/action-label.js'
import { expandBlock } from '../../../ui/media-lightbox.js'
import { HeaderBar } from '../../../renderers/header-bar.js'
import { SieveBlock } from '../../../contract/sieve-block.js'
import { BlockSelection } from '../block-selection.js'

// The SEAM's block constructor for adapters. MODEL-FIRST: the node's id resolves
// the mounted container's follower model — what Go holds — and on a hit that
// block's attrs are the base, with the kind-owned live overlay applied on top. On
// a MISS (no provider, no id, or an id the container does not hold) it falls back
// to SieveBlock.from(node), the PM-RESURRECT path. Overlay precedence is uniform
// across both: overlay > model.
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

// The TITLE slot's fill decision (pure DOM, no PM). TITLE rendering is
// renderer-side in every lens, so this DELEGATES to the held renderer's fillTitle.
// Kinds with no split renderer fall back to the SANCTIONED markdown instance
// (html:false) rather than the editor's html:true one, so every path is
// injection-safe.
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

// Turns a single block node into markdown via the editor's OWN markdown
// serialiser, which sizes code fences longer than any backtick run in the
// content — so this is the only safe way to render a node to a fence, and never
// hand-build ```. The node is wrapped in a fresh doc so the serialiser has a valid
// root. Returns '' on failure.
export function serializeNode(editor, node) {
  try {
    var wrapper = editor.state.schema.topNodeType.create(null, node)
    return (editor.storage.markdown.serializer.serialize(wrapper) || '').trim()
  } catch (err) {
    console.error('[sieve] serializeNode failed', err)
    return ''
  }
}

// A plain own-property copy of a sieve node's attrs — the canonical serialisable
// representation of a block, so every wire path serialises one identically.
export function sieveBlockAttrs(node) {
  var attrs = {}
  for (var k in node.attrs) {
    if (Object.prototype.hasOwnProperty.call(node.attrs, k)) attrs[k] = node.attrs[k]
  }
  return attrs
}

// The universal "sieve/<kind>" view every block exposes: its attrs as a JSON map.
// The backend keys off the kind and reads the attrs.
function sieveFrameworkEntry(node) {
  return { mimeType: 'sieve/' + node.attrs.kind, content: JSON.stringify(sieveBlockAttrs(node)) }
}

// The ContentEntry array describing a sieve block: the renderer's own custom views
// PLUS the framework's sieve/<kind> view. Both the context-menu extraction push and
// the clipboard copy path use this, so the backend always receives the same two.
export function sieveBlockEntries(node, renderer) {
  var entries = []
  if (renderer && typeof renderer.asContentEntry === 'function') {
    var custom = renderer.asContentEntry(node)
    if (custom && custom.length) entries = entries.concat(custom)
  }
  entries.push(sieveFrameworkEntry(node))
  return entries
}

// Looks up the behaviour for ANY block via the uniform block-kind registry — prose
// resolves identically to structured kinds, with no special case.
export function resolveEntriesForKind(kind, sourceNode, entries) {
  var h = getBlockBehaviour && getBlockBehaviour(kind)
  if (h && typeof h.resolveEntries === 'function') {
    return h.resolveEntries(sourceNode, entries)
  }
  return entries
}

var BASE_ATTRS = {
  kind:             { default: '',        parseHTML: function (el) { return el.getAttribute('data-kind')        || '' } },
  id:               { default: '',        parseHTML: function (el) { return el.getAttribute('data-id')          || '' } },
  status:           { default: 'PENDING', parseHTML: function (el) { return el.getAttribute('data-status')      || 'PENDING' } },
  createdAt:        { default: null,      parseHTML: function (el) { return el.getAttribute('data-created-at')  || null } },
  supportsEmbedding: { default: false, parseHTML: function (el) { return el.getAttribute('data-supports-embedding') === 'true' } },
  smartPaste: { default: false, parseHTML: function (el) { return el.getAttribute('data-smart-paste') === 'true' } },
}

// draggable:false — reordering uses the custom gutter handle, not ProseMirror's
// native node drag, which stole textarea/text-selection gestures (a drag inside a
// code textarea moved the whole block).
var DEFAULT_NODE_CONFIG = { atom: true, selectable: true, draggable: false }

// The typed registry that OWNS kind-to-adapter registration and lookup, plus the
// node factory. Without a TipTap runtime, register() is an inert no-op.
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
   * NodeView renders its payload). No-op without a runtime.
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
   * The minted nodes, sieve-prose FIRST. PM's createAndFill grabs the FIRST
   * instantiable node type in the required group, so listing prose first makes
   * every auto-fill a prose block rather than a stray ai-block atom.
   * @returns {any[]}
   */
  nodes() {
    var reg = this.#nodes
    var keys = Object.keys(reg).sort(function (a, b) {
      return a === 'prose' ? -1 : b === 'prose' ? 1 : 0
    })
    return keys.map(function (k) { return reg[k] })
  }

  // Canonical friendly name for a sieve block node — the ONE source the live label,
  // the context menu and the commit path share.
  /** @param {any} node @returns {string} */
  blockLabel(node) {
    var kind = node && node.attrs ? node.attrs.kind : ''
    var r = this.#adapters[kind]
    var base = (r && typeof r.buildAiCtx === 'function') ? r.buildAiCtx(node) : null
    var fallback = kind ? (kind.charAt(0).toUpperCase() + kind.slice(1).replace(/-/g, ' ')) : 'Block'
    return (base && base.contextLabel) || fallback
  }

  // Assembles a structured block's data-* div from its PROPERTIES map — the single
  // builder shared by the markdownit fence rule and block-render.js, so both emit
  // byte-identical HTML that each adapter's parseHTML consumes.
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

  // The HTML a BODY PROJECTION of block ELEMENTS parses from: each element in the
  // costume its kind travels to ProseMirror in, so the projected node is the same
  // node the document load path builds and gets its kind's own NodeView. A kind
  // with no node type of its own — prose, whose editor form is native nodes —
  // reads as the markdown it carries, as does one this build does not know.
  //
  // Each element's HTML is TRIMMED and the pieces butted together: whitespace
  // between two block elements is a stray text node, and a parse wraps one in a
  // paragraph of its own — an empty line between every element of the answer.
  /** @param {ReadonlyArray<{kind: string, attrs: Record<string, any>}>} elements @returns {string} */
  elementsHTML(elements) {
    var self = this
    return (elements || []).map(function (el) {
      var attrs = (el && el.attrs) || {}
      var costume = (el && self.#adapters[el.kind]) ? self.buildBlockHTML(el.kind, attrs) : ''
      return (costume || renderSanctionedMarkdown(String(attrs.content || attrs.source || ''))).trim()
    }).join('')
  }

  // The backend returns [{kind, actions}]. The frontend is a dumb renderer: it shows
  // each offered (kind, action) and plays back {operation}.
  //
  // sourceRange says the source is a RANGE INSIDE a block rather than the block
  // itself — a prose link, which has no block id. It is carried untouched to
  // editor.extract, which owns the playback difference.
  detectAndAppendExtractions({ sourceNode, sourceKind, entries, blockId, sourcePos, sourceRange, extractSourceLabel, editor }) {
    // Capability discovery is a facade QUERY: the lens asks its container which
    // kinds this content could become, and is answered with offers — never with
    // document content, and never over a transport it can see.
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
          // Prose's TRANSFORM is the universal "flatten this block into the
          // document" affordance, NOT "convert to a block kind", so "Convert to
          // Text" misnames it.
          var isEmbed = offer.kind === 'prose' && action === 'transform'
          extraItems.push({
            icon: isEmbed ? (IC.promote || icon) : icon,
            label: (labelForAction || function (a, k) { return a + ' ' + k })(action, prettyKind, offer, sourceKind),
            action: function () { dispatch({}) }
          })
        })
      })
      window.SieveContextMenu.appendItems(extraItems)
      // Discovery is an OFFER: a document with no channel answers none, so the only
      // way here is a wire timeout or a broken menu build. Neither should take the
      // menu down, but neither is "nothing to extract" either.
    }).catch(function (err) { console.warn('[sieve-block] extraction offers unavailable', err) })
  }

  // Is the node at this position an ELEMENT — a block living inside another
  // block's payload, projected into that block's content — rather than a member
  // of the document tree? The answer is STRUCTURAL: a sieve node whose PM parent
  // is another sieve node is one, whatever kind either of them is.
  //
  // Read at NodeView construction, where ProseMirror answers getPos() with the
  // position it is building at and the view already holds the new state. A
  // position it cannot resolve is read as document-level, which is the form with
  // no suppression in it.
  /** @param {any} editorPane @param {any} getPos @returns {boolean} */
  static isElementPosition(editorPane, getPos) {
    if (typeof getPos !== 'function' || !editorPane || !editorPane.state) return false
    try {
      var pos = getPos()
      var doc = editorPane.state.doc
      if (pos == null || pos < 0 || pos > doc.content.size) return false
      var parent = doc.resolve(pos).parent
      return !!parent && String(parent.type.name).indexOf('sieve-') === 0
    } catch (err) {
      return false
    }
  }

  // Inspects whatever DOM element was clicked and, if it sits on something
  // extractable, returns the ContentEntry array detection needs. Static: it needs no
  // registry state. Shared by the NodeView (a real DOM event) and the editor context
  // menu (a synthetic target), and it reads ONLY event.target.
  static extractContentEntryFromEditor(event, editor) {
    var entries = null;
    var extractSourceLabel = "";
    var view = editor.view;

    var closestImg = event.target.tagName === 'IMG' ? event.target : (event.target.closest ? event.target.closest('img') : null);
    if (closestImg && closestImg.src && view.dom.contains(closestImg)) {
      // A native <img> is a NATIVE source, so use a NATIVE mime and recognition
      // offers TRANSFORM rather than EXTRACT. A data: URI needs an image/* mime;
      // a served asset URL is matched by smart-image's isImageURL on the content,
      // so any non-sieve mime works.
      var imgSrc = closestImg.src
      var imgMime = imgSrc.indexOf('data:') === 0 ? (imgSrc.slice(5).split(/[;,]/)[0] || 'image/png') : 'text/uri-list'
      entries = [{ mimeType: imgMime, content: imgSrc }];
      extractSourceLabel = 'image';
    }

    var closestA = event.target.tagName === 'A' ? event.target : (event.target.closest ? event.target.closest('a') : null);
    if (!entries && closestA && closestA.href && view.dom.contains(closestA)) {
      entries = [{ mimeType: 'text/uri-list', content: closestA.href }];
      extractSourceLabel = 'link';
    }

    if (!entries) {
      var closestPre = event.target.closest && event.target.closest('pre');
      if (closestPre && view.dom.contains(closestPre)) {
        // Resolve the clicked <pre> back to its ProseMirror codeBlock node so the
        // markdown serialiser can fence it correctly. A Sieve block's rendered
        // <pre> is NodeView DOM, not a real codeBlock node, so it resolves to none
        // here and is left to asContentEntry instead.
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

  // Mints the TipTap node for a kind from its adapter. Called only from register(),
  // so the runtime is guaranteed present. `self` closes the registry over the deep
  // TipTap callbacks, where `this` rebinds to the node.
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
      // Sieve blocks form the "sieveBlock" group — the ONLY thing the doc top level
      // allows besides native prose. That keeps the top level all-blocks and, because
      // prose content is the "block" group, excludes sieve blocks from inside prose.
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
        // Plain-text view for native copy / textBetween: the renderer's own
        // text/plain view if it tailors one, else the node's text. Not markdown —
        // Go owns that.
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
          // ctx — the per-block handle, shared by the header seam AND makeNodeView.
          // Provider instances are stateless and shared, so per-block state lives
          // here: durable changes through ctx.updateAttributes, transient view state
          // through ctx.state, `attrs` a LIVE read. getEditor reaches the parent
          // Editor's PUBLIC API through the pane the surface stamped — the ONLY way
          // a NodeView touches the Editor, and never the backend.
          var renderHeaderBar   // assigned by the header seam below

          // ELEMENT MODE — is this node an element of another block's payload,
          // projected into that block's content, rather than a member of the
          // document tree? Decided ONCE, HERE, structurally: a sieve node whose
          // PM parent is another sieve node is not addressable, whatever kind it
          // is. No kind detects this for itself, and none may.
          //
          // An element resolves to no block in the container, so it gets no
          // provider (its outbound verbs go inert), no identity in its DOM, no
          // chrome, and none of the framework's block verbs.
          var elementMode = NodeViewRegistry.isElementPosition(editorPane, getPos)
          var renderOptions = Object.freeze({ readOnly: elementMode })

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
            // The mounted container's provider, stamped on the pane by the
            // surface as sieveHost is. Renderers receive it at construction and
            // speak facade verbs through it; no transport is reachable from here.
            // An ELEMENT has none: it names no block the container holds, so a
            // verb aimed at its id would address a block that does not exist.
            get provider() { return elementMode ? null : (editorPane.blockProvider || null) },
            // The framework flags a kind honours at construction. A kind FORWARDS
            // these to its renderer exactly as it forwards the provider; it never
            // decides them.
            renderOptions: renderOptions,
            // Reached through the HOST and read lazily like getEditor, because the
            // surface stamps sieveHost only after the pane is built — a NodeView
            // made during that build would capture nothing.
            get addressStatus() {
              var host = editorPane.sieveHost
              return (host && host.addressStatus) || null
            },
            updateAttributes: function (patch) {
              var p = blockCtx.provider
              if (p) p.requestSetBlock(node.attrs.id, patch)
            },
            retry: function () {
              // Go's retry handler writes PENDING and echoes immediately, and
              // the echo is the paint.
              var p = blockCtx.provider
              if (p) p.requestRetry(node.attrs.id)
            },
            refreshHeader: function () { if (renderHeaderBar) renderHeaderBar() },
          }
          var view = renderer.makeNodeView(node, editorPane, getPos, blockCtx)
          /** @type {MutationObserver|null} */
          var anonymiser = null
          if (view.dom) {
            // The chrome host slot goes in FIRST; BlockChrome finds it via
            // .block-chrome-host. Must be contenteditable="false" so PM never
            // tries to edit it. An element gets none: BlockChrome walks the
            // document's top level, so a gutter number or drag handle here would
            // be chrome for a block nobody can address.
            if (!elementMode) {
              var chromeHost = document.createElement('div')
              chromeHost.className = 'block-chrome-host'
              chromeHost.setAttribute('contenteditable', 'false')
              view.dom.insertBefore(chromeHost, view.dom.firstChild)
            } else {
              // The identity a kind stamps on itself, taken back off — and kept
              // off, because a kind draws long after it is built (mermaid stamps
              // data-id on its own edges).
              BlockIdentity.strip(view.dom)
              anonymiser = BlockIdentity.keepAnonymous(view.dom)
            }

            // Migrated renderers stamp their own identity data-* from the block;
            // this fallback covers any kind whose DOM the framework assembles.
            if (!view.dom.hasAttribute('data-kind')) view.dom.setAttribute('data-kind', kind)

            // Explicitly non-editable: this stops the block root inheriting
            // contentEditable="true" from the ProseMirror root, which would break
            // PM atom snapping. Only for blocks with no contentDOM.
            if (!view.contentDOM) {
              view.dom.contentEditable = 'false'
            }

            // The framework's BLOCK VERBS — the context menu, and the click that
            // makes a block the selection owner — name a block by id, so an
            // ELEMENT offers neither: each gesture passes through to the block
            // HOSTING it, which is the interactable unit.
            view.dom.addEventListener('contextmenu', function (e) {
              if (elementMode) return
              e.preventDefault()
              e.stopPropagation()
              var currentNode = (typeof getPos === 'function') ? editorPane.state.doc.nodeAt(getPos()) : node
              var n = currentNode || node
              var IC = window.SieveIcons || {}

              // The provider is passed so a menu item can COMMIT a change through
              // the wall instead of reaching for a window.* global, and getEditor
              // for the items that need the document uuid.
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

              // Ask AI + Explain — universal for every sieve block. The intent
              // enters the SELECTION stream: setNodeSelection(getPos()) makes THIS
              // block the resolved AI target, so the handlers pull it live.
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

              var { entries, extractSourceLabel } = NodeViewRegistry.extractContentEntryFromEditor( e, editorPane);

              if(entries == undefined || !entries) {
                extractSourceLabel = renderer.getFriendlyName ? renderer.getFriendlyName(n) : n.attrs.kind || 'block';
                // The block's own views PLUS the framework's universal
                // sieve/<kind> JSON view — the same array the clipboard emits.
                entries = sieveBlockEntries(n, renderer);
              } else {
                // Specific sub-content was clicked. Stamp parentId ONLY when n is a
                // true CONTAINER — a block holding child blocks. Then the clicked
                // thing is a genuine nested child, and an in-place TRANSFORM would
                // clobber the parent's other content, so the backend demotes it to
                // EXTRACT. For a LEAF block the clicked content IS the block.
                if (n.attrs && n.attrs.id && containsChildBlocks(n)) {
                  entries.forEach(function (en) {
                    en.context = Object.assign({}, en.context, { parentId: n.attrs.id });
                  });
                }
                // Still hand the backend the framework view so it can key off the source kind/attrs.
                entries.push(sieveFrameworkEntry(n));
              }
              // A renderer may have no content entry, so ensure an array.
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

            // A click anywhere in the block makes it the caret/selection owner, so
            // keyboard chords route through the policy extension uniformly and no
            // renderer handles click/keydown itself. mouseup, not mousedown, so a
            // drag that selects text is left intact.
            view.dom.addEventListener('mouseup', function (event) {
              if (elementMode) return
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

          // The anonymiser outlives the build, so it is released with the view.
          if (anonymiser) {
            var watcher = anonymiser
            var origDestroy = (typeof view.destroy === 'function') ? view.destroy.bind(view) : null
            view.destroy = function () {
              watcher.disconnect()
              if (origDestroy) origDestroy()
            }
          }

          // Every sieve block is selectable and draggable, so clicks and typing
          // inside its own form controls must not reach ProseMirror — a click in a
          // code textarea would otherwise fight the editor caret. A renderer may
          // define its own stopEvent, which this composes with.
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
            // Otherwise defer to the renderer's own stopEvent, else let PM handle it.
            if (typeof rendererStopEvent === 'function') return rendererStopEvent.call(view, event)
            return false
          }

          // MIGRATED kinds BUILD THEMSELVES: the renderer owns the header, title and
          // body chrome, and the framework assembles nothing around it. The one
          // remaining framework job is the PM BODY PROJECTION — a FRESH SCRATCH
          // renderer per pass authors the body from Go truth, and this seam parses
          // it into contentDOM as live nodes via a tracked transaction. Kinds with
          // no split renderer fall to the LEGACY seam below.
          //
          // A body is offered in one of TWO forms and the richer one wins:
          // bodyElements() gives the body as BLOCKS, each projected as a node of
          // its own kind so it draws through its own NodeView; bodyMarkdown()
          // gives it as text. Either way the projection is ONE-WAY — the block's
          // attrs are the truth and nothing is read back — and invisible to save,
          // which walks the document's top level and signs a sieve block by its
          // attrs alone.

          // syncHtmlInto — parse HTML into a tracked PM replace of contentDOM.
          // getPos can be stale by the time this deferred sync runs, and doc.nodeAt
          // THROWS for an out-of-range pos, so bounds-check first.
          var syncHtmlInto = function (/** @type {string} */ html) {
            setTimeout(function () {
              if (!editorPane || !editorPane.view) return
              var tmp = document.createElement('div')
              tmp.innerHTML = html || '<p></p>'
              var PMDP = T.ProseMirrorDOMParser || T.DOMParser
              var slice = PMDP.fromSchema(editorPane.state.schema).parseSlice(tmp)
              var pos = typeof getPos === 'function' ? getPos() : -1
              var pmDoc = editorPane.state.doc
              if (pos == null || pos < 0 || pos >= pmDoc.content.size) return
              var cur = pmDoc.nodeAt(pos)
              if (!cur || !cur.type.name.startsWith('sieve-')) return
              var tr = editorPane.state.tr
              tr.replace(pos + 1, pos + 1 + cur.content.size, slice)
              // A body the replace leaves identical is never dispatched: the
              // change would recreate this view, whose construction projects
              // again, and nothing in that cycle ends it. Compared on the RESULT
              // rather than the slice, which parseSlice hands back open-ended.
              var next = tr.doc.nodeAt(pos)
              if (next && next.content.eq(cur.content)) return
              tr.setMeta('sieve-md-sync', true)
              tr.setMeta('addToHistory', false)
              editorPane.view.dispatch(tr)
            }, 0)
          }
          var syncMdInto = function (/** @type {string} */ md) { syncHtmlInto(renderSanctionedMarkdown(md || '')) }

          if (view.renderer) {
            if (view.contentDOM && typeof view.renderer.bodyMarkdown === 'function') {
              // SCRATCH-INSTANCE AUTHORING: one fresh instance per pass, guarding
              // nothing and firing no effects, discarded once the body is out.
              var RendererClass = /** @type {any} */ (view.renderer).constructor
              // The body as {key, html}. The KEY is what the churn guard compares:
              // update() arrives on edits anywhere in the document, and a body
              // reprojected on each of them would re-render every element it holds
              // — a mermaid diagram per keystroke. Only a body that actually
              // CHANGED is written back.
              var projectionOf = function (/** @type {any} */ n) {
                var scratch = new RendererClass(sieveBlockFor(n, undefined, blockCtx.provider))
                var elements = (typeof scratch.bodyElements === 'function') ? scratch.bodyElements() : null
                if (elements) return { key: 'blocks:' + JSON.stringify(elements), elements: elements }
                var md = scratch.bodyMarkdown()
                return { key: 'text:' + md, markdown: md }
              }
              var htmlOf = function (/** @type {any} */ p) {
                if (p.elements) return self.elementsHTML(p.elements)
                return p.markdown ? renderSanctionedMarkdown(p.markdown) : ''
              }
              var lastProjection = projectionOf(node)
              var firstHtml = htmlOf(lastProjection)
              if (firstHtml) syncHtmlInto(firstHtml)
              var origUpdateM = (typeof view.update === 'function') ? view.update.bind(view) : null
              view.update = function (/** @type {any} */ updatedNode) {
                var ok = origUpdateM ? origUpdateM(updatedNode) : true
                if (!ok) return false
                var next = projectionOf(updatedNode)
                if (next.key !== lastProjection.key) {
                  lastProjection = next
                  syncHtmlInto(htmlOf(next))
                }
                return true
              }
            }
            return view
          }

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
            // Go owns ALL markdown generation, so this default is a no-op — reached
            // only by serializeNode for a structured node, whose real payload is the
            // sieve/<kind> and custom views.
            //
            // markdownSerialize override: a TRANSPARENT node owns real prose children
            // and must serialise them, so it takes over here.
            serialize: renderer.markdownSerialize ? renderer.markdownSerialize : function (state, node) {
              state.closeBlock(node)
            },

            parse: {
              // Intercepts only fences whose info string matches this kind AND whose
              // YAML body carries an id; everything else falls through. A FENCE is
              // the only shape a block loads from.
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

                  // Built from the parsed YAML via the SAME helper block-render.js
                  // uses with Go-sent attrs — one builder, exact parity across both
                  // load paths.
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

// One registry per app. The delegators preserve every existing import site.

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

// Uses CodeBlockLowlight's decoration system; appearance is the existing
// .tiptap .code-block CSS plus .hljs-* token colours.
if (typeof window !== 'undefined' && T.CodeBlockLowlight) {
  window.SieveNativeCodeBlock = T.CodeBlockLowlight.extend({
    // The bundled tiptap-markdown serialiser for code blocks hardcodes a
    // 3-backtick fence, so a code block whose own content contains a ``` run has
    // its fence collapsed to 3 ticks on save, corrupting the document on reload.
    // Override the serialiser to size the fence longer than any backtick run in
    // the content. The parse spec is replicated verbatim from the bundle, so
    // loading is unaffected.
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
