// @ts-check
// wysiwyg-surface.js — the TipTap WYSIWYG input surface (P2.B).
//
// Faithful code motion of editor.js's mountWysiwyg (the island construction,
// block-sync cache + thin observer, docSyncFlush → flushPending), blockToNodes
// + renderBlocksIntoEditor (the block→node render pipeline), and the wysiwyg
// bodies of the insert-block / replace-block / block-attrs-updated render-back
// handlers (→ applyServerOp). The former module seams `noteServerBlock` and
// `reconcilePendingToken` are private METHODS here — the token-reconcile path
// can no longer call into a stale closure after a remount (recon coupling
// risk #3), because the methods and the cache live on the same instance.
//
// UNDO HISTORY IS SACRED (CLAUDE.md Non-Obvious Rules): the placement logic is
// verbatim — server ops land as TRACKED transactions (insertContentAt at
// docPosForBlockIndex(msg.index) / replace-by-block-id), the token swap and
// attrs updates are addToHistory:false, prose the editor already holds is
// skipped, scroll-to-new is universal. No full reload is ever used for an op.
//
// Normalization applied during motion (behavior-identical): VENDOR names go
// through the `T` vendor-bag import (base/tiptap-vendor.js);
// every APP helper is a direct ES import from its owning module (P4.E bus
// retirement). The module vars the old code wrote (currentEditor, docUpdateTimer,
// docSyncFlush, blockContentCache seams) are #private state; `window.__tiptap` is
// still set/nulled on mount/unmount for its remaining consumers (P4 migrates them).
//
// Dual-use ES module: `export` for vitest; `window.SieveWysiwygSurface` for the
// classic-script editor.js factory.

import { AbstractSurface, SurfaceEvent } from './abstract-surface.js'
import { EditorMode } from '../editor-mode.js'
import { ToolbarButton, ButtonGroup } from '../../shell/toolbar-button.js'
// P4.E: the app helpers the surface used to read off the shared TipTap bus are now
// direct ES imports from their OWNING modules (the bus is retired). Only genuine
// VENDOR names (Editor/Node/StarterKit/Table*/Placeholder/Image/Markdown/
// Extension/Plugin/Decoration(Set)/ProseMirrorDOMParser/…) still ride `#T` (the
// injected vendor bundle). The dead legacy ai-block extension entry (never
// published → always undefined) was removed in P4.E with Stephen's sign-off.
import { T } from '../../base/tiptap-vendor.js'
import { BlockId } from '../../block/prose-block.js'
import { ProseGroup, proseBlockNodes } from '../../block/prose-group.js'
import { copyImageToClipboard } from '../../ui/copy-image.js'
import { BlockChrome, getBlockSelectionRange } from '../block-chrome.js'
import { AiTargetDecoration } from '../../ai/ai-target-decoration.js'
import { Search, SelectionHighlight, HighlightMark, AiShortcuts } from '../extensions.js'
import { policyEnterKeydown, buildInteractionPolicyExtension } from '../interaction-policy.js'
import {
  getSieveNodes, getSieveBlockLabel, serializeNode, sieveBlockAttrs,
  sieveBlockEntries, rendererFor, domSelectionBlockRange, domSelectionTextInside,
} from '../../block/sieve-block-extension.js'
import { getBlockKind } from '../../block/block-kinds.js'
import { SieveBlock } from '../../block/sieve-block.js'
import { buildBlocksHTML, proseContent } from '../../block/block-render.js'
import { seedBaseline, computeBlockSync } from '../../block/block-sync.js'
import { docPosForBlockIndex, blockIndexAfter } from '../../base/block-position.js'
import { reloadReplacement } from '../../base/render-empty.js'
import { caretInRawTextBlock } from '../paste-context.js'

// The formatting command spec (P4.D): each entry is one ToolbarButton the WYSIWYG
// surface contributes to the editor toolbar. `icon` is a SieveIcons key; `cmd`
// runs on the surface's OWN #editorPane (the retired handleToolbarClick data-cmd
// switch — chain().focus().<cmd>().run()); `active` mirrors the retired syncToolbar
// isActive map. File-private frozen DATA (docs/how-to-idiomatic-js.md).
const FORMATTING_GROUPS = Object.freeze([
  Object.freeze([
    Object.freeze({ icon: 'bold', title: 'Bold', cmd: (c) => c.toggleBold(), active: ['bold'] }),
    Object.freeze({ icon: 'italic', title: 'Italic', cmd: (c) => c.toggleItalic(), active: ['italic'] }),
    Object.freeze({ icon: 'strike', title: 'Strikethrough', cmd: (c) => c.toggleStrike(), active: ['strike'] }),
    Object.freeze({ icon: 'code', title: 'Inline code', cmd: (c) => c.toggleCode(), active: ['code'] }),
  ]),
  Object.freeze([
    Object.freeze({ icon: 'h1', title: 'Heading 1', cmd: (c) => c.toggleHeading({ level: 1 }), active: ['heading', { level: 1 }] }),
    Object.freeze({ icon: 'h2', title: 'Heading 2', cmd: (c) => c.toggleHeading({ level: 2 }), active: ['heading', { level: 2 }] }),
    Object.freeze({ icon: 'h3', title: 'Heading 3', cmd: (c) => c.toggleHeading({ level: 3 }), active: ['heading', { level: 3 }] }),
  ]),
  Object.freeze([
    Object.freeze({ icon: 'bulletList', title: 'Bullet list', cmd: (c) => c.toggleBulletList(), active: ['bulletList'] }),
    Object.freeze({ icon: 'orderedList', title: 'Ordered list', cmd: (c) => c.toggleOrderedList(), active: ['orderedList'] }),
    Object.freeze({ icon: 'taskList', title: 'Task list', cmd: (c) => c.toggleTaskList(), active: ['taskList'] }),
  ]),
  Object.freeze([
    Object.freeze({ icon: 'blockquote', title: 'Blockquote', cmd: (c) => c.toggleBlockquote(), active: ['blockquote'] }),
    Object.freeze({ icon: 'table', title: 'Insert 3×3 table', cmd: (c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }), active: null }),
    Object.freeze({ icon: 'horizontalRule', title: 'Horizontal rule', cmd: (c) => c.setHorizontalRule(), active: null }),
  ]),
])

// Human labels for native unit node types, so the Ask panel header ("Ask About
// <label>") reads naturally (not "Ask About BulletList"). File-private frozen
// DATA (docs/how-to-idiomatic-js.md — a shared value, not behaviour), read by
// #labelFor. Owned by the surface since P3.F folded selection-descriptor.js in.
const NATIVE_UNIT_LABEL = Object.freeze({
  blockquote: 'Quote', codeBlock: 'Code Block',
  bulletList: 'List', orderedList: 'List', taskList: 'Task List',
  table: 'Table', image: 'Image', horizontalRule: 'Divider',
})

/**
 * @typedef {import('../abstract-editor.js').AbstractEditor} AbstractEditor
 */

export class WysiwygSurface extends AbstractSurface {
  /** @type {string} */
  #uuid

  /**
   * The parent editor (`host`) — the surface calls its public API directly:
   * onSurfaceEvent (outbound editor-domain events), flushSave (the PM-internal
   * Mod+S — caret-contextual, runs pre-core in editorProps handleKeyDown per
   * docs/editor-interaction-contract.md), takeInsertPos (applyServerOp numeric
   * fallback), and the insert-index math (insertIndexForBlock /
   * insertIndexForBlockAt / clearInsertPos) the surface's OWN #handleSmartPaste/Drop
   * need. Block-domain ops leave through the SERVICE PAIR reached via the
   * host's documentService/blockService getters (#submitOps — issue #49 Phase
   * 1; the service owns the WS enveloping). Nothing app-level: no chrome
   * names, no AI concepts.
   * @type {AbstractEditor}
   */
  #host

  /** @type {any} the TipTap vendor bundle */
  #T

  /** @type {HTMLElement|null} */
  #rootEl = null

  /** @type {any} the live TipTap Editor instance */
  #editorPane = null

  /**
   * Per-mount block-sync cache: { [blockId]: serializedContent } as of the last
   * successful sync. The thin observer (Stage D.3) diffs against it.
   * @type {Record<string, string>|null}
   */
  #blockContentCache = null

  /** @type {ReturnType<typeof setTimeout>|null} 500ms observer debounce (formerly module docUpdateTimer) */
  #syncTimer = null

  /**
   * The document-level `selectionchange` handler (P3.B). Read-only-region
   * highlights (contentEditable=false: ai-block title, log Explore table) do NOT
   * fire PM's onSelectionUpdate, so the model would never hear them. This feeds
   * the SAME path (host.onSurfaceEvent → editor #feedSelectionModel → feedSelection).
   * Stored so unmount removes it — no leak across remounts.
   * @type {(() => void)|null}
   */
  #onDocSelectionChange = null

  /**
   * @param {AbstractEditor} host — the parent editor (supplies uuid + the public API)
   */
  constructor(host) {
    super()
    if (!host) throw new Error('WysiwygSurface: host is required')
    if (!host.uuid) throw new Error('WysiwygSurface: uuid is required')
    this.#uuid = host.uuid
    this.#host = host
    this.#T = T
  }

  /** @returns {import('../editor-mode.js').EditorModeValue} */
  get mode() { return EditorMode.WYSIWYG }

  /** @returns {unknown|null} the live TipTap instance */
  get editorPane() { return this.#editorPane }

  /**
   * @override — chars/lines from the PM doc's textContent, blockCount from its
   * top-level childCount. Keeps ALL TipTap access surface-private (P4.D). Guards a
   * partial/absent view (mid-construction) → falls back to the line count.
   * @returns {{ chars: number, lines: number, blockCount: number }}
   */
  stats() {
    const ed = this.#editorPane
    const text = (ed && ed.state && ed.state.doc && ed.state.doc.textContent) || ''
    const lines = text === '' ? 0 : text.split('\n').length
    const blockCount = (ed && ed.state && ed.state.doc) ? ed.state.doc.childCount : lines
    return { chars: text.length, lines, blockCount }
  }

  // ── Document search (D-3: runs the Search extension on this surface's #editorPane) ──
  //
  // The SearchOverlay drives the editor's search verbs; the editor delegates here.
  // These are the exact command bodies that used to live behind SearchOverlay's
  // ed.editorPane reach — now surface-private, on this surface's OWN #editorPane (the
  // Search extension + its `storage.search` match set live there). searchTerm /
  // searchNext / searchPrev return the current match stats; clearSearch clears the
  // highlight and returns focus to the editing view (the overlay's close gesture).

  /**
   * @override
   * @param {string} term
   * @returns {{current:number,total:number}|false}
   */
  searchTerm(term) {
    const ed = /** @type {any} */ (this.editorPane)
    if (!ed) return false
    ed.commands.setSearchTerm(term)
    return this.#searchStats(ed)
  }

  /** @override @returns {{current:number,total:number}|false} */
  searchNext() {
    const ed = /** @type {any} */ (this.editorPane)
    if (!ed) return false
    ed.commands.nextSearchResult()
    return this.#searchStats(ed)
  }

  /** @override @returns {{current:number,total:number}|false} */
  searchPrev() {
    const ed = /** @type {any} */ (this.editorPane)
    if (!ed) return false
    ed.commands.prevSearchResult()
    return this.#searchStats(ed)
  }

  /** @override @returns {false} */
  clearSearch() {
    const ed = /** @type {any} */ (this.editorPane)
    if (!ed) return false
    ed.commands.clearSearch()
    ed.commands.focus()
    return false
  }

  /**
   * Current match stats from the Search extension storage, or null when it has no
   * results yet. `current` is 1-based when there are matches, 0 otherwise.
   * @param {any} ed @returns {{current:number,total:number}|null}
   */
  #searchStats(ed) {
    const s = ed.storage && ed.storage.search
    if (!s || !s.results) return null
    return { current: s.results.length > 0 ? s.currentIndex + 1 : 0, total: s.results.length }
  }

  /**
   * The WYSIWYG formatting button groups for the editor toolbar (P4.D). Each
   * button's onClick runs its command on this surface's OWN #editorPane
   * (chain().focus().<cmd>().run() — no window.__tiptap, no editor hop), and its
   * `active` closure reads this.#editorPane.isActive(...) (the retired syncToolbar
   * map, now per-button). Icons come from window.SieveIcons (verbatim bus).
   * @returns {ButtonGroup[]}
   */
  toolbarContents() {
    const self = this
    const icons = /** @type {any} */ (window).SieveIcons || {}
    return FORMATTING_GROUPS.map((specs) => new ButtonGroup(specs.map((spec) => new ToolbarButton({
      iconHtml: icons[spec.icon] || '',
      title: spec.title,
      onClick: () => { const ed = self.#editorPane; if (ed) spec.cmd(ed.chain().focus()).run() },
      active: spec.active ? () => { const ed = self.#editorPane; return !!(ed && ed.isActive.apply(ed, spec.active)) } : undefined,
    }))))
  }

  // ── Mount: the TipTap island (verbatim mountWysiwyg) ───────────────────────────

  /**
   * @param {HTMLElement} rootEl
   * @param {unknown}     content — { body, blocks } from the load / enter-wysiwyg reply
   */
  mount(rootEl, content) {
    var self = this
    var T = this.#T
    var uuid = this.#uuid
    var el = rootEl
    var blocks = (content && /** @type {any} */ (content).blocks) || null
    var initialized = false
    var suppressUpdate = false
    this.#rootEl = rootEl

    // Node-granular (2026-06-19): the doc top level holds NATIVE block nodes
    // (paragraph/heading/list/table/blockquote/…, group "block") AND structured
    // sieve blocks (group "sieveBlock") as siblings — a prose block IS one native
    // top-level node, not a custom container. The retired `sieveBlock+` schema
    // (+ its per-keystroke wrapper / minter / trailing-surface plugin) is gone;
    // PM owns node creation/splitting/merging natively. Identity rides on each
    // native node's `id` attr (BlockId, addGlobalAttributes); minting is
    // a passive observe-time concern (D-r.4), never a doc mutation here.
    var SieveDocument = T.Node.create({ name: 'doc', topNode: true, content: '(block | sieveBlock)+' })

    var editorPane = new T.Editor({
      element: el,
      extensions: [
        SieveDocument,
        BlockId,
        // trailingNode:true — caret contract clause 1 (no dead-ends): a
        // paragraph is guaranteed after a final structured block. The earlier
        // Gapcursor-only bet failed for non-atom read-only containers
        // (web-clip/ai-block) — see docs/editor-interaction-contract.md.
        T.StarterKit.configure({ document: false, link: false, codeBlock: false, trailingNode: true, history: { depth: 10000, newGroupDelay: 500 } }),
        T.Placeholder.configure({ placeholder: function (p) { return p.editor.isEmpty ? 'Start writing…' : '' } }),
        BlockChrome,
        AiTargetDecoration,
        T.Table.configure({ resizable: false }),
        T.TableRow,
        T.TableHeader,
        T.TableCell,
        Search,
        // Shared keyboard policy (priority 50 — runs AFTER native keymaps like
        // list indent and table cell-nav; docs/editor-interaction-contract.md).
        // Per-renderer key handlers are forbidden; kinds declare interactionPolicy.
        buildInteractionPolicyExtension(T),

        T.Image.configure({ inline: false, allowBase64: true, HTMLAttributes: { class: 'editor-image' } }),
        HighlightMark,
        SelectionHighlight,
        T.Extension.create({
          name: 'sieveFocusPlugin',
          addProseMirrorPlugins: function () {
            return [
              new T.Plugin({
                props: {
                  decorations: function (state) {
                    var sel = state.selection
                    if (!sel) return T.DecorationSet.empty
                    var decos = []
                    if (sel.node && String(sel.node.type.name).indexOf('sieve-') === 0) {
                      decos.push(T.Decoration.node(sel.from, sel.to, { class: 'sieve-block--focused' }))
                    } else if (sel.$from) {
                      var $from = sel.$from
                      for (var d = $from.depth; d >= 0; d--) {
                        var node = $from.node(d)
                        if (node && String(node.type.name).indexOf('sieve-') === 0) {
                          decos.push(T.Decoration.node($from.before(d), $from.after(d), { class: 'sieve-block--focused' }))
                          break
                        }
                      }
                    }
                    return T.DecorationSet.create(state.doc, decos)
                  }
                }
              })
            ]
          }
        }),
      ].concat(window.SieveNativeCodeBlock ? [window.SieveNativeCodeBlock] : [])
       .concat(ProseGroup ? [ProseGroup] : [])
       .concat(getSieveNodes()).concat([
        T.TaskList,
        T.TaskItem.configure({ nested: true }),
        T.Markdown.configure({ html: true, transformPastedText: true, link: { openOnClick: false } }),
        AiShortcuts.configure({
          // EXPLAIN (Mod+E) stays a caret-contextual editor chord; it fires the
          // transitional event the Ask panel consumes. ASK (Mod+Shift+A) LEFT the
          // editor keymap in P4.E (D-5) — the Ask panel's document listener owns it.
          onExplain: function () { document.dispatchEvent(new CustomEvent('sieve:ai-explain')) },
        }),
      ]),
      // Seed one empty native paragraph — the default editing surface of a new
      // doc. renderBlocksIntoEditor replaces it for a non-empty doc; an empty doc
      // keeps this typeable paragraph (a prose block; its id is minted on
      // first sync, D-r.4). A native <p> is a valid top-level node under the new
      // (block | sieveBlock)+ schema, so no custom container is needed.
      content: '<p></p>',
      editorProps: {
        attributes: { spellcheck: 'true' },
        handleDOMEvents: {
          copy: function(view, event) {
            // Copy is delegated to ProseMirror now that sieve blocks are real PM nodes.
            // text/plain + text/html are whatever PM produces. This handler only steps
            // in for the two things PM can't express:
            //   (1) smart-image → copy the actual bitmap, and
            //   (2) a WHOLE-block copy (single sieve NodeSelection or a gutter
            //       block-range) → ADD sieve/slice + sieve/<kind> so smart paste can
            //       rebuild the proper kind. We mirror PM's text/plain (the block's
            //       serialisedForm) and provide a richer text/html from the rendered DOM.
            // Sub-text highlights, bare cursors, and prose all fall through to native.
            var sel = view.state.selection

            // (1) Smart-image bitmap.
            if (sel && sel.node && sel.node.type.name === 'sieve-smart-image') {
              var src = sel.node.attrs.src
              if (!src) return false
              if (src.startsWith('http://') || src.startsWith('https://')) {
                src = window.location.origin + '/sieve-image-proxy?url=' + encodeURIComponent(src)
              } else if (!src.startsWith('data:') && !src.startsWith('blob:') && !src.startsWith('/')) {
                if (src.startsWith('.assets/')) src = src.substring(8)
                src = '/sieve/' + uuid + '/' + src.split('/').pop()
              }
              event.preventDefault()
              copyImageToClipboard(src)
              return true
            }

            // Range covered by the selection (a gutter block-range, a NodeSelection,
            // or a text range) — drives which blocks the loop below visits.
            var er = (T && getBlockSelectionRange)
              ? getBlockSelectionRange(view)
              : { from: sel.from, to: sel.to, active: !sel.empty, isBlockRange: false }

            var blockHTML = function (dom) {
              if (!dom) return ''
              var clone = dom.cloneNode(true)
              var ch = clone.querySelector('.block-chrome-host')
              if (ch) ch.remove()
              return clone.outerHTML
            }

            // selText returns the SELECTED portion of a node's text (so a partial
            // multi-block selection copies only the highlight).
            var selText = function (nodeFrom, nodeEnd) {
              var a = Math.max(er.from, nodeFrom), b = Math.min(er.to, nodeEnd)
              return b > a ? view.state.doc.textBetween(a, b, '\n') : ''
            }
            var escHtml = function (s) {
              return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            }
            // A block is partially selected when the (non-empty) selection cuts into
            // it. sieve/slice + sieve/<kind> always carry the WHOLE block (a block is
            // only meaningful whole); text/plain + text/html follow the selection.
            var partial = function (nodeFrom, nodeEnd) {
              return er.to > er.from && (er.from > nodeFrom || er.to < nodeEnd)
            }

            // Native DOM text highlight (once). A block's custom region (the log
            // Explore table) holds text PM does not own, so a highlight there
            // leaves PM's selection a whole-block NodeSelection — without this the
            // rich copy below would grab the ENTIRE block. text/plain + text/html
            // follow this highlight per-block (via domSelectionTextInside); the
            // sieve/slice + sieve/<kind> mimes stay whole-block (only-meaningful-whole).
            var domSel = (typeof window !== 'undefined' && window.getSelection) ? window.getSelection() : null
            var domSelHtml = ''
            if (domSel && !domSel.isCollapsed && domSel.toString().trim()) {
              try {
                var frag = document.createElement('div')
                for (var dri = 0; dri < domSel.rangeCount; dri++) frag.appendChild(domSel.getRangeAt(dri).cloneContents())
                domSelHtml = frag.innerHTML
              } catch (e) {}

              // Re-target `er` when the highlight lives in a block's READ-ONLY
              // region (the ai-block question title, the log Explore table —
              // contentEditable=false DOM PM cannot track). There PM's selection
              // stays on whatever block last held the caret, so the loop below —
              // driven by `er` — would visit and copy the WRONG (previously
              // selected) block. domSelectionBlockRange finds the block the user
              // actually highlighted and points the loop at it; when PM already
              // owns the highlighted text (er covers it) it returns null and er is
              // left untouched.
              var blockDescs = []
              view.state.doc.forEach(function (node, offset) {
                if (String(node.type.name).indexOf('sieve-') === 0) {
                  blockDescs.push({ from: offset, to: offset + node.nodeSize, dom: view.nodeDOM(offset) })
                }
              })
              var retarget = domSelectionBlockRange(domSel, er, blockDescs)
              if (retarget) {
                er = { from: retarget.from, to: retarget.to, active: true, isBlockRange: false, isNodeSelection: false }
              }
            }

            var sliceItems = []
            var plainParts = []
            var htmlParts = []
            var hasSieve = false
            var singleSieveEntries = null  // the framework ContentEntry array, if exactly one sieve block

            // sieve/slice is [][]ContentEntry — an ordered list of per-block entry
            // sets (a sequence of "normal pastes"), reconstructed server-side. Each
            // block contributes its FULL view set (sieve → framework views, prose →
            // its sieve/prose + text). text/plain + text/html follow the selection.
            var proseKind = getBlockKind && getBlockKind('prose')
            view.state.doc.forEach(function (node, offset) {
              var nodeEnd = offset + node.nodeSize
              if (nodeEnd <= er.from || offset >= er.to) return
              var dom = view.nodeDOM(offset)
              var entries
              if (String(node.type.name).indexOf('sieve-') === 0) {
                hasSieve = true
                entries = sieveBlockEntries(node, rendererFor(node.attrs.kind))
                singleSieveEntries = entries
              } else {
                entries = (proseKind && proseKind.asContentEntry && proseKind.asContentEntry(node, self.editorPane)) || []
              }
              sliceItems.push(entries)

              var pick = function (mime) {
                for (var vi = 0; vi < entries.length; vi++) {
                  if (entries[vi].mimeType === mime && entries[vi].content) return entries[vi].content
                }
                return null
              }
              // A native DOM highlight INSIDE this block's custom region (log
              // Explore table) → text/plain + text/html follow it, even though PM
              // sees the whole block selected. (sliceItems already holds the full
              // block above.)
              var domInBlock = domSelectionTextInside(domSel, dom)
              if (domInBlock) {
                plainParts.push(domInBlock)
                htmlParts.push(domSelHtml || escHtml(domInBlock))
              } else if (partial(offset, nodeEnd)) {
                // Cut by the PM selection → just the highlighted text.
                plainParts.push(selText(offset, nodeEnd))
                htmlParts.push(escHtml(selText(offset, nodeEnd)))
              } else {
                // Whole block / bare cursor → the block's full text + html views.
                plainParts.push(pick('text/plain') || node.textContent || (dom ? dom.innerText : ''))
                htmlParts.push(pick('text/html') || blockHTML(dom))
              }
            })

            if (!hasSieve) return false   // pure prose → native PM copy

            // Every sieve-involving copy is served HERE — never deferred to native
            // PM copy. A sub-text selection used to fall through to native, but a
            // slice inside a `defining`/`code` block (code, diagram, log-raw)
            // re-wraps the WHOLE node, so native copied the entire block. Instead
            // the loop above already put the SELECTION into text/plain + text/html
            // (per-block, via the DOM highlight or the PM range) while sieve/slice +
            // sieve/<kind> carry the whole block — one uniform rule, every kind.
            event.preventDefault()
            event.clipboardData.setData('text/plain', plainParts.filter(Boolean).join('\n\n'))
            event.clipboardData.setData('text/html', htmlParts.filter(Boolean).join('\n'))
            event.clipboardData.setData('sieve/slice', JSON.stringify(sliceItems))
            // Single sieve block → also expose every mime in its framework ContentEntry
            // array (custom views like text/uri-list + the sieve/<kind> view), so a
            // cross-context paste lands on the same backend matchers as extraction.
            if (sliceItems.length === 1 && sliceItems[0]._type === 'sieve' && singleSieveEntries) {
              singleSieveEntries.forEach(function (en) { event.clipboardData.setData(en.mimeType, en.content) })
            }
            return true
          },
          click: function (view, event) {
            if (!window.isMod(event)) return false
            var pos = view.posAtCoords({ left: event.clientX, top: event.clientY })
            if (pos) {
              var marks = view.state.doc.resolve(pos.pos).marks()
              for (var i = 0; i < marks.length; i++) {
                if (marks[i].type.name === 'link') {
                  var href = marks[i].attrs.href
                  setTimeout(function () { window.runtime && window.runtime.BrowserOpenURL(href) }, 50)
                  event.preventDefault()
                  return true
                }
              }
            }
            return false
          },
        },
        handlePaste: function (_view, event) { return self.#handleSmartPaste(event) },
        handleDrop: function (_view, event, slice, moved) { return self.#handleSmartDrop(event) },
        handleKeyDown: function (view, event) {
          if (event.key === 's' && window.isMod(event)) {
            event.preventDefault()
            self.#host.flushSave()
            return true
          }
          // Enter family routes through the interaction policy FROM HERE
          // (pre-core: TipTap's core Keymap would otherwise consume Enter in
          // code:true blocks). Returns false in every context the policy
          // does not own, so native prose/list/table Enter is untouched.
          if (event.key === 'Enter' && policyEnterKeydown &&
              policyEnterKeydown(view, event, self.#host)) {
            return true
          }
          // Tab/Shift+Tab are owned by the interaction-policy extension
          // (docs/editor-interaction-contract.md) — never handle them here:
          // editorProps runs BEFORE extension keymaps and would shadow
          // list indent and table cell navigation (that was defect #6).
          // Block-insertion chords (Mod+Shift+W/L/D) are owned by the native
          // menu (App-Level Chords); the editor no longer binds them.
          return false
        },
      },
      onCreate: function () {
        initialized = true
      },
      onSelectionUpdate: function () {
        self.#host.onSurfaceEvent(SurfaceEvent.SELECTION_CHANGED)
      },
      onTransaction: function () {
        self.#host.onSurfaceEvent(SurfaceEvent.TRANSACTION)
      },
      onUpdate: function (p) {
        if (!initialized || suppressUpdate) return
        // Stage D.3: the thin observer. We no longer serialize the whole document
        // on every keystroke — onUpdate only reports the change and (re)arms a
        // debounce. The actual diff + wire send happens once typing settles, in
        // syncDocument, which emits granular block-ops (id-less nodes are
        // skipped until minted — no whole-document fallback).
        self.#host.onSurfaceEvent(SurfaceEvent.DOC_CHANGED)
        if (self.#syncTimer) clearTimeout(self.#syncTimer)
        self.#syncTimer = setTimeout(function () {
          self.#syncTimer = null
          self.#syncDocument(editorPane)
        }, 500)
      },
    })

    this.#editorPane = editorPane
    // The NodeView→Editor handle (P4.F Brief C): stamp the parent Editor onto the
    // TipTap pane the surface built, so a block capability (ctx.getEditor) can reach
    // the Editor's PUBLIC API through the held pane — never the backend directly, and
    // never a window global. Read lazily by getEditor at capability-fire time.
    editorPane.sieveHost = this.#host
    // The BlockService singleton rides the same stamp as sieveHost — the
    // NodeView ctx reads it (ctx.blockService) for renderer construction +
    // v1 applier registration (contract §service pair).
    editorPane.blockService = this.#host.blockService || null
    window.__tiptap = editorPane

    // Stage D.2: the block list IS the document model. When the load supplied it,
    // render the document from the blocks (prose → native node(s); structured →
    // its fence rule), bypassing the markdown `content:` seed above. We build the
    // HTML with the editor's OWN markdownit (so the fence parse rules are live)
    // and parse it through ProseMirror's DOMParser — reusing every node's
    // parseHTML, never hand-building ProseMirror JSON. suppressUpdate guards the
    // initial replace so it isn't mistaken for a user edit / doc-update.
    if (blocks && blocks.length && buildBlocksHTML) {
      suppressUpdate = true
      try {
        this.#renderBlocksIntoEditor(editorPane, blocks)
      } catch (err) {
        console.error('[editor] block render failed; keeping markdown seed', err)
      } finally {
        suppressUpdate = false
      }
    }

    // Seed the block-sync baseline from GO's block list (what the server has),
    // so a PM-created block (empty-doc fill / split) is seen as new and synced.
    this.#seedBlockCache(editorPane, blocks)

    // Catch focus events on inner form controls (like Sieve Code block textareas)
    // where ProseMirror's native onSelectionUpdate won't fire.
    editorPane.view.dom.addEventListener('focusin', function() {
      self.#host.onSurfaceEvent(SurfaceEvent.FOCUS_CHANGED)
    })

    // P3.B: a highlight dragged inside a block's READ-ONLY region (ai-block title,
    // log Explore table — contentEditable=false) does NOT fire PM's
    // onSelectionUpdate, so feed the model via the SAME selection-changed path.
    // The model already coalesces caret-only noise; the read-only-region drags
    // that matter change range/selectedText, which ARE meaningful — no debounce
    // added (revisit only if the smoke shows churn).
    this.#onDocSelectionChange = function () { self.#host.onSurfaceEvent(SurfaceEvent.SELECTION_CHANGED) }
    document.addEventListener('selectionchange', this.#onDocSelectionChange)
  }

  /**
   * Tears down the island: kills the observer debounce, destroys the TipTap
   * editor, clears the root's children (faithful to the old toggle's
   * innerHTML='' swap) and the window.__tiptap handle.
   */
  unmount() {
    if (this.#syncTimer) { clearTimeout(this.#syncTimer); this.#syncTimer = null }
    if (this.#onDocSelectionChange) {
      document.removeEventListener('selectionchange', this.#onDocSelectionChange)
      this.#onDocSelectionChange = null
    }
    if (this.#editorPane) {
      this.#editorPane.destroy()
      this.#editorPane = null
    }
    if (this.#rootEl) this.#rootEl.innerHTML = ''
    this.#rootEl = null
    this.#blockContentCache = null
    window.__tiptap = null
  }

  /**
   * Immediate flush of the pending debounced block-sync (formerly the module
   * docSyncFlush seam — used by flushSave / tab switch / mode toggle /
   * commitInsertIndex). Idle → no-op.
   */
  flushPending() {
    if (!this.#syncTimer) return
    clearTimeout(this.#syncTimer)
    this.#syncTimer = null
    const ed = this.editorPane
    if (ed) this.#syncDocument(ed)
  }

  // ── Smart paste / drop (P4.A: moved off editor.js's IIFE) ──────────────────────
  //
  // Tiptap-bound clipboard/drag I/O, wired at editorProps.handlePaste/handleDrop.
  // Verbatim code motion of editor.js's handleSmartPaste/handleSmartDrop: the
  // transaction dispatches (ai-block reimport insertContent, no-match fallback
  // insertContent) keep their TRACKED (default addToHistory) semantics and their
  // preventDefault gates. The insert-index math is editor-sourced via #host
  // (insertIndexForBlock / insertIndexForBlockAt / clearInsertPos) — the shared
  // insert-position state lives on the editor (D-1). caretInRawTextBlock is now an
  // ES import (paste-context.js); the window.jsyaml read stays VERBATIM (jsyaml is
  // a separate global, out of scope for the TipTap-bus retirement).

  /**
   * @param {ClipboardEvent} event
   * @returns {boolean} true when handled (native paste suppressed)
   */
  #handleSmartPaste(event) {
    if (!event.clipboardData || !this.#editorPane) return false

    if (event.target && (/** @type {any} */ (event.target).tagName === 'INPUT' || /** @type {any} */ (event.target).tagName === 'TEXTAREA')) {
      return false
    }

    // Caret inside a raw-text fenced block (code / diagram / log — code:true
    // nodes): paste is a literal text paste into that block, not a smart-paste
    // that mints a new block. Step aside; PM's default handler inserts the text.
    if (caretInRawTextBlock && caretInRawTextBlock(this.#editorPane)) {
      return false
    }

    var text = event.clipboardData.getData('text/plain')
    var html = event.clipboardData.getData('text/html')

    // ── 1. ai-block re-import (JS-owned) ────────────────────────────────────────
    // Pasting a complete ```ai-block…``` fence reconstructs the existing block
    // node with its original ID — no Go round-trip needed.
    if (text && text.trim().startsWith('```ai-block')) {
      var cleanText = text.trim()
      var firstLineEnd = cleanText.indexOf('\n')
      var lastBackticks = cleanText.lastIndexOf('```')
      if (firstLineEnd !== -1 && lastBackticks !== -1 && lastBackticks > firstLineEnd) {
        var yamlText = cleanText.substring(firstLineEnd + 1, lastBackticks).trim()
        try {
          var data = window.jsyaml.load(yamlText)
          if (data && data.id) {
            event.preventDefault()
            this.#editorPane.commands.insertContent({
              type: 'sieve-ai-block',
              attrs: {
                rawYaml:     yamlText,
                id:          data.id || '',
                ref:         data.ref || 'doc',
                status:      data.status || 'PENDING',
                type:        data.type || null,
                model:       data.model || null,
                createdAt:   data.createdAt || null,
                completedAt: data.completedAt || null,
                question:    data.question || '',
                response:    data.response || null,
              }
            })
            return true
          }
        } catch (e) {
          console.error('[editor.js] Failed to parse pasted ai-block yaml', e)
        }
      }
    }

    // ── 1b. sieve/slice → server-side reconstruct ───────────────────────────────
    // A multi-block slice ([][]ContentEntry) is reconstructed by Go: FirstPasteMatch
    // per item → a block at cursorIndex+i with a fresh backend id (prose claims its
    // sieve/prose). Each created block render-backs via insert-block at its index.
    // A single-block slice falls through to the smart-paste pipeline, which resolves
    // it from its sieve/<kind> view the same way.
    var sliceData = event.clipboardData.getData('sieve/slice')
    if (sliceData && this.#uuid && !this.#uuid.startsWith('prompt:')) {
      try {
        var slice = JSON.parse(sliceData)
        if (Array.isArray(slice) && slice.length > 1) {
          event.preventDefault()
          var ds = this.#host.documentService
          if (!ds) return true // disconnected editor: paste suppressed, drop (socketless parity)
          var sliceIndex = this.#host.insertIndexForBlock()
          this.#host.clearInsertPos() // slice render-backs position by op index, not this
          ds.pasteSlice(this.#uuid, { slice: slice, index: sliceIndex })
            .catch(function (err) { console.error('[editor.js] paste-slice failed', err) })
          return true
        }
      } catch (e) {
        console.error('[editor.js] Failed to parse sieve/slice paste', e)
      }
    }

    // ── 2. Smart-paste pipeline (including images) ────────────────────────────────
    // Collect all clipboard entries. For files, we use FileReader to get base64.
    if (this.#uuid && !this.#uuid.startsWith('prompt:')) {
      var self = this
      if (event.clipboardData && event.clipboardData.items) {
        var promises = []
        Array.from(event.clipboardData.items).forEach(function(item) {
          if (item.kind === 'file') {
            var file = item.getAsFile()
            if (file) {
              promises.push(new Promise(function(resolve) {
                var reader = new FileReader()
                reader.onload = function(e) {
                  resolve({ mimeType: file.type, content: /** @type {any} */ (e.target).result })
                }
                reader.onerror = function() { resolve(null) }
                reader.readAsDataURL(file)
              }))
            }
          } else if (item.kind === 'string') {
            promises.push(new Promise(function(resolve) {
              item.getAsString(function(str) {
                resolve({ mimeType: item.type, content: str })
              })
            }))
          }
        })

        // Smart-paste resolves a block kind server-side (web-clip / smart-image /
        // smart-card) → PEEK the insert position as a block index for Go to position.
        // Peek is side-effect-free (issue #33): the caret's empty-paragraph anchor is
        // consumed ONLY once Go confirms a match — a no-match must leave the blank line
        // and caret intact so the fallback pastes there, not into an adjacent code block.
        var peek = this.#host.peekInsertIndexForBlock()
        event.preventDefault()

        Promise.all(promises).then(function(results) {
          var validEntries = results.filter(function(r) { return r !== null })
          var ds = self.#host.documentService
          if (!ds) return // disconnected editor: drop (socketless parity)
          ds.smartPaste(self.#uuid, { entries: validEntries, index: peek.index })
            .then(function (result) {
              if (!self.#editorPane) return
              if (result.matched) {
                // Rendered via insert-block (tracked insert at its server index). NOW
                // consume the empty-paragraph anchor (deferred delete, by node id).
                self.#host.consumeInsertAnchor(peek.anchor)
              } else {
                // No processor matched — the blank line was never eaten, so replay the
                // original clipboard content locally at the intact caret.
                self.#host.clearInsertPos()
                if (html) {
                  self.#editorPane.commands.insertContent(html)
                } else if (text) {
                  self.#editorPane.commands.insertContent(text)
                }
                // We preventDefault()'d the paste, so PM never ran its native
                // scroll-to-caret — restore it so the view follows the inserted text.
                self.#editorPane.commands.scrollIntoView()
              }
            })
            .catch(function (err) {
              console.error('[editor.js] smart-paste fetch failed', err)
              self.#host.clearInsertPos()
              if (self.#editorPane) {
                self.#editorPane.commands.insertContent(text)
                self.#editorPane.commands.scrollIntoView()
              }
            })
        })
        return true
      }
    }

    return false
  }

  /**
   * @param {DragEvent} event
   * @returns {boolean} true when handled (native drop suppressed)
   */
  #handleSmartDrop(event) {
    if (!event.dataTransfer || !this.#editorPane) return false

    if (this.#uuid && !this.#uuid.startsWith('prompt:')) {
      var self = this
      var promises = []
      var hasFiles = false
      if (event.dataTransfer.items) {
        Array.from(event.dataTransfer.items).forEach(function(item) {
          if (item.kind === 'file') {
            var file = item.getAsFile()
            if (file && file.type.startsWith('image/')) {
              hasFiles = true
              promises.push(new Promise(function(resolve) {
                var reader = new FileReader()
                reader.onload = function(e) {
                  resolve({ mimeType: file.type, content: /** @type {any} */ (e.target).result })
                }
                reader.onerror = function() { resolve(null) }
                reader.readAsDataURL(file)
              }))
            }
          } else if (item.kind === 'string') {
            promises.push(new Promise(function(resolve) {
              item.getAsString(function(str) {
                resolve({ mimeType: item.type, content: str })
              })
            }))
          }
        })
      }

      if (!hasFiles) return false

      var pos = this.#editorPane.view.posAtCoords({ left: event.clientX, top: event.clientY })
      var insertPos = pos ? pos.pos : this.#editorPane.state.selection.to
      // PEEK (issue #33): drops always match server-side today (images only), but the
      // eager delete is the same latent hazard — defer the anchor consume to matched.
      var peek = this.#host.peekInsertIndexAt(insertPos)

      event.preventDefault()

      Promise.all(promises).then(function(results) {
        var validEntries = results.filter(function(r) { return r !== null })
        if (validEntries.length === 0) return
        var ds = self.#host.documentService
        if (!ds) return // disconnected editor: drop (socketless parity)
        ds.smartPaste(self.#uuid, { entries: validEntries, index: peek.index })
          .then(function (result) {
            if (!self.#editorPane) return
            if (result.matched) {
              // Rendered via insert-block (tracked insert at its server index). NOW
              // consume the empty-paragraph anchor (deferred delete, by node id).
              self.#host.consumeInsertAnchor(peek.anchor)
            }
          })
          .catch(function (err) {
            console.error('[editor.js] smart-drop fetch failed', err)
          })
      })
      return true
    }
    return false
  }

  // ── Selection feed (P3.A: the SelectionModel raw source) ───────────────────────

  /**
   * Builds a RAW selection descriptor from the LIVE PM state — the ONLY place PM
   * selection is read for the SelectionModel (the model itself never touches PM).
   * PLAIN data only: no PM node escapes; blockId/blockKind/ref are extracted as
   * strings, and the resolved AI `target` ({kind,ref,range,label}) is baked in.
   *
   * This method owns the PARTS THAT NEED THE LIVE VIEW/DOM: the effective range
   * (block-chrome getBlockSelectionRange — its own plugin state for gutter/shift-
   * click multi-block; falls back to the live PM selection) and the read-only-region
   * DOM highlight fold (F5: ai-block title / log Explore table — contentEditable=false
   * PM can't track). It then delegates the PM-only descriptor assembly (classification,
   * blockIds span, primary, target + label) to `buildSelectionDescriptor` — the SAME
   * pure core the vitest adapter reuses, so they can't drift (P3.C).
   * @returns {import('../selection-model.js').RawSelectionDescriptor}
   */
  feedSelection() {
    // Read through the public `tiptap` accessor (as applyServerOp/flushPending
    // do) — the live instance, whatever a subclass injects.
    const ed = /** @type {any} */ (this.editorPane)
    if (!ed || !ed.state) {
      return {
        selectionType: 'none', caret: null, range: null, selectedText: null,
        blockId: null, blockIds: [], blockKind: null, ref: null, blockCursor: null,
        target: { kind: 'document', ref: 'doc', range: null, label: 'Document' },
      }
    }
    const T = this.#T
    const state = ed.state
    const sel = state.selection

    // The EFFECTIVE range: block-chrome's authoritative range (its own plugin
    // state for gutter/shift-click multi-block; falls back to the live PM
    // selection for a caret / single NodeSelection / native prose drag).
    let er = (T && getBlockSelectionRange)
      ? getBlockSelectionRange(ed.view)
      : { from: sel.from, to: sel.to, active: !sel.empty, isBlockRange: false, isNodeSelection: !!sel.node }

    // Read-only-region DOM highlight fold (F5): a highlight inside a block's
    // contentEditable=false region leaves PM's selection elsewhere. Re-target the
    // effective range onto the block the highlight actually lives in.
    const domSel = (typeof window !== 'undefined' && window.getSelection) ? window.getSelection() : null
    let domSelText = null
    if (domSel && !domSel.isCollapsed && domSel.toString && domSel.toString().trim() && T && domSelectionBlockRange) {
      const blockDescs = this.#topBlockDescriptors(ed)
      const retarget = domSelectionBlockRange(domSel, er, blockDescs)
      if (retarget) {
        er = { from: retarget.from, to: retarget.to, active: true, isBlockRange: false, isNodeSelection: false }
        domSelText = domSel.toString()
      }
    }

    const raw = this.#buildSelectionDescriptor(state.doc, sel, er, T, domSelText)
    // The DOM read the pure PM core must NOT do: if focus sits inside a block's
    // inner editor (`.sieve-block__edit`), merge its OWN cursor as the opaque,
    // caret-like blockCursor (P3.E). Null for a plain prose caret. This is the
    // P3.C split extended by one surface-owned DOM read.
    raw.blockCursor = this.#captureBlockCursor()
    return raw
  }

  /**
   * DORMANT SEAM (P3.E — see selection-model CONVENTION): captures a block's inner
   * cursor ONLY when focus sits in a `.sieve-block__edit` FORM CONTROL (selectionStart)
   * or a block opting in via `host.__sieveFocus.capture()`. NO current block is built
   * that way — code/diagram/log edit via a PM contentDOM (`activeElement` stays on
   * `.ProseMirror`, their caret is already `caret`/`range`), so this returns `null` in
   * practice. Kept as the extension point for a future non-PM inner editor. Surface-
   * owned DOM read; no PM/YAML.
   * @returns {object|null}
   */
  #captureBlockCursor() {
    const ae = document.activeElement
    if (ae && ae.classList && ae.classList.contains('sieve-block__edit')) {
      const host = ae.closest ? ae.closest('[data-id]') : null
      if (host) {
        const hook = /** @type {any} */ (host).__sieveFocus
        return (hook && typeof hook.capture === 'function')
          ? hook.capture()
          : { start: /** @type {any} */ (ae).selectionStart, end: /** @type {any} */ (ae).selectionEnd }
      }
    }
    return null
  }

  /**
   * Restores focus/selection from a SelectionContext coordinate (P3.E write side) —
   * the symmetric WRITE of feedSelection, inlined like MarkdownSurface.applyPosition.
   * When the ctx names a block that hosts an inner editor AND carries a blockCursor,
   * restore INSIDE that block (per-flavour `__sieveFocus.restore`, else the generic
   * `.sieve-block__edit` textarea with a stale-token clamp). Otherwise re-resolve the
   * DOCUMENT caret/range against the current doc size and drive the editor. TipTap via
   * `this.editorPane` (its own accessor, as flushPending/applyServerOp do) — never exposed.
   * @param {import('../selection-model.js').SelectionContext} ctx
   */
  applyPosition(ctx) {
    // (a) block-inner cursor.
    if (ctx && ctx.blockId && ctx.blockCursor != null) {
      const host = document.querySelector('[data-id="' + ctx.blockId + '"]')
      if (host) {
        const hook = /** @type {any} */ (host).__sieveFocus
        if (hook && typeof hook.restore === 'function') { hook.restore(ctx.blockCursor); return }
        const ta = /** @type {any} */ (host.querySelector('.sieve-block__edit'))
        if (ta) {
          ta.focus()
          const tk = /** @type {any} */ (ctx.blockCursor) || {}
          const len = ta.value.length
          const s = Math.min(tk.start || 0, len)
          const e = Math.min(tk.end != null ? tk.end : s, len)
          try { ta.selectionStart = s; ta.selectionEnd = e } catch (_) {}
          return
        }
      }
      // block/textarea gone → fall through to the doc caret.
    }
    // (b) doc caret/range re-resolved against the CURRENT doc: a captured Selection is
    // bound to its doc instance and would throw if anything edited in between.
    const ed = /** @type {any} */ (this.editorPane)
    if (ed) {
      ed.view.focus()
      const size = ed.state.doc.content.size
      const c = ctx && ctx.range ? ctx.range : { from: ctx && ctx.caret, to: ctx && ctx.caret }
      const from = Math.min(c.from != null ? c.from : 0, size)
      const to = Math.min(c.to != null ? c.to : from, size)
      try { ed.commands.setTextSelection({ from: from, to: to }) } catch (_) {}
    }
  }

  /**
   * Ordered top-level sieve-block descriptors `[{from, to, dom}]` (the copy
   * handler's pattern, 6ee94bd) — the read-only-region fold input. Only sieve
   * nodes hold a read-only region PM cannot track; native prose is PM-owned.
   * @param {any} ed @returns {Array<{from:number,to:number,dom:any}>}
   */
  #topBlockDescriptors(ed) {
    const out = []
    const view = ed.view
    ed.state.doc.forEach((node, offset) => {
      if (String(node.type.name).indexOf('sieve-') === 0) {
        out.push({ from: offset, to: offset + node.nodeSize, dom: view && view.nodeDOM ? view.nodeDOM(offset) : null })
      }
    })
    return out
  }

  // ── PM→descriptor core (folded from selection-descriptor.js, P3.F) ─────────────
  //
  // The PM-only descriptor assembly: turns a live ProseMirror (doc + selection +
  // effective range) into the PLAIN raw descriptor the SelectionModel ingests —
  // INCLUDING the resolved AI `target` ({kind, ref, range, label}) and its label.
  // NO PM node ever escapes: the resolver USES PM to PRODUCE plain values; the
  // descriptor STORES plain values only. These were `export function`s in the
  // retired selection-descriptor.js; folded here verbatim as #private methods
  // (they are all PM-specific — MarkdownSurface needs none of them; only the
  // string-only quoteSnippet is shared, and it lives on AbstractSurface).

  /**
   * Build the full PLAIN raw descriptor from a live PM (doc + selection + effective
   * range). The ONE place PM is read into a descriptor.
   *
   * Classification (locked ruling folds dom/block-range → 'range'): single
   * NodeSelection → 'block'; block-range OR dom-fold → 'range'; collapsed → 'caret';
   * else non-empty text → 'range'.
   *
   * @param {any} doc              the PM doc
   * @param {any} sel              the PM selection (state.selection)
   * @param {{from:number,to:number,active:boolean,isBlockRange?:boolean,isNodeSelection?:boolean}} er  the effective range (surface-computed)
   * @param {any} T                truthy gate: enables the rich getSieveBlockLabel path (#labelFor)
   * @param {string|null} [domSelText]  read-only-region DOM highlight text (F5 fold), or null
   * @returns {import('../selection-model.js').RawSelectionDescriptor}
   */
  #buildSelectionDescriptor(doc, sel, er, T, domSelText = null) {
    let selectionType
    if (er.isNodeSelection && !er.isBlockRange) selectionType = 'block'
    else if (er.isBlockRange) selectionType = 'range'
    else if (domSelText !== null) selectionType = 'range'
    else if (er.from === er.to) selectionType = 'caret'
    else selectionType = 'range'

    const span = this.#blocksInRange(doc, er.from, er.to)
    const primary = this.#primaryBlock(doc, sel, span)

    let selectedText = null
    if (selectionType === 'range') {
      selectedText = domSelText !== null ? domSelText : doc.textBetween(er.from, er.to, ' ')
    }

    const primaryId = this.#nodeBlockId(primary)
    // A COLLAPSED caret spans exactly ONE block — its primary. A RANGE keeps the full
    // multi-block overlap span (D3). (See the surface note the code moved from.)
    const blockIds = (selectionType === 'caret')
      ? (primaryId ? [primaryId] : [])
      : span.map((b) => b.id).filter(Boolean)

    const blockKind = this.#nodeBlockKind(primary)
    const range = { from: er.from, to: er.to }
    const label = this.#labelFor(primary, selectionType, blockKind, selectedText, T)
    const target = this.#resolveTarget(selectionType, blockKind, primaryId, blockIds, range, label)

    return {
      selectionType: selectionType,
      caret: sel.head,
      range: range,
      selectedText: selectedText,
      blockId: primaryId,
      blockIds: blockIds,
      blockKind: blockKind,
      ref: this.#nodeRef(primary),
      target: target,
    }
  }

  /**
   * The resolved AI `target` — the four ordered cases (D-r.7), from PLAIN values.
   * The label is baked in (labelFor ran while `primary` was in hand).
   *   (a) NodeSelection of a UNIT (proseGroup excluded) → block by id
   *   (b) text selection OR node-selected proseGroup → selection + ref chain
   *   (c) bare caret in a UNIT → block by id
   *   (d) bare caret in flowing text / none → document
   * @param {'none'|'caret'|'range'|'block'} selectionType
   * @param {string|null} blockKind
   * @param {string|null} blockId
   * @param {string[]} blockIds
   * @param {{from:number,to:number}|null} range
   * @param {string} label
   * @returns {{kind:'block'|'selection'|'document', ref:string, range:{from:number,to:number}|null, label:string}}
   */
  #resolveTarget(selectionType, blockKind, blockId, blockIds, range, label) {
    // (a) NodeSelection of a UNIT block.
    if (selectionType === 'block' && blockKind !== 'proseGroup') {
      return { kind: 'block', ref: blockId || 'doc', range: range, label: label }
    }
    // (b) non-empty text selection OR node-selected proseGroup → ref chain.
    if (selectionType === 'range' || (selectionType === 'block' && blockKind === 'proseGroup')) {
      const ref = (blockIds && blockIds.length) ? blockIds.join(',') : (blockId || 'doc')
      return { kind: 'selection', ref: ref, range: range, label: label }
    }
    // (c) bare caret in a UNIT.
    if (selectionType === 'caret' && !this.#isFlowingText(blockKind)) {
      return { kind: 'block', ref: blockId || 'doc', range: range, label: label }
    }
    // (d) bare caret in flowing text / none → the document.
    return { kind: 'document', ref: 'doc', range: null, label: label }
  }

  /**
   * The PRIMARY block node: a NodeSelection targets its own node; otherwise the
   * block at the selection HEAD (via $from) WHEN that block is inside the spanned
   * range. When the effective range was re-targeted (a read-only-region DOM fold / a
   * block-chrome range that doesn't cover the PM head), the head block is NOT in the
   * span, so fall to the FIRST block the range spans.
   *
   * DOC-LEVEL GAP (depth 0 — a collapsed caret at a point between top-level nodes,
   * e.g. after an atom / at doc end): faithful port of the old topLevelForCaret gap
   * branch — prefer the ADJACENT non-flowing UNIT (nodeBefore, then nodeAfter) so a
   * caret sitting in the gap after an hr / before a paragraph still targets that unit,
   * never a flowing paragraph. Falls back to the index-clamped child otherwise (range
   * spans that don't cover the head).
   * @param {any} doc @param {any} sel @param {any} span
   * @returns {any|null}
   */
  #primaryBlock(doc, sel, span) {
    if (sel.node) return sel.node
    const spanNodes = span.map((b) => b.node)
    let head = null
    const $from = sel.$from
    if ($from && $from.depth >= 1) head = $from.node(1)
    else if ($from && doc.childCount) {
      // Doc-level gap: prefer the adjacent non-flowing unit (gap-adjacency).
      const before = $from.nodeBefore
      if (before && !this.#isFlowingText(before.type.name)) return before
      const after = $from.nodeAfter
      if (after && !this.#isFlowingText(after.type.name)) return after
      // No adjacent unit (both flowing / absent) → the index-clamped child.
      const idx = Math.max(0, doc.resolve($from.pos).index(0))
      head = doc.child(Math.min(idx, doc.childCount - 1))
    }
    if (head && spanNodes.indexOf(head) >= 0) return head
    return span.length ? span[0].node : head
  }

  /**
   * Every top-level block whose extent overlaps `[from,to]`, in document order, as
   * `{node, id}` (overlap: `from < node.to && to > node.from`). A collapsed caret
   * still lands in exactly the block it sits in.
   * @param {any} doc @param {number} from @param {number} to
   * @returns {Array<{node:any,id:string|null}>}
   */
  #blocksInRange(doc, from, to) {
    const out = []
    doc.forEach((node, offset) => {
      const nodeFrom = offset
      const nodeTo = offset + node.nodeSize
      const overlaps = (from === to)
        ? (from >= nodeFrom && from <= nodeTo)
        : (from < nodeTo && to > nodeFrom)
      if (overlaps) out.push({ node, id: this.#nodeBlockId(node) })
    })
    return out
  }

  /** @param {any} node @returns {string|null} the block's durable id, or null */
  #nodeBlockId(node) {
    const id = node && node.attrs && node.attrs.id
    return id || null
  }

  /**
   * The block kind as a PLAIN string: a sieve-* node carries `attrs.kind`; a native
   * prose node is its PM type name. Null when no node owns the selection.
   * @param {any} node @returns {string|null}
   */
  #nodeBlockKind(node) {
    if (!node || !node.type) return null
    if (node.attrs && node.attrs.kind) return node.attrs.kind
    return node.type.name || null
  }

  /** @param {any} node @returns {string|null} block ref/anchor (ai-block re-chain) */
  #nodeRef(node) {
    const ref = node && node.attrs && node.attrs.ref
    return ref || null
  }

  /**
   * The friendly display label for the resolved target — ALWAYS populated. The
   * surface holds the PM `primary` node here, so RICH sieve labels
   * (getSieveBlockLabel → renderer.buildAiCtx(node).contextLabel, e.g. 'Javascript
   * Code Block') are preserved; it must not regress to a bare title-cased kind. This
   * is the ported `describeTarget`, driven by selectionType+blockKind instead of a
   * naked node.
   * @param {any} primary                    the PM node owning the selection (or null)
   * @param {'none'|'caret'|'range'|'block'} selectionType
   * @param {string|null} blockKind
   * @param {string|null} selectedText
   * @param {any} T                          truthy gate: enables the rich getSieveBlockLabel path
   * @returns {string}
   */
  #labelFor(primary, selectionType, blockKind, selectedText, T) {
    // A range, OR a node-selected proseGroup (invisible grouping → its passage), is
    // a text selection → a snippet.
    if (selectionType === 'range' ||
        (selectionType === 'block' && blockKind === 'proseGroup')) {
      return this.quoteSnippet(
        selectedText != null ? selectedText : (primary ? primary.textContent : ''))
    }
    // A whole-unit NodeSelection / caret-in-unit → the block's noun.
    if (primary && selectionType !== 'none') {
      const name = primary.type.name
      if (name === 'aiBlock' || name === 'sieve-ai-block') return 'Follow-up'
      if (name.indexOf('sieve-') === 0) {
        return (T && getSieveBlockLabel)
          ? getSieveBlockLabel(primary)
          : this.#titleCase(primary.attrs && primary.attrs.kind)
      }
      if (!this.#isFlowingText(name) && NATIVE_UNIT_LABEL[name]) return NATIVE_UNIT_LABEL[name]
    }
    return 'Document'
  }

  /** Title-case a kind for a fallback label ("smart-image" → "Smart image"). */
  #titleCase(kind) {
    if (!kind) return 'Block'
    return kind.charAt(0).toUpperCase() + kind.slice(1).replace(/-/g, ' ')
  }

  /**
   * isFlowingText: the ONE discriminator (D-r.7), by KIND STRING now. A top-level
   * block is flowing text iff it is a paragraph, heading, or proseGroup — content a
   * bare caret can't disambiguate, so it targets the whole document. EVERY other
   * top-level kind (blockquote, code, list, table, image, hr, all structured sieve-*)
   * is a discrete UNIT you target as a whole by its id.
   *
   * proseGroup counts as flowing text because it is a backend contrivance: one
   * multi-paragraph prose block rendered under a shared id, visually
   * indistinguishable from individually-minted paragraphs. A bare caret may only
   * target units the user can SEE as units.
   * @param {string|null} kind
   */
  #isFlowingText(kind) {
    return kind === 'paragraph' || kind === 'heading' || kind === 'proseGroup'
  }

  // ── Server render-backs (verbatim from the old document-event handlers) ────────

  /** @param {any} msg */
  applyServerOp(msg) {
    if (msg.type === 'insert-block') { this.#applyInsertBlock(msg); return }
    if (msg.type === 'replace-block') { this.#applyReplaceBlock(msg); return }
    if (msg.type === 'block-attrs-updated') { this.#applyBlockAttrsUpdated(msg) }
  }

  /** @param {any} msg */
  #applyInsertBlock(msg) {
    var self = this
    var ed = /** @type {any} */ (this.editorPane)
    if (!ed) return
    // Backend-authoritative prose id (B-A): the create carried a transient token and no
    // durable id; Go minted the id and echoed the token. Swap the pending node's token
    // for the authoritative id (tracked, history-EXCLUDED — never a re-insert), reconcile
    // the sync cache, and DO NOT insert (the node already exists — the user typed it).
    if (msg.token) {
      var foundPos = -1
      ed.state.doc.forEach(function (node, pos) {
        if (foundPos < 0 && node.attrs && node.attrs.token === msg.token) foundPos = pos
      })
      if (foundPos >= 0) {
        var pendingNode = ed.state.doc.nodeAt(foundPos)
        var tr = ed.state.tr.setNodeMarkup(foundPos, undefined,
          Object.assign({}, pendingNode.attrs, { id: msg.id, token: '' }))
        tr.setMeta('addToHistory', false)
        ed.view.dispatch(tr)
        this.#reconcilePendingToken(msg.token, msg.id)
      } else {
        // Deleted while the create was in flight — Go has a block we can't see. Delete it
        // by the authoritative id, then drop the stale token baseline (falsy id sentinel).
        this.#submitOps([{ type: 'delete-block', blockId: msg.id }])
        this.#reconcilePendingToken(msg.token, null)
      }
      return
    }
    var parsed = msg.attrs || {}
    var kind = msg.kind || 'code'

    // Insert position: the op's index (echoed on the message) is the document
    // position — robust for a batch (a paste slice renders many blocks in order).
    // A numeric sieveInsertPos is still used by AI-block creates (which set a raw
    // editor position before the WS round-trip). In-place transforms now use the
    // dedicated replace-block path; replaceRange is retired.
    var numericPos = this.#host.takeInsertPos()

    // Insert-if-absent: the backend creates EVERY kind through the one lifecycle and
    // render-backs uniformly — including prose, whose node the editor already holds
    // (the user typed it). "Does the editor have this node?" is the client's concern,
    // not the backend's: if a node with this id is already in the doc, the echo is
    // redundant — baseline it so the observer never re-creates it, then skip the
    // insert (a second insert would duplicate the paragraph).
    var echoedId = msg.id || parsed.id
    if (echoedId && ed.view.dom.querySelector('[data-id="' + echoedId + '"]')) {
      this.#noteServerBlock(echoedId)
      return
    }

    // Prose IS a block: render the server-created block (prose or structured) to its
    // editor node(s) through the SAME path the document load uses (id-stamped) —
    // never a hand-built node, never a sieve-<kind> assumption. The render pipeline
    // is envelope-native: type the wire message into a SieveBlock (flat payload —
    // the properties bag + id + kind) before handing it to blockToNodes.
    var insId = msg.id || parsed.id
    var blk = new SieveBlock(kind, Object.assign({}, parsed, { id: insId, kind: kind }))
    var content = this.#blockToNodes(ed, blk).map(function (n) { return n.toJSON() })
    if (!content.length) return

    if (typeof msg.index === 'number') {
      ed.commands.insertContentAt(this.#docPosForBlockIndex(ed, msg.index), content)
    } else {
      ed.commands.insertContentAt(numericPos !== null ? numericPos : ed.state.doc.content.size, content)
    }

    // A server-created block is authoritative (carries the backend id) — baseline it
    // so the observer never re-creates it (prose especially, which it otherwise owns).
    this.#noteServerBlock(msg.id || parsed.id)

    if (!parsed.source && (msg.kind === 'code' || msg.kind === 'diagram')) {
      setTimeout(function () {
        var focusEl = document.querySelector('[data-id="' + (msg.id || parsed.id) + '"] .sieve-block__edit')
        if (focusEl) /** @type {HTMLElement} */ (focusEl).focus()
      }, 50)
    } else if (msg.kind !== 'ai-block') {
      // Anything else the user just inserted (image, web-clip, card, …): return focus
      // to the editor with the caret AFTER the new block so they can keep typing. (A
      // file dialog / toolbar click leaves focus elsewhere; code/diagram focus their own
      // edit surface above; async AI answers intentionally never steal focus.)
      setTimeout(function () {
        var e2 = /** @type {any} */ (self.editorPane)
        if (!e2) return
        var doc = e2.state.doc
        var idxAfter = blockIndexAfter(doc, msg.id || parsed.id)
        if (idxAfter < 0) { e2.commands.focus(); return }
        var pos = docPosForBlockIndex(doc, idxAfter)
        e2.chain().focus().setTextSelection(Math.min(pos, e2.state.doc.content.size)).run()
      }, 60)
    }

    // Bring the new block into view. Async answer blocks (ask/explain) carry no
    // focus, so they can land below the fold and get lost; deferred so the
    // NodeView has rendered, 'nearest' so it doesn't jump when already visible.
    var blkId = msg.id || parsed.id
    if (blkId) {
      setTimeout(function () {
        var node = document.querySelector('[data-id="' + blkId + '"]')
        if (node) node.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }, 60)
    }
  }

  /**
   * In-place TRANSFORM render-back: tracked replace-by-id — swap the node
   * carrying oldId with the server's new node. insertContentAt(range, …) is
   * undoable (and the observer propagates an undo to the backend).
   * @param {any} msg
   */
  #applyReplaceBlock(msg) {
    var ed = /** @type {any} */ (this.editorPane)
    if (!ed) return
    var oldId = msg.oldId
    var newId = msg.newId || oldId
    var kind = msg.newKind || 'prose'
    var parsed = msg.attrs || {}

    var range = null
    ed.state.doc.descendants(function (node, pos) {
      if (range) return false
      if (node.attrs && node.attrs.id === oldId) { range = { from: pos, to: pos + node.nodeSize }; return false }
    })
    if (!range) return

    var blk = new SieveBlock(kind, Object.assign({}, parsed, { id: newId, kind: kind }))
    var content = this.#blockToNodes(ed, blk).map(function (n) { return n.toJSON() })
    if (!content.length) return

    ed.commands.insertContentAt(range, content) // tracked → undoable
    this.#noteServerBlock(newId)

    setTimeout(function () {
      var node = document.querySelector('[data-id="' + newId + '"]')
      if (node) node.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }, 60)
  }

  /** @param {any} msg */
  #applyBlockAttrsUpdated(msg) {
    var ed = /** @type {any} */ (this.editorPane)
    if (!ed) return
    var parsed = msg.attrs || {}

    ed.commands.command(function (commandProps) {
      var tr = commandProps.tr
      commandProps.state.doc.descendants(function (node, pos) {
        // Match any sieve-* node by id (kind is not in the WS message)
        if (node.type.name.startsWith('sieve-') && node.attrs.id === msg.id) {
          var nextAttrs = Object.assign({}, node.attrs, {
            status:          parsed.status   || node.attrs.status,
          })
          Object.keys(parsed).forEach(function (k) {
            // Safely apply keys that exist in the existing node.attrs schema mapping
            if (k !== 'id' && k !== 'status' && (k in node.attrs)) {
              nextAttrs[k] = parsed[k]
            }
          })
          try {
            tr.setNodeMarkup(pos, null, nextAttrs)
            tr.setMeta('addToHistory', false)
          } catch (err) {
            console.error('[editor] setNodeMarkup failed:', err, nextAttrs)
          }
          return false
        }
      })
      return true
    })
  }

  // ── Whole-document reload (softReloadContent's wysiwyg branch) ────────────────

  /**
   * Re-renders the whole document from the backend's authoritative block list
   * via ONE non-undoable transaction. ONLY for genuine doc loads (AI resolve /
   * restore / extract re-render) — never for an operation render-back.
   * @param {import('../../block/sieve-block.js').SieveBlock[]} blocks
   * @param {{allowEmpty?: boolean}} [opts]
   */
  reloadFromBlocks(blocks, opts) {
    const ed = this.editorPane
    if (!ed) return
    this.#renderBlocksIntoEditor(ed, blocks, opts)
  }

  // ── Render pipeline (verbatim blockToNodes / renderBlocksIntoEditor) ───────────

  /**
   * blockToNodes renders ONE SieveBlock envelope (prose or structured) to its
   * ProseMirror node(s) via the editor's live markdownit + each node's parseHTML —
   * the single place that knows how a block becomes editor nodes. Shared by the
   * whole-document load (renderBlocksIntoEditor) and the per-block render-back
   * (insert-block / replace-block), so a server-created block renders identically
   * however it arrives; every caller hands it a SieveBlock (the render pipeline is
   * envelope-native). Parsed in ISOLATION so a block the schema rejects is logged +
   * skipped, never aborting.
   * @param {any} editorPane @param {import('../../block/sieve-block.js').SieveBlock} b @returns {any[]}
   */
  #blockToNodes(editorPane, b) {
    var T = this.#T
    var mdRender = function (t) { return editorPane.storage.markdown.parser.md.render(t) }
    var PMDP = T.ProseMirrorDOMParser || T.DOMParser
    var parser = PMDP.fromSchema(editorPane.state.schema)
    var bhtml = buildBlocksHTML([b], mdRender)
    var out = []
    try {
      var tmp = document.createElement('div')
      tmp.innerHTML = (bhtml || '').trim()
      if (b.kind === 'prose') {
        // A prose block parses to its NATIVE top-level node(s); proseBlockNodes
        // stamps the block id (one node → that node; >1 → one proseGroup container).
        var produced = proseBlockNodes(parser.parse(tmp).content, b.id || '', editorPane.state.schema)
        if (!produced.length) console.error('[editor] prose block (' + (b.id || '') + ') produced no node from:\n' + (bhtml || '').trim().slice(0, 200))
        produced.forEach(function (n) { out.push(n) })
      } else {
        // Structured: take ONLY the sieve-<kind> node, ignoring stray parse output.
        var want = 'sieve-' + b.kind
        parser.parse(tmp).content.forEach(function (n) { if (n.type.name === want) out.push(n) })
        if (!out.length) console.error('[editor] block (' + b.kind + ' ' + (b.id || '') + ') produced no ' + want + ' node from:\n' + (bhtml || '').trim().slice(0, 200))
      }
    } catch (e) {
      console.error('[editor] block (' + b.kind + ' ' + (b.id || '') + ') failed to render:', e, '\n--- HTML ---\n' + bhtml)
    }
    return out
  }

  /**
   * renderBlocksIntoEditor replaces the whole document with the block list, each
   * block rendered via blockToNodes, swapped in via one non-undoable transaction.
   * opts.allowEmpty — when true, a genuinely-empty block list clears the editor
   * to one empty paragraph instead of keeping stale content. Set only by the
   * known-good reload caller (reloadFromBlocks ← softReloadContent); omit for
   * all other callers.
   * @param {any} editorPane @param {import('../../block/sieve-block.js').SieveBlock[]} blocks @param {{allowEmpty?: boolean}} [opts]
   */
  #renderBlocksIntoEditor(editorPane, blocks, opts) {
    var self = this
    var nodes = []
    ;(blocks || []).forEach(function (b) {
      self.#blockToNodes(editorPane, b).forEach(function (n) { nodes.push(n) })
    })
    var replacement = reloadReplacement(nodes, opts || {}, editorPane.state.schema)
    if (replacement === null) return // keep existing content (transient empty)
    var tr = editorPane.state.tr
    tr.replaceWith(0, editorPane.state.doc.content.size, replacement)
    tr.setMeta('addToHistory', false)
    editorPane.view.dispatch(tr)
  }

  // ── Block-sync cache (verbatim mountWysiwyg internals) ─────────────────────────

  /**
   * Serialize one top-level block to the (id, kind, content) the sync diff
   * needs (node-granular, 2026-06-19). A structured sieve block's `content` is a
   * change-SIGNATURE only (never emitted as an op): the JSON of its attrs, which
   * changes iff its persistent state does — no markdown produced. EVERY OTHER
   * top-level node is a prose block: a NATIVE TipTap node (paragraph/heading/
   * list/table/…) whose identity is its `id` attr and whose content is its CLEAN
   * markdown (native nodes never embed markers — Go re-wraps on save). No node
   * returns null now, so the observer never falls back merely on node type.
   * @param {any} ed @param {any} node
   */
  #topBlockTriple(ed, node) {
    var name = node.type.name
    if (name.indexOf('sieve-') === 0) {
      return { id: node.attrs.id || '', kind: node.attrs.kind || name, content: JSON.stringify(sieveBlockAttrs(node)) }
    }
    var content = (serializeNode(ed, node) || '').trim()
    return { id: node.attrs.id || '', kind: 'prose', content: content, token: node.attrs.token || '' }
  }

  /** @param {any} ed @returns {any[]|null} */
  #collectTopBlocks(ed) {
    var out = []
    var doc = ed.state.doc
    for (var i = 0; i < doc.childCount; i++) {
      var t = this.#topBlockTriple(ed, doc.child(i))
      if (!t) return null
      out.push(t)
    }
    return out
  }

  /**
   * Seed the sync baseline from GO's view (the server block list), NOT the
   * editor — so a block PM created client-side (e.g. the prose block an empty
   * doc createAndFills, or a split) is absent from the baseline and the first
   * sync emits a create-block for it. Seeding from the editor would hide such a
   * block from Go forever (its update-block would fail "block not found"). For a
   * loaded doc the server blocks ARE the editor blocks, so nothing spurious.
   * @param {any} editorPane @param {Array<any>|null} serverBlocks
   */
  #seedBlockCache(editorPane, serverBlocks) {
    // Structured signature is the JSON of the rendered node's attrs (topBlockTriple's
    // derivation). The SERVER block's attrs would stringify differently (key order,
    // schema defaults) and phantom-flag a change on the first diff, so read the
    // structured baseline straight off the just-rendered editor, keyed by id.
    var structuredSig = {}
    this.#collectTopBlocks(editorPane).forEach(function (t) {
      if (t.kind !== 'prose' && t.id) structuredSig[t.id] = t.content
    })
    // serverBlocks are SieveBlock envelopes (the render pipeline is envelope-native):
    // .id/.kind via getters, the prose body via proseContent (payload.content).
    var triples = (serverBlocks || []).map(function (b) {
      return {
        id: b.id,
        kind: b.kind,
        // Prose body rides in payload.content (proseContent); structured signs on
        // the attrs-hash derived from its rendered node.
        content: b.kind === 'prose' ? proseContent(b) : (structuredSig[b.id] || ''),
      }
    })
    // seedBaseline includes EVERY id'd server block (even an empty one) so the
    // first edit to a loaded block is an update-block, never a duplicate create.
    this.#blockContentCache = seedBaseline
      ? seedBaseline(triples)
      : {}
  }

  /**
   * syncDocument is the debounced domain submit: granular block-ops only.
   * There is NO whole-document fallback — every WYSIWYG edit becomes a
   * block-domain op (prose via the observer; structured via their own channels
   * + delete-block here) handed to the service pair, which owns the WS
   * enveloping (#submitOps). Markdown mode keeps its own whole-buffer
   * setRawContent path, outside here. It NEVER mutates the document — pure
   * read + submit.
   * @param {any} ed
   */
  #syncDocument(ed) {
    var curr = this.#collectTopBlocks(ed)
    if (!curr || !computeBlockSync) return
    var r = computeBlockSync(curr, this.#blockContentCache)
    this.#blockContentCache = r.next
    if (r.ops.length) this.#submitOps(r.ops)
  }

  /**
   * #submitOps — the ONE place the observer's op batch decomposes into service
   * verbs (issue #49 Phase 1; frame shapes frozen, emission order preserved:
   * every frame leaves synchronously, in sequence, on the same channel —
   * byte-identical to the retired editor enveloping):
   *
   * - create-block → DocumentService.createBlock on the EXPLICIT-INDEX path
   *   (the observer already computed document order; opts.index bypasses
   *   resolveInsertIndex, and blockId/token/aliases ride through so the op
   *   reproduces proseOp's exact wire shape).
   * - update-block → BlockService.updateAttributes (kind resolves from the
   *   service's routing index; aliases lift to the op's top level).
   * - delete-block → DocumentService.deleteBlock (kind-agnostic).
   *
   * A host without the service pair (bare test constructions) drops the batch
   * — socketless parity with the retired editor no-op sends.
   * @param {any[]} ops
   */
  #submitOps(ops) {
    var ds = this.#host.documentService
    var bs = this.#host.blockService
    if (!ds || !bs) return
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i]
      if (op.type === 'create-block') {
        ds.createBlock(this.#uuid, op.kind, op.attrs, undefined,
          { index: op.index, token: op.token, aliases: op.aliases, blockId: op.blockId })
      } else if (op.type === 'update-block') {
        bs.updateAttributes(op.blockId, op.attrs, { aliases: op.aliases })
      } else if (op.type === 'delete-block') {
        ds.deleteBlock(this.#uuid, op.blockId)
      }
    }
  }

  /**
   * Baseline a server-created block (by id) into the sync cache so the thin
   * observer sees it as already-present and never re-creates it. Derived from the
   * rendered node so its signature matches topBlockTriple exactly.
   * @param {string} id
   */
  #noteServerBlock(id) {
    var ed = /** @type {any} */ (this.editorPane)
    if (!this.#blockContentCache || !id || !ed) return
    var found = null
    ed.state.doc.forEach(function (node) {
      if (!found && node.attrs && node.attrs.id === id) found = node
    })
    if (!found) return
    var seed = seedBaseline ? seedBaseline([this.#topBlockTriple(ed, found)]) : null
    if (seed) for (var k in seed) this.#blockContentCache[k] = seed[k]
  }

  /**
   * reconcilePendingToken swaps a pending prose node's token baseline for the backend
   * id in the sync cache (a flight-edit then surfaces as update-block by the real id;
   * the token key never reads as a delete). A falsy id = the node was deleted while its
   * create was in flight → just drop the stale token key (the delete-by-real-id already
   * went over the WS; the delete loop skips tok- keys regardless, this is hygiene).
   * @param {string} token @param {string|null} id
   */
  #reconcilePendingToken(token, id) {
    if (!this.#blockContentCache) return
    if (!id) { delete this.#blockContentCache[token]; return }
    if (token in this.#blockContentCache) {
      this.#blockContentCache[id] = this.#blockContentCache[token]
      delete this.#blockContentCache[token]
    } else {
      this.#noteServerBlock(id)
    }
  }

  /**
   * docPosForBlockIndex maps a top-level BLOCK index (Go's tree position, echoed
   * on insert-block) to the editor doc position before that node — so a
   * render-back lands where Go put it, even for a batch (a paste slice).
   * Delegates to the tested docPosForBlockIndex import (base/block-position.js).
   * @param {any} editorPane @param {number} idx
   */
  #docPosForBlockIndex(editorPane, idx) {
    return docPosForBlockIndex(editorPane.state.doc, idx)
  }
}

// Expose on window for classic-script access from editor.js.
window.SieveWysiwygSurface = WysiwygSurface
