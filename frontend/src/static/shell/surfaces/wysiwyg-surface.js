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
// Normalization applied during motion (behavior-identical): the mixed
// `T.`/`window.TipTap.` reads of the vendor bundle all go through the injected
// `deps.T` (defaults to window.TipTap); the module vars the old code wrote
// (currentEditor, docUpdateTimer, docSyncFlush, blockContentCache seams) are
// #private state; `window.__tiptap` is still set/nulled on mount/unmount for
// its remaining consumers (P4 migrates them).
//
// Dual-use ES module: `export` for vitest; `window.SieveWysiwygSurface` for the
// classic-script editor.js factory.

import { AbstractSurface, SurfaceEvent } from './abstract-surface.js'

/**
 * Injected collaborators — content services commanding into this document's
 * context, plus the ONE outbound notifier. Nothing app-level: no chrome names,
 * no AI concepts. (requestSave backs the PM-internal Mod+S in editorProps
 * handleKeyDown — it must run pre-core inside ProseMirror's key routing per
 * docs/editor-interaction-contract.md, so it cannot move to the document-level
 * transitional listener the markdown surface uses.)
 * @typedef {object} WysiwygSurfaceDeps
 * @property {(ops: object[]) => void}    submitBlockOps  — block-domain ops → editor transport (the editor owns the WS enveloping)
 * @property {() => unknown}              requestSave     — save command (module flushSave)
 * @property {(event: ClipboardEvent) => boolean} onPaste — smart-paste pipeline (handleSmartPaste)
 * @property {(event: DragEvent) => boolean}      onDrop  — smart-drop pipeline (handleSmartDrop)
 * @property {() => number|null}          takeInsertPos   — read-and-clear the module sieveInsertPos capture
 * @property {(event: import('./abstract-surface.js').SurfaceEventMsg) => void} notify — outbound editor-domain events
 * @property {object}                     [T]             — TipTap vendor bundle (defaults to window.TipTap)
 */

export class WysiwygSurface extends AbstractSurface {
  /** @type {string} */
  #uuid

  /** @type {WysiwygSurfaceDeps} */
  #deps

  /** @type {any} the TipTap vendor bundle */
  #T

  /** @type {HTMLElement|null} */
  #rootEl = null

  /** @type {any} the live TipTap Editor instance */
  #editor = null

  /**
   * Per-mount block-sync cache: { [blockId]: serializedContent } as of the last
   * successful sync. The thin observer (Stage D.3) diffs against it.
   * @type {Record<string, string>|null}
   */
  #blockContentCache = null

  /** @type {ReturnType<typeof setTimeout>|null} 500ms observer debounce (formerly module docUpdateTimer) */
  #syncTimer = null

  /**
   * @param {string}             uuid
   * @param {WysiwygSurfaceDeps} deps
   */
  constructor(uuid, deps) {
    super()
    if (!uuid) throw new Error('WysiwygSurface: uuid is required')
    if (!deps) throw new Error('WysiwygSurface: deps are required')
    this.#uuid = uuid
    this.#deps = deps
    this.#T = deps.T || /** @type {any} */ (window).TipTap
  }

  /** @returns {string} */
  get mode() { return 'wysiwyg' }

  /** @returns {unknown|null} the live TipTap instance */
  get tiptap() { return this.#editor }

  // ── Mount: the TipTap island (verbatim mountWysiwyg) ───────────────────────────

  /**
   * @param {HTMLElement} rootEl
   * @param {unknown}     content — { body, blocks } from the load / enter-wysiwyg reply
   */
  mount(rootEl, content) {
    var self = this
    var T = this.#T
    var deps = this.#deps
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
    // native node's `id` attr (T.BlockId, addGlobalAttributes); minting is
    // a passive observe-time concern (D-r.4), never a doc mutation here.
    var SieveDocument = T.Node.create({ name: 'doc', topNode: true, content: '(block | sieveBlock)+' })

    var editor = new T.Editor({
      element: el,
      extensions: [
        SieveDocument,
        T.BlockId,
        // trailingNode:true — caret contract clause 1 (no dead-ends): a
        // paragraph is guaranteed after a final structured block. The earlier
        // Gapcursor-only bet failed for non-atom read-only containers
        // (web-clip/ai-block) — see docs/editor-interaction-contract.md.
        T.StarterKit.configure({ document: false, link: false, codeBlock: false, trailingNode: true, history: { depth: 10000, newGroupDelay: 500 } }),
        T.Placeholder.configure({ placeholder: function (p) { return p.editor.isEmpty ? 'Start writing…' : '' } }),
        T.BlockChrome,
        T.AiTargetDecoration,
        T.Table.configure({ resizable: false }),
        T.TableRow,
        T.TableHeader,
        T.TableCell,
        T.Search,
        // Shared keyboard policy (priority 50 — runs AFTER native keymaps like
        // list indent and table cell-nav; docs/editor-interaction-contract.md).
        // Per-renderer key handlers are forbidden; kinds declare interactionPolicy.
        T.buildInteractionPolicyExtension(T),

        T.AiBlockLegacy,
        T.Image.configure({ inline: false, allowBase64: true, HTMLAttributes: { class: 'editor-image' } }),
        T.HighlightMark,
        T.SelectionHighlight,
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
       .concat(T.ProseGroup ? [T.ProseGroup] : [])
       .concat(T.getSieveNodes()).concat([
        T.TaskList,
        T.TaskItem.configure({ nested: true }),
        T.Markdown.configure({ html: true, transformPastedText: true, link: { openOnClick: false } }),
        T.AiShortcuts.configure({
          // Fire the same events as every other surface so the editor.js handler
          // runs identical business logic (target highlight + focus + run).
          onExplain: function () { document.dispatchEvent(new CustomEvent('sieve:ai-explain')) },
          onAsk: function () { document.dispatchEvent(new CustomEvent('sieve:ai-ask')) },
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
                src = '/sieve/' + (window.__stashActiveTabUuid || uuid) + '/' + src.split('/').pop()
              }
              event.preventDefault()
              if (window._sieveCopyImageToClipboard) window._sieveCopyImageToClipboard(src)
              return true
            }

            // Range covered by the selection (a gutter block-range, a NodeSelection,
            // or a text range) — drives which blocks the loop below visits.
            var er = (T && T.getBlockSelectionRange)
              ? T.getBlockSelectionRange(view)
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
              var retarget = T.domSelectionBlockRange(domSel, er, blockDescs)
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
            var proseKind = T.getBlockKind && T.getBlockKind('prose')
            view.state.doc.forEach(function (node, offset) {
              var nodeEnd = offset + node.nodeSize
              if (nodeEnd <= er.from || offset >= er.to) return
              var dom = view.nodeDOM(offset)
              var entries
              if (String(node.type.name).indexOf('sieve-') === 0) {
                hasSieve = true
                entries = T.sieveBlockEntries(node, T.rendererFor(node.attrs.kind))
                singleSieveEntries = entries
              } else {
                entries = (proseKind && proseKind.asContentEntry && proseKind.asContentEntry(node, self.tiptap)) || []
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
              var domInBlock = T.domSelectionTextInside(domSel, dom)
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
        handlePaste: function (_view, event) { return deps.onPaste(event) },
        handleDrop: function (_view, event, slice, moved) { return deps.onDrop(event) },
        handleKeyDown: function (view, event) {
          if (event.key === 's' && window.isMod(event)) {
            event.preventDefault()
            deps.requestSave()
            return true
          }
          // Enter family routes through the interaction policy FROM HERE
          // (pre-core: TipTap's core Keymap would otherwise consume Enter in
          // code:true blocks). Returns false in every context the policy
          // does not own, so native prose/list/table Enter is untouched.
          if (event.key === 'Enter' && T.policyEnterKeydown &&
              T.policyEnterKeydown(view, event)) {
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
        deps.notify(SurfaceEvent.SELECTION_CHANGED)
      },
      onTransaction: function () {
        deps.notify(SurfaceEvent.TRANSACTION)
      },
      onUpdate: function (p) {
        if (!initialized || suppressUpdate) return
        // Stage D.3: the thin observer. We no longer serialize the whole document
        // on every keystroke — onUpdate only reports the change and (re)arms a
        // debounce. The actual diff + wire send happens once typing settles, in
        // syncDocument, which emits granular block-ops (id-less nodes are
        // skipped until minted — no whole-document fallback).
        deps.notify(SurfaceEvent.DOC_CHANGED)
        if (self.#syncTimer) clearTimeout(self.#syncTimer)
        self.#syncTimer = setTimeout(function () {
          self.#syncTimer = null
          self.#syncDocument(editor)
        }, 500)
      },
    })

    this.#editor = editor
    window.__tiptap = editor

    // Stage D.2: the block list IS the document model. When the load supplied it,
    // render the document from the blocks (prose → native node(s); structured →
    // its fence rule), bypassing the markdown `content:` seed above. We build the
    // HTML with the editor's OWN markdownit (so the fence parse rules are live)
    // and parse it through ProseMirror's DOMParser — reusing every node's
    // parseHTML, never hand-building ProseMirror JSON. suppressUpdate guards the
    // initial replace so it isn't mistaken for a user edit / doc-update.
    if (blocks && blocks.length && T.buildBlocksHTML) {
      suppressUpdate = true
      try {
        this.#renderBlocksIntoEditor(editor, blocks)
      } catch (err) {
        console.error('[editor] block render failed; keeping markdown seed', err)
      } finally {
        suppressUpdate = false
      }
    }

    // Seed the block-sync baseline from GO's block list (what the server has),
    // so a PM-created block (empty-doc fill / split) is seen as new and synced.
    this.#seedBlockCache(editor, blocks)

    // Catch focus events on inner form controls (like Sieve Code block textareas)
    // where ProseMirror's native onSelectionUpdate won't fire.
    editor.view.dom.addEventListener('focusin', function() {
      deps.notify(SurfaceEvent.FOCUS_CHANGED)
    })
  }

  /**
   * Tears down the island: kills the observer debounce, destroys the TipTap
   * editor, clears the root's children (faithful to the old toggle's
   * innerHTML='' swap) and the window.__tiptap handle.
   */
  unmount() {
    if (this.#syncTimer) { clearTimeout(this.#syncTimer); this.#syncTimer = null }
    if (this.#editor) {
      this.#editor.destroy()
      this.#editor = null
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
    const ed = this.tiptap
    if (ed) this.#syncDocument(ed)
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
    var T = this.#T
    var ed = /** @type {any} */ (this.tiptap)
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
        this.#deps.submitBlockOps([{ type: 'delete-block', blockId: msg.id }])
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
    var numericPos = this.#deps.takeInsertPos()

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
    // never a hand-built node, never a sieve-<kind> assumption.
    var blk = { id: msg.id || parsed.id, kind: kind, attrs: Object.assign({ id: msg.id || parsed.id }, parsed) }
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
        var e2 = /** @type {any} */ (self.tiptap)
        if (!e2) return
        var doc = e2.state.doc
        var idxAfter = T.blockIndexAfter(doc, msg.id || parsed.id)
        if (idxAfter < 0) { e2.commands.focus(); return }
        var pos = T.docPosForBlockIndex(doc, idxAfter)
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
    var ed = /** @type {any} */ (this.tiptap)
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

    var blk = { id: newId, kind: kind, attrs: Object.assign({ id: newId }, parsed) }
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
    var ed = /** @type {any} */ (this.tiptap)
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
   * @param {Array<object>} blocks
   * @param {{allowEmpty?: boolean}} [opts]
   */
  reloadFromBlocks(blocks, opts) {
    const ed = this.tiptap
    if (!ed) return
    this.#renderBlocksIntoEditor(ed, blocks, opts)
  }

  // ── Render pipeline (verbatim blockToNodes / renderBlocksIntoEditor) ───────────

  /**
   * blockToNodes renders ONE block (prose or structured) to its ProseMirror
   * node(s) via the editor's live markdownit + each node's parseHTML — the single
   * place that knows how a block becomes editor nodes. Shared by the whole-document
   * load (renderBlocksIntoEditor) and the per-block render-back (insert-block), so a
   * server-created block renders identically however it arrives. Parsed in
   * ISOLATION so a block the schema rejects is logged + skipped, never aborting.
   * @param {any} editor @param {any} b @returns {any[]}
   */
  #blockToNodes(editor, b) {
    var T = this.#T
    var mdRender = function (t) { return editor.storage.markdown.parser.md.render(t) }
    var PMDP = T.ProseMirrorDOMParser || T.DOMParser
    var parser = PMDP.fromSchema(editor.state.schema)
    var bhtml = T.buildBlocksHTML([b], mdRender)
    var out = []
    try {
      var tmp = document.createElement('div')
      tmp.innerHTML = (bhtml || '').trim()
      if (b.kind === 'prose') {
        // A prose block parses to its NATIVE top-level node(s); proseBlockNodes
        // stamps the block id (one node → that node; >1 → one proseGroup container).
        var produced = T.proseBlockNodes(parser.parse(tmp).content, b.id || '', editor.state.schema)
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
   * @param {any} editor @param {Array<object>} blocks @param {{allowEmpty?: boolean}} [opts]
   */
  #renderBlocksIntoEditor(editor, blocks, opts) {
    var self = this
    var nodes = []
    ;(blocks || []).forEach(function (b) {
      self.#blockToNodes(editor, b).forEach(function (n) { nodes.push(n) })
    })
    var replacement = this.#T.reloadReplacement(nodes, opts || {}, editor.state.schema)
    if (replacement === null) return // keep existing content (transient empty)
    var tr = editor.state.tr
    tr.replaceWith(0, editor.state.doc.content.size, replacement)
    tr.setMeta('addToHistory', false)
    editor.view.dispatch(tr)
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
    var T = this.#T
    var name = node.type.name
    if (name.indexOf('sieve-') === 0) {
      return { id: node.attrs.id || '', kind: node.attrs.kind || name, content: JSON.stringify(T.sieveBlockAttrs(node)) }
    }
    var content = (T.serializeNode(ed, node) || '').trim()
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
   * @param {any} editor @param {Array<any>|null} serverBlocks
   */
  #seedBlockCache(editor, serverBlocks) {
    var T = this.#T
    // Structured signature is the JSON of the rendered node's attrs (topBlockTriple's
    // derivation). The SERVER block's attrs would stringify differently (key order,
    // schema defaults) and phantom-flag a change on the first diff, so read the
    // structured baseline straight off the just-rendered editor, keyed by id.
    var structuredSig = {}
    this.#collectTopBlocks(editor).forEach(function (t) {
      if (t.kind !== 'prose' && t.id) structuredSig[t.id] = t.content
    })
    var triples = (serverBlocks || []).map(function (b) {
      return {
        id: b.id,
        kind: b.kind,
        // Prose body rides in attrs.content (proseContent); structured signs on
        // the attrs-hash derived from its rendered node.
        content: b.kind === 'prose' ? T.proseContent(b) : (structuredSig[b.id] || ''),
      }
    })
    // seedBaseline includes EVERY id'd server block (even an empty one) so the
    // first edit to a loaded block is an update-block, never a duplicate create.
    this.#blockContentCache = T.seedBaseline
      ? T.seedBaseline(triples)
      : {}
  }

  /**
   * syncDocument is the debounced domain submit: granular block-ops only.
   * There is NO whole-document fallback — every WYSIWYG edit becomes a
   * block-domain op (prose via the observer; structured via their own channels
   * + delete-block here) handed to the editor, which owns the WS enveloping.
   * Markdown mode keeps its own whole-buffer updateText path, outside here. It
   * NEVER mutates the document — pure read + submit.
   * @param {any} ed
   */
  #syncDocument(ed) {
    var curr = this.#collectTopBlocks(ed)
    if (!curr || !this.#T.computeBlockSync) return
    var r = this.#T.computeBlockSync(curr, this.#blockContentCache)
    this.#blockContentCache = r.next
    if (r.ops.length) this.#deps.submitBlockOps(r.ops)
  }

  /**
   * Baseline a server-created block (by id) into the sync cache so the thin
   * observer sees it as already-present and never re-creates it. Derived from the
   * rendered node so its signature matches topBlockTriple exactly.
   * @param {string} id
   */
  #noteServerBlock(id) {
    var T = this.#T
    var ed = /** @type {any} */ (this.tiptap)
    if (!this.#blockContentCache || !id || !ed) return
    var found = null
    ed.state.doc.forEach(function (node) {
      if (!found && node.attrs && node.attrs.id === id) found = node
    })
    if (!found) return
    var seed = T.seedBaseline ? T.seedBaseline([this.#topBlockTriple(ed, found)]) : null
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
   * Delegates to the tested T.docPosForBlockIndex (block-position.js).
   * @param {any} editor @param {number} idx
   */
  #docPosForBlockIndex(editor, idx) {
    return this.#T.docPosForBlockIndex(editor.state.doc, idx)
  }
}

// Expose on window for classic-script access from editor.js.
window.SieveWysiwygSurface = WysiwygSurface
