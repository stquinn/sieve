// sieve-block-extension.js — Sieve block node factory.
//
// Renderer interface (each renderer file must supply these fields):
//
//   nodeConfig   { atom, selectable, draggable, group, inline }
//       ProseMirror schema overrides. Defaults: atom:true, selectable:true, draggable:true, group:'block', inline:false.
//       These are schema-level — fixed at editor init time, cannot change at runtime.
//       Use selectable:false + draggable:false for user-editable blocks (code, diagram).
//       Use group:'inline', inline:true for nodes that render inside text flow (e.g. smart-link).
//
//   attrs   { [key]: TipTap attr definition }
//       Kind-specific TipTap attributes. Merged with the five base attrs that every
//       sieve block shares: kind, id, rawYaml, status, createdAt.
//
//   parseAttrs(data) → { key: value }
//       Called by the fence parser. Receives the parsed YAML object; returns the
//       extra data-* HTML attributes the renderer needs on initial parse.
//
//   makeNodeView(node, editor) → TipTap NodeView
//       Returns the NodeView object (dom, update, stopEvent, etc.).
//
// Optional renderer fields (framework injects these behaviours automatically):
//
//   buildContextMenuItems({ node, editor, getPos }) → [ item, ... ]
//       Block-specific context menu items prepended before the framework items.
//       The framework always appends: Ask AI, Explain, Delete, Retry/Replay, Promote.
//
//   buildAiCtx(node) → { contextLabel, imageIds? }
//       Customise the "Ask About [X]" popup label and any image IDs to include.
//       Defaults to a capitalised version of the block kind if omitted.
//
// Registration:
//   window.TipTap.registerSieveRenderer('code', CodeRenderer)
//   → creates a TipTap node named 'sieve-code' with the renderer's config/attrs
//   → getSieveNodes() includes it automatically — no editor.js changes needed
//
// Adding a new block kind:
//   1. Create processors/<kind>-renderer.js following the interface above
//   2. Add <script type="module" src="/static/processors/<kind>-renderer.js"> to
//      index.html after block/sieve-block-extension.js
//   That's it.

import { esc, isJobStale, getLowlight, extractTextFromDOM, renderMarkdown, applyHighlighting } from '../base/fenced-block-base.js'

// ── Header focus preservation ────────────────────────────────────────────────
// A header re-render (renderHeaderBar) rebuilds the whole toolbar so button
// states track the live attrs. But a header may hold a control the user is
// actively in — log's `Filter…` input — and a naive wholesale swap would rob it
// of focus + caret and reset its value mid-type (which is why the header seam
// once SKIPPED the re-render entirely while focus was inside the bar, leaving
// button states stale — the log toolbar "doesn't redraw" bug). Instead we keep
// the LIVE focused control across the rebuild: move its actual DOM node into the
// fresh tree at the matching slot (value/caret intact) and re-focus it after the
// bar is mounted (reparenting blurs it). Uniform — no renderer knowledge; a
// header with nothing focused just swaps wholesale.
var HEADER_FOCUSABLE = 'input, textarea, select, button'

// adoptFocusedControl moves the live focused control from oldBar into freshBar at
// the matching slot (same index among focusable descendants, same tag). Returns a
// snapshot for restoreFocusedControl, or null if nothing in oldBar was focused.
// Call BEFORE freshBar is mounted; call restoreFocusedControl AFTER mounting (a
// detached element can't hold focus).
export function adoptFocusedControl(oldBar, freshBar) {
  var active = (typeof document !== 'undefined') ? document.activeElement : null
  if (!oldBar || !freshBar || !active || !oldBar.contains(active)) return null
  var oldList = Array.prototype.slice.call(oldBar.querySelectorAll(HEADER_FOCUSABLE))
  var idx = oldList.indexOf(active)
  if (idx < 0) return null
  var freshList = Array.prototype.slice.call(freshBar.querySelectorAll(HEADER_FOCUSABLE))
  var twin = freshList[idx]
  if (!twin || twin.tagName !== active.tagName || !twin.parentNode) return null
  var ss = (typeof active.selectionStart === 'number') ? active.selectionStart : null
  var se = (typeof active.selectionEnd === 'number') ? active.selectionEnd : null
  twin.parentNode.replaceChild(active, twin)   // fresh tree now holds the LIVE control
  return { el: active, selectionStart: ss, selectionEnd: se }
}

// restoreFocusedControl re-focuses the adopted control (the reparent blurred it)
// and restores its caret. No-op when adoptFocusedControl returned null.
export function restoreFocusedControl(snap) {
  if (!snap || !snap.el) return
  if (typeof snap.el.focus === 'function') snap.el.focus()
  if (snap.selectionStart !== null && typeof snap.el.setSelectionRange === 'function') {
    try { snap.el.setSelectionRange(snap.selectionStart, snap.selectionEnd) } catch (e) {}
  }
}

// ── Click-to-own-selection ───────────────────────────────────────────────────
// A click anywhere in a block makes it the caret/selection owner (a NodeSelection
// + editor focus), so keyboard chords (Mod+Enter mode toggle, etc.) route to it
// via the policy extension — uniform for every kind, no per-renderer handling.
// BLOCK_CLICK_SKIP lists what a click must NOT claim the block: interactive
// controls + the header/chrome own their own clicks.
var BLOCK_CLICK_SKIP = 'input, textarea, button, select, option, a[href], ' +
  '.sieve-block__header, .block-chrome-host, .block-chrome-handle, .drag-handle'

// shouldClaimBlockSelection — the click decision (pure, testable). A plain click
// claims the whole block UNLESS it lands on an interactive control/chrome, inside
// the block's editable text (contentDOM — PM places a text caret there, which IS
// caret ownership), or while a real text selection sits inside the block (a
// drag-select for copy, e.g. a log table — leave it alone).
export function shouldClaimBlockSelection(target, blockDom, contentDOM, domSelection) {
  if (!target || !blockDom || !blockDom.contains(target)) return false
  if (target.closest && target.closest(BLOCK_CLICK_SKIP)) return false
  if (contentDOM && contentDOM.contains(target)) return false
  if (domSelection && !domSelection.isCollapsed && domSelection.anchorNode &&
      blockDom.contains(domSelection.anchorNode)) return false
  return true
}

// domSelectionTextInside — the highlighted text of a native DOM selection IF it
// sits inside blockDom, else '' (pure, testable). A block's custom region (e.g.
// the log Explore table) holds text PM does not own, so a highlight there is
// invisible to PM's position-based selection — on copy PM sees a whole-block
// NodeSelection and the rich copy would grab the ENTIRE block. The copy handler
// uses this so text/plain + text/html follow the DOM highlight while sieve/slice
// + sieve/<kind> still carry the whole block (a block is only meaningful whole).
export function domSelectionTextInside(domSelection, blockDom) {
  if (!domSelection || domSelection.isCollapsed || !blockDom) return ''
  var text = domSelection.toString()
  if (!text || !text.trim()) return ''
  var a = domSelection.anchorNode
  var el = a ? (a.nodeType === 1 ? a : a.parentElement) : null
  return (el && blockDom.contains(el)) ? text : ''
}

// domSelectionBlockRange — the {from,to} PM range of the block a visible DOM
// highlight actually lives in, IF that block is NOT already covered by the PM
// selection `er` (else null). Pure, testable.
//
// A block's READ-ONLY region (the ai-block question title, the log Explore table
// — contentEditable=false DOM PM does not own) can hold a highlight that PM's
// position-based selection knows nothing about: PM's selection stays on whatever
// block last held the caret. Driving the copy off `er` alone would then serialize
// the WRONG (previously-selected) block. The copy handler calls this to re-target
// the range it visits onto the block the user actually highlighted. When `er`
// already covers the matched block, PM owns that text (the block's live PM
// content, e.g. an ai-block response) — return null and leave `er` alone.
//   blocks: ordered [{ from, to, dom }] top-level sieve-block descriptors.
export function domSelectionBlockRange(domSelection, er, blocks) {
  if (!domSelection || domSelection.isCollapsed) return null
  var text = domSelection.toString()
  if (!text || !text.trim()) return null
  for (var i = 0; i < (blocks || []).length; i++) {
    var blk = blocks[i]
    if (!domSelectionTextInside(domSelection, blk.dom)) continue
    var erCovers = !!(er && er.to > blk.from && er.from < blk.to)
    return erCovers ? null : { from: blk.from, to: blk.to }
  }
  return null
}

;(function () {
  'use strict'

  // Registration machinery needs the TipTap runtime. In unit tests the module is
  // imported for the exported helpers above with no runtime present — no-op then.
  if (typeof window === 'undefined' || !window.TipTap) return

  var T = window.TipTap
  var Node = T.Node
  var mergeAttributes = T.mergeAttributes

  // ── HEADER slot providers ────────────────────────────────────────────────────
  // The HEADER slot of the Sieve Block anatomy (Header · Title · Content) lives
  // here, with the seam that consumes it — one foundation, not a satellite file.
  // A block declares `headerProvider: <instance>`; the seam calls
  // provider.render(attrs, ctx) and places the result as the block's top bar.
  // Behaviour lives on the provider TYPE; instances are stateless and shared, so
  // per-block state travels in `ctx` (see the seam for the ctx contract):
  //   ctx = { id, kind, attrs (live), editor, getPos, state (transient bag),
  //           update(patch) → persist via sieve:block-update }
  // Durable state → ctx.update(patch). Transient view state → ctx.state.
  // Exposed on window.TipTap so renderers subclass without a separate import.

  function hdrEl(cls, tag) {
    var e = document.createElement(tag || 'div')
    if (cls) e.className = cls
    return e
  }
  function badgeEl(text, extraCls) {
    var b = hdrEl('sieve-block__badge' + (extraCls ? ' ' + extraCls : ''), 'span')
    b.textContent = (text == null) ? '' : String(text)
    return b
  }
  function appendAll(parent, nodes) {
    (nodes || []).forEach(function (n) { if (n) parent.appendChild(n) })
  }
  // A badge value is a literal string/number or a function(attrs) — NOT an attr
  // name (ambiguous with a literal like 'diagram'). For an attr: `a => a.language`.
  function resolveBadge(badge, attrs) {
    return (typeof badge === 'function') ? badge(attrs) : badge
  }

  // Base slot — override render() or subclass AdvancedHeaderProvider.
  class SieveBlockHeader {
    render(/* attrs, ctx */) { return hdrEl('sieve-block__header') }
  }

  // Built-in 1: badge only (the framework default is new BadgeOnlyHeader(kind)).
  class BadgeOnlyHeader extends SieveBlockHeader {
    constructor(badge) { super(); this._badge = badge }
    render(attrs /*, ctx */) {
      var bar = hdrEl('sieve-block__header')
      bar.contentEditable = 'false'
      var text = resolveBadge(this._badge, attrs)
      if (text != null && text !== '') bar.appendChild(badgeEl(text))
      return bar
    }
  }

  // Built-in 2: the toolbar. render() is the template:
  //   [badge][...left][...center][spacer][...right]. Subclass + override hooks.
  class AdvancedHeaderProvider extends SieveBlockHeader {
    badge(/* attrs */)       { return null }   // string | number | Element | null
    left(/* attrs, ctx */)   { return [] }
    center(/* attrs, ctx */) { return [] }
    right(/* attrs, ctx */)  { return [] }
    render(attrs, ctx) {
      var bar = hdrEl('sieve-block__header')
      bar.contentEditable = 'false'
      var b = this.badge(attrs)
      if (b != null && b !== '') bar.appendChild((b instanceof Element) ? b : badgeEl(b))
      appendAll(bar, this.left(attrs, ctx))
      appendAll(bar, this.center(attrs, ctx))
      var spacer = hdrEl(); spacer.style.flex = '1'; bar.appendChild(spacer)
      appendAll(bar, this.right(attrs, ctx))
      return bar
    }
  }

  // Shared control: the segmented toggle log (raw/explore) and diagram
  // (edit/render) both hand-built. onChange(value) is the durable action.
  //   options: [{ value, label, icon? }]
  function segmentedToggle(options, activeValue, onChange) {
    var wrap = hdrEl('sieve-block__toggle')
    ;(options || []).forEach(function (opt) {
      var btn = document.createElement('button')
      btn.className = 'sieve-block__toggle-btn' + (opt.value === activeValue ? ' sieve-block__toggle-btn--active' : '')
      btn.innerHTML = (opt.icon ? opt.icon + ' ' : '') + opt.label
      btn.onclick = function (e) { e.preventDefault(); e.stopPropagation(); onChange(opt.value) }
      wrap.appendChild(btn)
    })
    return wrap
  }

  // The ONE owner of the block-update protocol. ctx.updateAttribute and any
  // renderer route attr changes through here — nothing else names the event.
  function updateBlockAttrs(id, kind, patch) {
    document.dispatchEvent(new CustomEvent('sieve:block-update', { detail: { id: id, kind: kind, attrs: patch } }))
  }

  T.SieveBlockHeader = SieveBlockHeader
  T.BadgeOnlyHeader = BadgeOnlyHeader
  T.AdvancedHeaderProvider = AdvancedHeaderProvider
  T.segmentedToggle = segmentedToggle
  T.badgeEl = badgeEl
  T.updateBlockAttrs = updateBlockAttrs
  T.domSelectionTextInside = domSelectionTextInside
  T.domSelectionBlockRange = domSelectionBlockRange

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
  var DEFAULT_NODE_CONFIG = { atom: true, selectable: true, draggable: false, group: 'block', inline: false }

  // ── Node factory ─────────────────────────────────────────────────────────────

  function createSieveNode(kind, renderer) {
    var cfg      = Object.assign({}, DEFAULT_NODE_CONFIG, renderer.nodeConfig || {})
    var nodeName = 'sieve-' + kind   // e.g. 'sieve-code', 'sieve-diagram'
    var dataType = 'sieve-' + kind   // value of the data-type HTML attribute

    var tag = cfg.inline ? 'span' : 'div'

    return Node.create({
      name:       nodeName,
      // Step 5: block-mode sieve blocks form the "sieveBlock" group — the ONLY
      // thing the doc top level allows. That keeps the top level all-blocks
      // (no bare paragraphs) and, because prose content is the "block" group,
      // excludes sieve blocks from inside prose (kind-homogeneity). Inline sieve
      // nodes keep their own group.
      group:      cfg.inline ? cfg.group : 'sieveBlock',
      inline:     cfg.inline,
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
        return [{ tag: tag + '[data-type="' + dataType + '"]' }]
      },

      renderHTML({ HTMLAttributes }) {
        return [tag, mergeAttributes({ 'data-type': dataType }, HTMLAttributes)]
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
        return function ({ node, editor, getPos }) {
          // ctx — the per-block handle, shared by the header seam AND makeNodeView
          // (passed as the 4th arg; other renderers ignore it). Provider instances
          // are stateless/shared, so per-block state lives here. Durable changes →
          // ctx.updateAttribute (the one updateBlockAttrs dispatch); transient view
          // state → ctx.state. attrs is a LIVE read. refreshHeader re-renders the
          // toolbar — for a renderer that must rebuild it after async data lands
          // (e.g. log's column toggles once the parsed JSON loads).
          var renderHeaderBar   // assigned by the header seam below
          var blockCtx = {
            id: node.attrs.id,
            kind: kind,
            editor: editor,
            getPos: getPos,
            state: {},
            get attrs() {
              var p = (typeof getPos === 'function') ? getPos() : -1
              if (p != null && p >= 0 && p < editor.state.doc.content.size) {
                var cur = editor.state.doc.nodeAt(p)
                if (cur && cur.attrs) return cur.attrs
              }
              return node.attrs
            },
            getAttribute: function (name) { return blockCtx.attrs[name] },
            updateAttribute: function (patch) { updateBlockAttrs(node.attrs.id, kind, patch) },
            refreshHeader: function () { if (renderHeaderBar) renderHeaderBar() },
          }
          var view = renderer.makeNodeView(node, editor, getPos, blockCtx)
          if (view.dom) {
            // Inject the chrome host slot as the FIRST child.
            // BlockChrome will find it via .block-chrome-host and populate it
            // with the line number, drag handle, and rail.  Must be
            // contenteditable="false" so PM never tries to edit it.
            var chromeHost = document.createElement('div')
            chromeHost.className = 'block-chrome-host'
            chromeHost.setAttribute('contenteditable', 'false')
            view.dom.insertBefore(chromeHost, view.dom.firstChild)

            // Stamp data-kind on the block root (renderers already set data-id
            // there, but not the kind). One uniform spot for every sieve flavour —
            // lets the block-ID hover readout report `kind · id` rather than
            // defaulting to 'prose'.
            view.dom.setAttribute('data-kind', kind)

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
              var currentNode = (typeof getPos === 'function') ? editor.state.doc.nodeAt(getPos()) : node
              var n = currentNode || node
              var IC = window.SieveIcons || {}

              var items = renderer.buildContextMenuItems
                ? renderer.buildContextMenuItems({ node: n, editor: editor, getPos: getPos })
                : []

              // Ask AI + Explain — universal for every sieve block.
              // blockRef is the block's own ID; Go's BuildContext + expandAIBlockRefs handle context assembly.
              // Optionally declare buildAiCtx(node) → { contextLabel, imageIds? } to customise the popup label.
              var aiBase = renderer.buildAiCtx ? renderer.buildAiCtx(n) : {}
              var kindLabel = n.attrs.kind
                ? n.attrs.kind.charAt(0).toUpperCase() + n.attrs.kind.slice(1).replace(/-/g, ' ')
                : 'Block'
              var aiCtx = {
                content:      '',
                blockRef:     n.attrs.id || 'doc',
                history:      '',
                contextLabel: (aiBase && aiBase.contextLabel) || kindLabel,
                imageIds:     (aiBase && aiBase.imageIds) || [],
              }
              items = items.concat([
                { type: 'divider' },
                { icon: IC.sparkle, label: 'Ask AI…', action: function () {
                  if (typeof getPos === 'function') editor.chain().focus().setNodeSelection(getPos()).run()
                  else editor.commands.focus()
                  document.dispatchEvent(new CustomEvent('sieve:ai-ask', { detail: { precomputedCtx: aiCtx } }))
                }},
                { icon: IC.info,    label: 'Explain',  action: function () {
                  if (typeof getPos === 'function') editor.chain().focus().setNodeSelection(getPos()).run()
                  else editor.commands.focus()
                  document.dispatchEvent(new CustomEvent('sieve:ai-explain', { detail: { precomputedCtx: aiCtx } }))
                }},
              ])

              // Delete — universal for every sieve block.
              items = items.concat([
                { type: 'divider' },
                { icon: IC.trash, label: 'Delete', action: function () {
                  if (typeof getPos === 'function') {
                    var pos = getPos()
                    editor.view.dispatch(editor.state.tr.delete(pos, pos + n.nodeSize))
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
                    action: function () {
                      document.dispatchEvent(new CustomEvent('sieve:block-retry', { detail: { id: n.attrs.id } }))
                    }
                  },
                ])
              }

              document.dispatchEvent(new CustomEvent('sieve:contextmenu', {
                detail: { x: e.clientX, y: e.clientY, context: { type: 'sieveBlock', items: items } },
              }))

              //now lets see if we clicked on something interesting within the block that we can extract data from. 
              var { entries, extractSourceLabel } = extractContentEntryFromEditor( e, editor);

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
                if (n.attrs && n.attrs.id && T.containsChildBlocks(n)) {
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
                detectAndAppendExtractions({
                  sourceNode: n,
                  sourceKind: n.attrs.kind,
                  entries: entries,
                  blockId: n.attrs.id,
                  extractSourceLabel: extractSourceLabel
                })
              }
            })

            // ── Click-to-own-selection ────────────────────────────────────────────
            // A click anywhere in the block makes it the caret/selection owner: a
            // NodeSelection at the block's position + editor focus, so keyboard
            // chords (Mod+Enter mode toggle, arrows, escape) route through the
            // policy extension uniformly — no per-renderer click/keydown handling.
            // shouldClaimBlockSelection filters out controls/chrome, editable text
            // (PM's own caret), and a text drag-select (copy). mouseup (not
            // mousedown) so a drag that selects text is left intact.
            view.dom.addEventListener('mouseup', function (event) {
              if (typeof getPos !== 'function') return
              var domSel = (typeof window !== 'undefined' && window.getSelection) ? window.getSelection() : null
              if (!shouldClaimBlockSelection(event.target, view.dom, view.contentDOM, domSel)) return
              var pos = getPos()
              if (pos == null || pos < 0 || pos >= editor.state.doc.content.size) return
              try {
                var sel = T.NodeSelection.create(editor.state.doc, pos)
                editor.view.dispatch(editor.state.tr.setSelection(sel))
                editor.view.focus()
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

          // ── Framework-level Header · Title · Content slots ───────────────────────
          // A Sieve Block has slots the framework owns here. CHROME (window
          // decoration) is still built by the renderer's NodeView; these three are
          // declared:
          //   headerProvider  — a SieveBlockHeader instance → the top TOOLBAR bar
          //                     (badge + controls), via provider.render(attrs, ctx).
          //   titleProvider   — string-attr | fn → the semantic lead (title/question),
          //                     a static metadata region above content; its CSS border
          //                     is the divider; empty → hidden (no region, no divider).
          //   contentProvider — string-attr | fn → the data, live PM nodes in contentDOM
          //                     (markdownProvider/markdownAttr are legacy aliases).
          var resolve = function (p) {
            return (typeof p === 'function') ? p : function (attrs) { return attrs[p] }
          }

          // blockCtx + renderHeaderBar are declared at the top of the NodeView
          // wrapper (so makeNodeView receives ctx and refreshHeader can reach the
          // bar). The header seam just assigns the renderer here.

          // HEADER (toolbar) — a SieveBlockHeader instance → the top bar. Placed
          // right after the gutter chrome host. Re-rendered on attr change so e.g.
          // a mode toggle reflects the active state.
          var headerProvider = renderer.headerProvider
          var headerBarEl
          if (headerProvider && typeof headerProvider.render === 'function') {
            renderHeaderBar = function () {
              var fresh = headerProvider.render(blockCtx.attrs, blockCtx)
              // Keep a control the user is actively in (log's filter input) alive
              // across the rebuild: adopt its live node into the fresh tree, then
              // re-focus after mounting. See adoptFocusedControl above.
              var focusSnap = headerBarEl ? adoptFocusedControl(headerBarEl, fresh) : null
              if (headerBarEl && headerBarEl.parentNode) {
                headerBarEl.parentNode.replaceChild(fresh, headerBarEl)
              } else {
                var anchor = view.dom.querySelector(':scope > .block-chrome-host')
                view.dom.insertBefore(fresh, anchor ? anchor.nextSibling : view.dom.firstChild)
              }
              headerBarEl = fresh
              restoreFocusedControl(focusSnap)
            }
            renderHeaderBar()
          }

          // TITLE — static metadata region inserted before contentDOM.
          var titleProvider = renderer.titleProvider
          var resolveTitle, lastTitle, syncTitle
          if (view.contentDOM && titleProvider) {
            resolveTitle = resolve(titleProvider)
            var titleEl = document.createElement('div')
            // .sieve-block__heading, NOT .sieve-block__header (the chrome badge-bar).
            titleEl.className = 'sieve-block__heading'
            titleEl.contentEditable = 'false'
            view.contentDOM.parentNode.insertBefore(titleEl, view.contentDOM)
            syncTitle = function (h) {
              h = (h || '').trim()
              titleEl.innerHTML = h ? renderMarkdown(h, editor) : ''
              titleEl.style.display = h ? '' : 'none'   // empty → no region, no divider
              if (h) applyHighlighting(titleEl)
            }
          }

          // CONTENT — live PM nodes in contentDOM via the editor schema.
          var contentProvider = renderer.contentProvider || renderer.markdownProvider || renderer.markdownAttr
          var resolveBody, lastMd, syncMd
          if (view.contentDOM && contentProvider) {
            resolveBody = resolve(contentProvider)
            syncMd = function (md) {
              setTimeout(function () {
                if (!editor || !editor.view) return
                var html = renderMarkdown(md || '', editor) || '<p></p>'
                var tmp = document.createElement('div')
                tmp.innerHTML = html
                var PMDP = window.TipTap.ProseMirrorDOMParser || window.TipTap.DOMParser
                var slice = PMDP.fromSchema(editor.state.schema).parseSlice(tmp)
                var pos = typeof getPos === 'function' ? getPos() : -1
                // getPos can be stale by the time this deferred sync runs (the doc
                // may have shrunk), and doc.nodeAt THROWS (not returns null) for an
                // out-of-range pos. Bounds-check before touching the doc.
                var pmDoc = editor.state.doc
                if (pos == null || pos < 0 || pos >= pmDoc.content.size) return
                var cur = pmDoc.nodeAt(pos)
                if (!cur || !cur.type.name.startsWith('sieve-')) return
                var tr = editor.state.tr
                tr.replace(pos + 1, pos + 1 + cur.content.size, slice)
                tr.setMeta('sieve-md-sync', true)
                tr.setMeta('addToHistory', false)
                editor.view.dispatch(tr)
              }, 0)
            }
          }

          // Initial fill + one shared update wrapper for all slots. Gate on the
          // sync fns (only defined when view.contentDOM exists), so a title/content
          // provider on a contentDOM-less atom is simply inert rather than throwing.
          if (syncTitle) { lastTitle = resolveTitle(node.attrs); syncTitle(lastTitle) }
          if (syncMd) { lastMd = resolveBody(node.attrs); if (lastMd) syncMd(lastMd) }
          if (renderHeaderBar || syncTitle || syncMd) {
            var origUpdate = (typeof view.update === 'function') ? view.update.bind(view) : null
            view.update = function (updatedNode) {
              var ok = origUpdate ? origUpdate(updatedNode) : true
              if (!ok) return false
              // Toolbar re-renders on EVERY update so active states (a mode toggle,
              // a column toggle) track the live attrs. A control the user is
              // actively in (log's filter input) is preserved across the rebuild
              // by renderHeaderBar (adoptFocusedControl), so re-rendering no longer
              // robs it of focus — the old "skip while focus is inside the bar"
              // guard left button states stale (log toolbar "doesn't redraw") and
              // is retired.
              if (renderHeaderBar) renderHeaderBar()
              // Title/content re-sync only when their RESOLVED value changes.
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
              if (!cfg.inline) state.closeBlock(node)
            },

            parse: {
              // Wrap the markdownit fence rule. Only intercepts fences whose info
              // string matches this kind AND whose YAML body contains an id field.
              // All other fences fall through to the previous handler in the chain.
              setup: function (markdownit) {
                // 1. Inline parsing rule for `[!kind] {json} [!kind-end]`
                markdownit.inline.ruler.before('link', 'sieve_inline_' + kind, function(state, silent) {
                  var start = state.pos
                  if (state.src.charCodeAt(start) !== 0x5B /* [ */) return false
                  if (state.src.charCodeAt(start + 1) !== 0x21 /* ! */) return false

                  var regex = new RegExp('^\\\[!' + kind + '\\\]\\s*(\\\{.*?\\\})\\s*\\\[!' + kind + '-end\\\]')
                  var match = regex.exec(state.src.slice(start))
                  if (!match) return false

                  if (!silent) {
                    var jsonStr = match[1]
                    var data = null
                    try { data = JSON.parse(jsonStr) } catch (e) {}

                    if (data && data.id) {
                      var token = state.push('sieve_inline_' + kind, tag, 0)
                      var htmlAttrs = [
                        ['data-type', dataType],
                        ['data-kind', kind],
                        ['data-id', data.id],
                        ['data-status', data.status || 'PENDING']
                      ]
                      if (renderer.parseAttrs) {
                        var extra = renderer.parseAttrs(data)
                        Object.keys(extra).forEach(function (k) {
                          var kebab = k.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
                          htmlAttrs.push(['data-' + kebab, String(extra[k] != null ? extra[k] : '')])
                        })
                      }
                      if (data.createdAt) {
                        htmlAttrs.push(['data-created-at', data.createdAt])
                      }
                      if (data.supportsEmbedding) {
                        htmlAttrs.push(['data-supports-embedding', 'true'])
                      }
                      token.attrs = htmlAttrs
                    } else {
                      state.pos += match[0].length
                      return false
                    }
                  }
                  state.pos += match[0].length
                  return true
                })

                markdownit.renderer.rules['sieve_inline_' + kind] = function(tokens, idx) {
                  var token = tokens[idx]
                  var attrsStr = token.attrs.map(function(a) { return a[0] + '="' + esc(a[1]) + '"' }).join(' ')
                  return '<' + tag + ' ' + attrsStr + '></' + tag + '>'
                }

                // 2. Block parsing rule for fences
                var prevFence = markdownit.renderer.rules.fence
                markdownit.renderer.rules.fence = function (tokens, idx, options, env, self) {
                  var token     = tokens[idx]
                  var tokenKind = (token.info || '').trim()

                  if (tokenKind !== kind) {
                    return prevFence
                      ? prevFence(tokens, idx, options, env, self)
                      : self.renderToken(tokens, idx, options)
                  }

                  var data
                  try { data = window.jsyaml.load(token.content) } catch (e) { data = null }
                  if (!data || !data.id) {
                    return prevFence
                      ? prevFence(tokens, idx, options, env, self)
                      : self.renderToken(tokens, idx, options)
                  }

                  // The fence reconstructs the properties map (data) by parsing
                  // its YAML; build the data-* div from it via the SAME helper
                  // block-render.js uses with Go-sent attrs — one builder, exact
                  // parity across the load-from-markdown and load-from-attrs paths.
                  return buildSieveBlockHTML(kind, data)
                }
              },
            },
          },
        }
      },
    })
  }

  // ── Registry ─────────────────────────────────────────────────────────────────

  var nodeRegistry = {}
  var renderers = {}

  function registerSieveRenderer(kind, renderer) {
    nodeRegistry[kind] = createSieveNode(kind, renderer)
    renderers[kind] = renderer
    // Also record the kind in the shared block-kind registry (model-layer
    // symmetry): structured kinds are native:false (a sieve-<kind> NodeView
    // renders their payload). Prose registers itself as native:true in
    // prose-block.js. registerBlockKind is exposed on window.TipTap by
    // block-kinds.js; guard in case load order ever changes.
    if (window.TipTap && window.TipTap.registerBlockKind) {
      window.TipTap.registerBlockKind({ kind: kind, native: false, renderer: renderer })
    }
  }

  // buildSieveBlockHTML assembles a structured block's data-* div from its
  // PROPERTIES map (data) — the single builder shared by the markdownit fence
  // rule (load-from-markdown) and block-render.js (load-from-attrs), so both emit
  // byte-identical HTML that each renderer's parseHTML consumes. The block model
  // is properties-in: block-render passes Go-sent attrs straight in, no fence parse.
  function buildSieveBlockHTML(kind, data) {
    var renderer = renderers[kind]
    if (!renderer || !data || !data.id) return ''
    var cfg = Object.assign({}, DEFAULT_NODE_CONFIG, renderer.nodeConfig || {})
    var tag = cfg.inline ? 'span' : 'div'
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

    return '<' + tag + ' ' + htmlAttrs.join(' ') + '>' + innerHTML + '</' + tag + '>\n'
  }

  // Canonical friendly name for a sieve block node — the ONE source the live
  // label, the context menu, and the commit path share. Reuses each renderer's
  // optional buildAiCtx(node).contextLabel (e.g. a code block surfacing its
  // language), falling back to a title-cased kind.
  T.getSieveBlockLabel = function (node) {
    var kind = node && node.attrs ? node.attrs.kind : ''
    var r = renderers[kind]
    var base = (r && typeof r.buildAiCtx === 'function') ? r.buildAiCtx(node) : null
    var fallback = kind ? (kind.charAt(0).toUpperCase() + kind.slice(1).replace(/-/g, ' ')) : 'Block'
    return (base && base.contextLabel) || fallback
  }

  T.getSieveIcon = function(kind) {
    var r = renderers[kind]
    if (r && typeof r.getIcon === 'function') return r.getIcon()
    return window.SieveIcons ? window.SieveIcons.code : '' // fallback
  }

  T.resolveEntriesForKind = function(kind, sourceNode, entries) {
    // Look up the behaviour for ANY block via the uniform block-kind registry — prose
    // (native) resolves identically to structured kinds, no special-case fork.
    var h = T.getBlockBehaviour && T.getBlockBehaviour(kind)
    if (h && typeof h.resolveEntries === 'function') {
      return h.resolveEntries(sourceNode, entries)
    }
    return entries
  }

  function getSieveNodes() {
    // sieve-prose MUST be declared first among the sieveBlock group: PM's
    // createAndFill auto-fill is purely structural — it grabs the FIRST
    // instantiable node type in the required group (schema-declaration order),
    // with no notion of a default. Listing prose first makes every auto-fill
    // (empty doc, trailing/gap fill) a prose block, not a stray ai-block atom.
    var keys = Object.keys(nodeRegistry).sort(function (a, b) {
      return a === 'prose' ? -1 : b === 'prose' ? 1 : 0
    })
    return keys.map(function (k) { return nodeRegistry[k] })
  }

  // The backend returns [{kind, actions}]. The frontend is a dumb renderer: it shows
  // each offered (kind, action) and plays back {operation} — no replaceSource heuristic.
  function detectAndAppendExtractions({ sourceNode, sourceKind, entries, blockId, sourcePos, extractSourceLabel }) {
    fetch('/api/detect-extractions', {
      method: 'POST',
      body: JSON.stringify({ sourceKind: sourceKind, entries: entries }),
      headers: { 'Content-Type': 'application/json' }
    }).then(function (res) { return res.json() }).then(function (offers) {
      if (!offers || offers.length === 0) return
      if (!window.SieveContextMenu || !window.SieveContextMenu.appendItems) return

      var IC = window.SieveIcons || {}
      var headerLabel = 'FROM ' + (extractSourceLabel || sourceKind).toUpperCase().replace('-', ' ')
      var extraItems = [{ type: 'divider' }, { type: 'header', label: headerLabel }]

      var FRIENDLY = { prose: 'Text' }
      offers.forEach(function (offer) {
        var icon = IC[offer.kind] || IC.code
        var r = renderers[offer.kind]
        var prettyKind = FRIENDLY[offer.kind]
          || (r && typeof r.getFriendlyName === 'function'
            ? r.getFriendlyName()
            : offer.kind.split('-').map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1) }).join(' '))

        // Menu offers the source-mutating ops (extract/transform/undo-smart-paste); paste is never shown here.
        ;(offer.actions || []).forEach(function (action) {
          if (action !== 'extract' && action !== 'transform' && action !== 'undo-smart-paste') return

          var dispatch = function (context) {
            document.dispatchEvent(new CustomEvent('sieve:extract', {
              detail: {
                blockId: blockId || (sourceNode && sourceNode.attrs ? sourceNode.attrs.id : null),
                targetKind: offer.kind,
                operation: action,
                sourceNode: sourceNode,
                sourcePos: sourcePos,
                entries: entries,
                context: context || {}
              }
            }))
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
            label: (window.TipTap.labelForAction || function (a, k) { return a + ' ' + k })(action, prettyKind, offer, sourceKind),
            action: function () { dispatch({}) }
          })
        })
      })
      window.SieveContextMenu.appendItems(extraItems)
    }).catch(function () {})
  }

  // ── Native Code Block (syntax highlighting via CodeBlockLowlight) ─────────────
  // Uses CodeBlockLowlight's decoration system for highlighting. Visual appearance
  // is handled by the existing .tiptap .code-block CSS + .hljs-* token colours.

  if (T.CodeBlockLowlight) {
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

  // ── Exports ───────────────────────────────────────────────────────────────────

  T.registerSieveRenderer = registerSieveRenderer
  T.buildSieveBlockHTML = buildSieveBlockHTML
  T.getSieveNodes         = getSieveNodes
  // serializeNode turns a single block node into markdown via the editor's OWN
  // markdown serialiser. The serialiser sizes code fences longer than any backtick
  // run in the content, so this is the only safe way to render a node to a fence —
  // never hand-build ```. The node is wrapped in a fresh doc so the serialiser has a
  // valid root. Returns '' on failure (e.g. a node the serialiser can't handle).
  function serializeNode(editor, node) {
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
  function sieveBlockAttrs(node) {
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
  function sieveBlockEntries(node, renderer) {
    var entries = []
    if (renderer && typeof renderer.asContentEntry === 'function') {
      var custom = renderer.asContentEntry(node)
      if (custom && custom.length) entries = entries.concat(custom)
    }
    entries.push(sieveFrameworkEntry(node))
    return entries
  }

  T.detectAndAppendExtractions = detectAndAppendExtractions
  T.extractContentEntryFromEditor = extractContentEntryFromEditor
  T.serializeNode = serializeNode
  T.sieveBlockAttrs = sieveBlockAttrs
  T.sieveFrameworkEntry = sieveFrameworkEntry
  T.sieveBlockEntries = sieveBlockEntries
  T.rendererFor = function (kind) { return renderers[kind] }

})()
// extractContentEntryFromEditor inspects whatever DOM element was clicked (event.target)
// and, if it sits on something extractable, returns the ContentEntry array detection
// needs. It is shared by two callers: the Sieve-block NodeView (real DOM event) and the
// editor context menu (a synthetic { target: elementFromPoint(x,y) } — see context-menu.js).
// It therefore reads ONLY event.target; nothing else off the event.
function extractContentEntryFromEditor(event, editor) {
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
        var fenced = window.TipTap.serializeNode(editor, codeNode);
        if (fenced) {
          entries = [{ mimeType: 'text/plain', content: fenced }];
          extractSourceLabel = codeNode.attrs.language === 'mermaid' ? 'diagram' : 'code';
        }
      }
    }
  }
  return { entries, extractSourceLabel };
}

