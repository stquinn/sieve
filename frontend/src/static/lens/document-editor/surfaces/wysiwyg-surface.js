// @ts-check
// The TipTap WYSIWYG input surface: the TipTap island, the block-to-node render
// pipeline, and the placement of whatever the container tells it changed.
//
// INBOUND IS ONE CUE. The surface does not receive server ops; it is told the
// container changed and re-reads the blocks it names from the follower model.
//
// UNDO HISTORY IS SACRED (CLAUDE.md). An arrival or replacement lands as a
// TRACKED transaction; a change nobody in this editor made — attrs, a departure,
// a reorder — is addToHistory:false. Prose the editor already holds is skipped.
// A whole repaint is only ever used for a LOAD, never for a change.

import { AbstractSurface, SurfaceEvent } from './abstract-surface.js'
import { EditorMode } from '../editor-mode.js'
import { ToolbarButton, ButtonGroup } from '../toolbar-button.js'
import { T } from './tiptap-vendor.js'
import { BlockId } from './prose-block.js'
import { ProseGroup, proseBlockNodes } from './prose-group.js'
import { copyImageToClipboard } from '../../../ui/copy-image.js'
import { BlockChrome, getBlockSelectionRange } from '../block-chrome.js'
import { AiTargetDecoration } from './ai-target-decoration.js'
import { MentionDecorations } from './mention-decoration.js'
import { CommandVerbDecorations } from './command-verb-decoration.js'
import { SpellDecorations, SPELL_FEATURE } from './spell-decoration.js'
import { FindDecorations, FIND_FEATURE } from './find-decoration.js'
import { FlatText } from './flat-text.js'
import { VerticalScroll } from './vertical-scroll.js'
import { SelectionHighlight, HighlightMark, AiShortcuts } from '../../extensions.js'
import { policyEnterKeydown, buildInteractionPolicyExtension } from '../interaction-policy.js'
import { TriggerPopover } from '../../../shell/trigger-popover.js'
import {
  ActionMacro, BlockInsertProvider, MentionProvider, SlashCommandProvider,
} from '../../../shell/trigger-providers.js'
import { ProseMirrorHost, BlockMakingProseMirrorHost, CaretPlacement } from '../../../shell/trigger-host.js'
import {
  getSieveNodes, getSieveBlockLabel, serializeNode, sieveBlockAttrs,
  sieveBlockEntries, rendererFor,
} from './sieve-block-extension.js'
import { BlockSelection } from '../block-selection.js'
import { getBlockKind, isNativeProseNodeName } from '../../../renderers/block-kinds.js'
import { SieveBlock } from '../../../contract/sieve-block.js'
import { LensCapability } from '../../../contract/lens-capabilities.js'
import { buildBlocksHTML, proseContent } from './block-render.js'
import { seedBaseline, computeBlockSync, computeOrderOp } from '../block-sync.js'
import { docPosForBlockIndex, blockIndexAfter } from './block-position.js'
import { reloadReplacement } from './render-empty.js'
import { caretInRawTextBlock } from '../paste-context.js'
import { CaretTriggerPort } from './caret-trigger-port.js'
import { resolveImageSrc, storeFileSrc, storeFileRef } from '../../../renderers/asset-urls.js'

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

// The StarterKit `link` configuration. A link is ORDINARY MARKDOWN, not a Sieve
// block, so the `link` MARK must exist in the schema: without it PM drops <a> on
// parse and the href is destroyed on the first load. Every flag is load-bearing:
//   openOnClick:false — in a Wails webview an anchor that navigates replaces the
//     running application. Opening is Mod+Click, owned app-globally by
//     shell/workspace.js's document capture listener.
//   linkOnPaste:false / autolink:false — GO owns paste, and TipTap must not race
//     it by minting its own marks from pasted or typed text.
//   HTMLAttributes — seeds the MARK's attribute defaults, so nulling target/rel
//     drops the default target="_blank": a new-window request is
//     meaningless-to-hazardous in a webview. There is deliberately no `title`
//     hint, because `title` is a genuine Link mark ATTRIBUTE and a value set
//     here is overwritten by the mark's own null on every render.
//   protocols — the Link mark validates hrefs against an allow-list on parse and
//     drops the mark on a miss, so a sieve:// address (a reference element in a
//     projected answer, or one authored in prose) must be registered or it
//     degrades to bare text.
// Exported so the round-trip test pins the SHIPPING config, not a copy.
export const LINK_OPTIONS = Object.freeze({
  openOnClick: false,
  linkOnPaste: false,
  autolink: false,
  protocols: Object.freeze(['sieve']),
  HTMLAttributes: Object.freeze({ class: 'prose-link', target: null, rel: null }),
})

const NATIVE_UNIT_LABEL = Object.freeze({
  blockquote: 'Quote', codeBlock: 'Code Block',
  bulletList: 'List', orderedList: 'List', taskList: 'Task List',
  table: 'Table', image: 'Image', horizontalRule: 'Divider',
})

/**
 * @typedef {import('../../abstract-editor.js').AbstractEditor} AbstractEditor
 */

export class WysiwygSurface extends AbstractSurface {
  /** @type {string} */
  #uuid

  /** @type {AbstractEditor} the parent editor, whose public API this calls
   *  directly. Block-domain intents leave through its `provider`. */
  #host

  /** @type {any} the TipTap vendor bundle */
  #T

  /** @type {HTMLElement|null} */
  #rootEl = null

  /** @type {any} the live TipTap Editor instance */
  #editorPane = null

  /** @type {MentionDecorations|null} this mount's `@Title` marks — one instance
   *  per surface, so two live editors never address each other's state */
  #mentions = null

  /** @type {CommandVerbDecorations|null} this mount's `/verb` mark, one instance
   *  per surface for the same reason */
  #commandVerb = null

  /** @type {SpellDecorations|null} this mount's spelling squiggles, one instance
   *  per surface for the same reason */
  #spell = null

  /** @type {FindDecorations|null} this mount's find highlights, one instance per
   *  surface for the same reason */
  #find = null

  /** @type {Record<string, string>|null} per-mount block-sync cache
   *  ({ [blockId]: serializedContent }) the thin observer diffs against */
  #blockContentCache = null

  /** @type {string[]|null} per-mount block-ORDER baseline. Separate from
   *  #blockContentCache because a block's signature is deliberately
   *  positionless — order is its own fact. */
  #blockOrderCache = null

  /** @type {ReturnType<typeof setTimeout>|null} 500ms observer debounce */
  #syncTimer = null

  /** @type {boolean} whether this surface has painted yet. The FIRST cue after a
   *  mount names the whole container and has no undo history to protect, so it
   *  paints everything; every later cue is a delta. */
  #painted = false

  /** @type {boolean} suppresses the observer while the FRAMEWORK writes the
   *  server's own truth into the doc. Without it a load reports as a user edit:
   *  the document goes dirty on open and syncs back what it was given. */
  #suppressUpdate = false

  /** @type {(() => void)|null} the document-level `selectionchange` handler.
   *  Read-only-region highlights do NOT fire PM's onSelectionUpdate, so the model
   *  would never hear them. Stored so unmount removes it. */
  #onDocSelectionChange = null

  /** @type {HTMLElement|null} the scrollable ancestor #htmx-editor, NOT this
   *  surface's own root — #tiptap-mount is a flex child with no overflow. */
  #scroller = null

  /** @type {(() => void)|null} the scroller's debounced 'scroll' handler — stored so unmount removes it */
  #onScroll = null

  /** @type {ReturnType<typeof setTimeout>|null} scroll-report debounce */
  #scrollTimer = null

  /** @type {TriggerPopover|null} the `@` picker hosted in this document. Null
   *  when the editor was built without a MentionService: the picker is an
   *  affordance, never a requirement to edit. */
  #triggerPicker = null

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
   * @override
   * @returns {{ chars: number, lines: number, blockCount: number }}
   */
  stats() {
    const ed = this.#editorPane
    const text = (ed && ed.state && ed.state.doc && ed.state.doc.textContent) || ''
    const lines = text === '' ? 0 : text.split('\n').length
    const blockCount = (ed && ed.state && ed.state.doc) ? ed.state.doc.childCount : lines
    return { chars: text.length, lines, blockCount }
  }

  /**
   * @override — where the reader stands among the matches this surface DRAWS.
   * The matches are the host's: they arrive as find marks and resolve against
   * what is on screen, so this counts what a reader can actually see.
   * @returns {{current:number,total:number}}
   */
  findPosition() {
    const ed = /** @type {any} */ (this.editorPane)
    if (!ed || !ed.state || !this.#find) return { current: 0, total: 0 }
    return this.#find.position(ed.state)
  }

  /** @override @param {number} delta +1 for the next match, -1 for the previous
   *  @returns {{current:number,total:number}} */
  findStep(delta) {
    const ed = /** @type {any} */ (this.editorPane)
    if (!ed || !ed.view || !this.#find) return { current: 0, total: 0 }
    return this.#find.step(ed.view, delta)
  }

  /** @override — the match the reader is standing on, as the anchor a replace is
   *  spent through, or null when there is none.
   *  @returns {Record<string, any>|null} */
  currentFindMark() {
    const ed = /** @type {any} */ (this.editorPane)
    if (!ed || !ed.state || !this.#find) return null
    return this.#find.current(ed.state)
  }

  /**
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

  /**
   * @param {HTMLElement} rootEl
   * @param {unknown}     content — { body, blocks } from the load / enter-wysiwyg reply
   */
  mount(rootEl, content) {
    var self = this
    var T = this.#T
    var uuid = this.#uuid
    var el = rootEl
    var initialized = false
    this.#rootEl = rootEl
    this.#painted = false
    var mentions = new MentionDecorations(T)
    this.#mentions = mentions
    var commandVerb = new CommandVerbDecorations(T)
    this.#commandVerb = commandVerb
    var spell = new SpellDecorations(T)
    this.#spell = spell
    var find = new FindDecorations(T)
    this.#find = find

    // The doc top level holds NATIVE block nodes and structured sieve blocks as
    // siblings: a prose block IS one native top-level node, not a custom
    // container, and PM owns node creation/splitting/merging natively. Identity
    // rides on each native node's `id` attr.
    var SieveDocument = T.Node.create({ name: 'doc', topNode: true, content: '(block | sieveBlock)+' })

    var editorPane = new T.Editor({
      element: el,
      extensions: [
        SieveDocument,
        BlockId,
        // trailingNode:true — caret contract clause 1 (no dead-ends). A
        // Gapcursor-only bet fails for non-atom read-only containers.
        T.StarterKit.configure({ document: false, link: LINK_OPTIONS, codeBlock: false, trailingNode: true, history: { depth: 10000, newGroupDelay: 500 } }),
        T.Placeholder.configure({ placeholder: function (p) { return p.editor.isEmpty ? self.#host.placeholder : '' } }),
        BlockChrome,
        AiTargetDecoration,
        mentions.extension,
        commandVerb.extension,
        spell.extension,
        find.extension,
        T.Table.configure({ resizable: false }),
        T.TableRow,
        T.TableHeader,
        T.TableCell,
        // Priority 50, so it runs AFTER native keymaps like list indent and
        // table cell-nav. Per-renderer key handlers are forbidden.
        buildInteractionPolicyExtension(T),

    // An ordinary markdown image may name a file by its path within the store.
    // The browser would resolve that against the app shell, so the src is pointed
    // at the store's route on the way OUT and read back on the way IN. Both halves
    // are attribute-level on purpose: the node's attrs — what tiptap-markdown
    // serialises — keep the path the document was written with.
        T.Image.extend({
          addAttributes: function () {
            var parent = this.parent ? this.parent() : {}
            return Object.assign({}, parent, {
              src: Object.assign({}, parent.src, {
                parseHTML: function (el) { return storeFileRef(el.getAttribute('src')) },
                renderHTML: function (attrs) { return attrs.src ? { src: storeFileSrc(attrs.src) } : {} },
              }),
            })
          },
        }).configure({ inline: false, allowBase64: true, HTMLAttributes: { class: 'editor-image' } }),
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
        // No `link` option: tiptap-markdown has none, so one would be inert.
        // `linkify` stays false so a bare URL is NOT silently turned into a link
        // on load — Go decides that.
        T.Markdown.configure({ html: true, transformPastedText: true }),
        AiShortcuts.configure({
          // ASK (Mod+Shift+A) is owned by the Ask panel's document listener.
          onExplain: function () { document.dispatchEvent(new CustomEvent('sieve:ai-explain')) },
        }),
      ]),
      // Seed one empty native paragraph. renderBlocksIntoEditor replaces it for a
      // non-empty doc; an empty doc keeps this typeable paragraph.
      content: '<p></p>',
      editorProps: {
        attributes: { spellcheck: 'false' },
        handleDOMEvents: {
          copy: function(view, event) {
            // Copy is PM's. This handler steps in only for what PM cannot
            // express: a smart-image bitmap, and a WHOLE-block copy, which adds
            // sieve/slice + sieve/<kind> so smart paste can rebuild the kind.
            var sel = view.state.selection

            // (1) Smart-image bitmap.
            if (sel && sel.node && sel.node.type.name === 'sieve-smart-image') {
              if (!sel.node.attrs.src) return false
              event.preventDefault()
              copyImageToClipboard(resolveImageSrc(sel.node.attrs.src, uuid))
              return true
            }

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

            var selText = function (nodeFrom, nodeEnd) {
              var a = Math.max(er.from, nodeFrom), b = Math.min(er.to, nodeEnd)
              return b > a ? view.state.doc.textBetween(a, b, '\n') : ''
            }
            var escHtml = function (s) {
              return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            }
            // sieve/slice + sieve/<kind> always carry the WHOLE block; only the
            // text views follow the selection.
            var partial = function (nodeFrom, nodeEnd) {
              return er.to > er.from && (er.from > nodeFrom || er.to < nodeEnd)
            }

            // A block's custom region holds text PM does not own, so a highlight
            // there leaves PM's selection a whole-block NodeSelection — without
            // this the rich copy below would grab the ENTIRE block.
            var domSel = (typeof window !== 'undefined' && window.getSelection) ? window.getSelection() : null
            var domSelHtml = ''
            if (domSel && !domSel.isCollapsed && domSel.toString().trim()) {
              try {
                var frag = document.createElement('div')
                for (var dri = 0; dri < domSel.rangeCount; dri++) frag.appendChild(domSel.getRangeAt(dri).cloneContents())
                domSelHtml = frag.innerHTML
              } catch (e) {}

              // Re-target `er` when the highlight lives in a READ-ONLY region PM
              // cannot track: PM's selection stays on whatever block last held
              // the caret, so the loop below would copy the WRONG block.
              var blockDescs = []
              view.state.doc.forEach(function (node, offset) {
                if (String(node.type.name).indexOf('sieve-') === 0) {
                  blockDescs.push({ from: offset, to: offset + node.nodeSize, dom: view.nodeDOM(offset) })
                }
              })
              var retarget = BlockSelection.blockRange(domSel, er, blockDescs)
              if (retarget) {
                er = { from: retarget.from, to: retarget.to, active: true, isBlockRange: false, isNodeSelection: false }
              }
            }

            var sliceItems = []
            var plainParts = []
            var htmlParts = []
            var hasSieve = false
            var singleSieveEntries = null  // the framework ContentEntry array, if exactly one sieve block

            // sieve/slice is [][]ContentEntry, reconstructed server-side. Each
            // block contributes its FULL view set.
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
              // A DOM highlight inside this block's custom region: the text
              // views follow it even though PM sees the whole block selected.
              var domInBlock = BlockSelection.textInside(domSel, dom)
              if (domInBlock) {
                plainParts.push(domInBlock)
                htmlParts.push(domSelHtml || escHtml(domInBlock))
              } else if (partial(offset, nodeEnd)) {
                plainParts.push(selText(offset, nodeEnd))
                htmlParts.push(escHtml(selText(offset, nodeEnd)))
              } else {
                plainParts.push(pick('text/plain') || node.textContent || (dom ? dom.innerText : ''))
                htmlParts.push(pick('text/html') || blockHTML(dom))
              }
            })

            if (!hasSieve) return false   // pure prose → native PM copy

            // Every sieve-involving copy is served HERE: a slice inside a
            // `defining`/`code` block re-wraps the WHOLE node, so native copy
            // takes the entire block.
            event.preventDefault()
            event.clipboardData.setData('text/plain', plainParts.filter(Boolean).join('\n\n'))
            event.clipboardData.setData('text/html', htmlParts.filter(Boolean).join('\n'))
            event.clipboardData.setData('sieve/slice', JSON.stringify(sliceItems))
            // Single sieve block: expose every mime in its ContentEntry array
            // too, so a cross-context paste hits the same backend matchers.
            if (sliceItems.length === 1 && sliceItems[0]._type === 'sieve' && singleSieveEntries) {
              singleSieveEntries.forEach(function (en) { event.clipboardData.setData(en.mimeType, en.content) })
            }
            return true
          },
          // There is deliberately NO `click` handler for Mod+Click. Link
          // activation is APP-GLOBAL: shell/workspace.js's document-level CAPTURE
          // listener runs before anything on `view.dom` and calls
          // stopPropagation, so a PM-level handler here could never fire.
        },
        handlePaste: function (_view, event) { return self.#handleSmartPaste(event) },
        handleDrop: function (_view, event, slice, moved) { return self.#handleSmartDrop(event, slice, moved) },
        handleKeyDown: function (view, event) {
          // THE MOUNT'S OWN CLAIMS, ahead of everything: pre-core here, so a
          // claimed Enter is settled before the interaction policy and before
          // TipTap's core keymap. The picker still wins over both — it listens
          // in the capture phase on this same element.
          if (self.#host.claimKey(event)) {
            event.preventDefault()
            return true
          }
          if (event.key === 's' && window.isMod(event)) {
            event.preventDefault()
            self.#host.flushSave()
            return true
          }
          // Enter routes through the interaction policy FROM HERE, pre-core,
          // because TipTap's core Keymap would otherwise consume Enter in
          // code:true blocks.
          if (event.key === 'Enter' && policyEnterKeydown &&
              policyEnterKeydown(view, event, self.#host)) {
            return true
          }
          // Tab/Shift+Tab belong to the interaction-policy extension — never
          // handle them here: editorProps runs BEFORE extension keymaps and would
          // shadow list indent and table cell navigation.
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
        if (!initialized || self.#suppressUpdate) return
        // A body projection IS a real doc change, but it is the framework
        // writing the server's own markdown into contentDOM, so it reports as
        // DOC_PROJECTED and refreshes measurements without dirtying.
        var tr = p && p.transaction
        var projected = !!(tr && tr.getMeta && tr.getMeta('sieve-md-sync'))
        // The thin observer only reports the change and (re)arms a debounce; the
        // diff and wire send happen once typing settles, in syncDocument.
        self.#host.onSurfaceEvent(projected ? SurfaceEvent.DOC_PROJECTED : SurfaceEvent.DOC_CHANGED)
        if (self.#syncTimer) clearTimeout(self.#syncTimer)
        self.#syncTimer = setTimeout(function () {
          self.#syncTimer = null
          self.#syncDocument(editorPane)
        }, 500)
      },
    })

    this.#editorPane = editorPane
    // Stamp the parent Editor onto the pane, so a block capability can reach the
    // Editor's PUBLIC API — never the backend, never a window global.
    editorPane.sieveHost = this.#host
    // The mounted container's PROVIDER rides the same stamp, and is the whole of
    // what a renderer can reach outward.
    editorPane.blockProvider = this.#host.provider || null
    // The global names THE DOCUMENT pane (X-C debt: block-chrome and the app
    // menu read it). A mount that holds no blocks is not a document, so it
    // leaves the pointer where it is rather than aiming the menu at a draft.
    if (this.#claimsDocumentGlobals()) window.__tiptap = editorPane

    // The document is NOT painted here: the surface mounts holding the schema's
    // empty paragraph, and the container's bootstrap cue paints it — the same
    // read-and-place path every later change takes.
    this.#seedBlockCache(editorPane, [])

    // Inner form controls, where PM's native onSelectionUpdate will not fire.
    editorPane.view.dom.addEventListener('focusin', function() {
      self.#host.onSurfaceEvent(SurfaceEvent.FOCUS_CHANGED)
    })

    // A highlight inside a READ-ONLY region does not fire onSelectionUpdate, so
    // feed the model through the SAME selection-changed path.
    this.#onDocSelectionChange = function () { self.#host.onSurfaceEvent(SurfaceEvent.SELECTION_CHANGED) }
    document.addEventListener('selectionchange', this.#onDocSelectionChange)

    // #htmx-editor is the PERSISTENT scroll ancestor; rootEl never scrolls
    // itself. Found by ANCESTRY, so a surface mounted elsewhere on the page
    // reports no scroll rather than another mount's. Absent in a bare mount,
    // where the surface simply never reports.
    this.#scroller = rootEl.closest ? rootEl.closest('#htmx-editor') : null
    if (this.#scroller) {
      this.#onScroll = function () {
        if (self.#scrollTimer) clearTimeout(self.#scrollTimer)
        self.#scrollTimer = setTimeout(function () {
          self.#scrollTimer = null
          self.#host.onSurfaceEvent(SurfaceEvent.SCROLL_CHANGED)
        }, 300)
      }
      this.#scroller.addEventListener('scroll', this.#onScroll, { passive: true })
    }

    this.#mountTriggerPicker()
  }

  unmount() {
    this.#painted = false
    // Before the view dies: the picker's subscriptions are ON it, and its popover
    // lives on document.body where an orphan would survive the remount.
    if (this.#triggerPicker) { this.#triggerPicker.destroy(); this.#triggerPicker = null }
    if (this.#syncTimer) { clearTimeout(this.#syncTimer); this.#syncTimer = null }
    if (this.#onDocSelectionChange) {
      document.removeEventListener('selectionchange', this.#onDocSelectionChange)
      this.#onDocSelectionChange = null
    }
    if (this.#scrollTimer) { clearTimeout(this.#scrollTimer); this.#scrollTimer = null }
    if (this.#scroller && this.#onScroll) this.#scroller.removeEventListener('scroll', this.#onScroll)
    this.#scroller = null
    this.#onScroll = null
    if (this.#editorPane) {
      this.#editorPane.destroy()
      this.#editorPane = null
    }
    if (this.#rootEl) this.#rootEl.innerHTML = ''
    this.#rootEl = null
    this.#mentions = null
    this.#commandVerb = null
    this.#spell = null
    this.#find = null
    this.#blockContentCache = null
    if (this.#claimsDocumentGlobals()) window.__tiptap = null
  }

  /** Whether this mount is the page's DOCUMENT surface, and so the owner of the
   *  globals the chrome reads. A lens that mints no blocks is not.
   *  @returns {boolean} */
  #claimsDocumentGlobals() {
    const host = /** @type {any} */ (this.#host)
    const caps = typeof host.getCapabilities === 'function' ? host.getCapabilities() : null
    return !caps || !!caps[LensCapability.BLOCKS]
  }

  /**
   * @override — the doc's text blocks joined by newlines, in document order,
   * with a hard break reading as a newline of its own. NESTED blocks included: a
   * list item is text someone wrote, and a token in one is as real as a token in
   * a paragraph.
   * @returns {string}
   */
  plainText() {
    const ed = /** @type {any} */ (this.editorPane)
    return ed ? new FlatText(ed.state.doc).text : ''
  }

  /**
   * @override — cuts `[start, end)` out of `plainText()`. Applied back to front
   * so each deletion leaves the earlier positions valid, and as ONE tracked
   * transaction, because removing a mention is one undoable step.
   * @param {number} start @param {number} end
   */
  deletePlainRange(start, end) {
    const ed = /** @type {any} */ (this.editorPane)
    if (!ed || end <= start) return
    const tr = ed.state.tr
    for (const range of new FlatText(ed.state.doc).ranges(start, end).reverse()) {
      tr.delete(range.from, range.to)
    }
    if (tr.docChanged) ed.view.dispatch(tr)
  }

  /**
   * @override — marks every `@Title` token of these titles in the surface. A
   * meta-only transaction, so the draft is neither dirtied nor made undoable by
   * a change to what it has attached.
   * @param {ReadonlyArray<string|undefined>} titles
   */
  setMentionTitles(titles) {
    const ed = /** @type {any} */ (this.editorPane)
    if (ed && ed.view && this.#mentions) this.#mentions.apply(ed.view, titles)
  }

  /**
   * @override — marks the leading `/verb` token, where the draft opens with the
   * one the host names. A meta-only transaction, for the same reason.
   * @param {string|null} verb
   */
  setCommandVerb(verb) {
    const ed = /** @type {any} */ (this.editorPane)
    if (ed && ed.view && this.#commandVerb) this.#commandVerb.apply(ed.view, verb)
  }

  /**
   * @override — draws one block's marks for the one feature this surface has a
   * decoration set for, replacing what was drawn for that pair; any other
   * producer's findings are dropped, because nothing here knows how to draw
   * them. A meta-only transaction, for the reason `setMentionTitles` is: what a
   * producer found about a block is not an edit to it.
   * @param {string} feature
   * @param {string} blockId
   * @param {ReadonlyArray<import('../../../contract/container-update-listener.js').SieveTextMark>} marks
   */
  setTextMarks(feature, blockId, marks) {
    const ed = /** @type {any} */ (this.editorPane)
    if (!ed || !ed.view) return
    if (feature === SPELL_FEATURE && this.#spell) this.#spell.apply(ed.view, blockId, marks)
    if (feature === FIND_FEATURE && this.#find) this.#find.apply(ed.view, blockId, marks)
  }

  /**
   * @override — the title of the `@Title` token at a DOCUMENT position, read off
   * the marks this surface is drawing.
   * @param {number} pos
   * @returns {string|null}
   */
  mentionTitleAt(pos) {
    const ed = /** @type {any} */ (this.editorPane)
    if (!ed || !ed.view || !this.#mentions) return null
    return this.#mentions.titleAt(ed.view, pos)
  }

  /** @override — hands the caret back to ProseMirror, where it was. */
  focusEditor() {
    const ed = /** @type {any} */ (this.editorPane)
    if (ed && ed.commands) ed.commands.focus()
  }

  /**
   * @override — the shell scroller's current position, or null when absent.
   * @returns {number|null}
   */
  feedScroll() { return this.#scroller ? this.#scroller.scrollTop : null }

  /**
   * @override — restores (or parks) the shell scroller. Deferred two animation
   * frames: the content is rendered synchronously BEFORE this runs but not yet
   * laid out, and an immediate scrollTop clamps to 0 against a short scrollHeight.
   * null/undefined means nothing to restore; 0 is a real park-at-top value.
   * @param {number|null|undefined} value
   */
  applyScroll(value) {
    if (value == null) return
    const scroller = this.#scroller
    if (!scroller) return
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { scroller.scrollTop = value })
    })
  }

  /** Immediate flush of the pending debounced block-sync. Idle: no-op. */
  flushPending() {
    if (!this.#syncTimer) return
    clearTimeout(this.#syncTimer)
    this.#syncTimer = null
    const ed = this.editorPane
    if (ed) this.#syncDocument(ed)
  }

  /**
   * This surface's own macros: the PM-NATIVE presets, whose acceptance is a
   * command against the live pane rather than a create on the server. Each
   * inserts markdown-representable flow, so each requires only `markdown` of the
   * mount it lands in. The declaration is CLASS-LEVEL and the icon is named
   * rather than resolved, so nothing here depends on when a mount happens.
   * @type {ReadonlyArray<{label: string, name: string, description: string, icon: string, requires: string, run: (pane: any, arg?: string) => void}>}
   */
  static #PRESETS = Object.freeze([Object.freeze({
    label: 'Table',
    name: 'table',
    description: '3×3 with a header row',
    icon: 'table',
    requires: LensCapability.MARKDOWN,
    run: (/** @type {any} */ pane) => { pane.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  }), Object.freeze({
    label: 'Quote',
    name: 'blockquote',
    description: 'An indented quotation',
    icon: 'blockquote',
    requires: LensCapability.MARKDOWN,
    run: (/** @type {any} */ pane) => { pane.chain().focus().toggleBlockquote().run() },
  }), Object.freeze({
    label: 'Divider',
    name: 'hr',
    description: 'A horizontal rule',
    icon: 'horizontalRule',
    requires: LensCapability.MARKDOWN,
    run: (/** @type {any} */ pane) => { pane.chain().focus().setHorizontalRule().run() },
  }), Object.freeze({
    label: 'Fence',
    name: 'fence',
    description: 'A fenced code block — :lang tags the language, e.g. fence:go',
    icon: 'code',
    requires: LensCapability.MARKDOWN,
    // The trigger's argument tail (`go` from `{fence:go`) IS the language,
    // passed through verbatim: nothing here validates or guesses it, the same
    // rule harvest already applies to a hand-typed ```go fence.
    run: (/** @type {any} */ pane, /** @type {string|undefined} */ arg) => {
      const language = arg && arg.trim() ? arg.trim() : undefined
      pane.chain().focus().setCodeBlock(language ? { language } : undefined).run()
    },
  })])

  /**
   * The `{` picker's entries for ONE mount: everything the host's catalog offers,
   * then this surface's presets bound to `pane`, keeping only what the mounted
   * lens supports.
   *
   * ONE RULE FOR BOTH HALVES. A catalog entry and a preset alike name the
   * capability they require, and the lens's published spec answers — so the same
   * catalog serves every mount and no entry ever names one.
   *
   * COMPOSING IS NOT REGISTERING. The presets are read afresh and minted here, so
   * a second mount produces a second list rather than a longer one.
   * @param {{list: () => import('../../../shell/trigger-providers.js').Macro[]}|null} catalog
   * @param {any} pane  the live TipTap editor a preset acts on
   * @param {Readonly<Record<string, boolean>>} caps  the mounted lens's published capabilities
   * @returns {import('../../../shell/trigger-providers.js').Macro[]}
   */
  static macrosFor(catalog, pane, caps) {
    const icons = /** @type {any} */ (window).SieveIcons || {}
    return (catalog ? catalog.list() : []).concat(WysiwygSurface.#PRESETS.map((preset) => new ActionMacro({
      label: preset.label,
      name: preset.name,
      description: preset.description,
      icon: icons[preset.icon] || '',
      requires: preset.requires,
      action: (/** @type {string|undefined} */ arg) => preset.run(pane, arg),
    }))).filter((macro) => !!caps[macro.requires])
  }

  /**
   * Wires the picker over the live view, with the triggers THIS MOUNT answers
   * to. Each optional service is registered only when the host carries it: a
   * missing OPTIONAL service is an affordance the mount lacks, never a mount
   * failure.
   *
   *   `{` — run a macro: insert a block of a named kind, or drive a capability
   *         the host already has. Always registered: the catalog answers
   *         locally, so it needs no service. WHICH entries it offers is the
   *         lens's published capabilities, applied in macrosFor.
   *   `@` — mention a document, which in a block-capable mount becomes a
   *         reference block. Needs a MentionService.
   *   `/` — run a slash command against what is being written. Needs a
   *         CommandService, and fires only in the container's FIRST block: a
   *         command OPENS a message rather than punctuating one. A document
   *         mount is handed no such service and so has no `/` at all.
   */
  #mountTriggerPicker() {
    // Idempotent: a re-mount without an unmount would leave the old picker's
    // element on document.body and its subscriptions on a dead view.
    if (this.#triggerPicker) { this.#triggerPicker.destroy(); this.#triggerPicker = null }
    const editorPane = this.#editorPane
    if (!editorPane) return
    const host = /** @type {any} */ (this.#host)
    const caps = host.getCapabilities()
    const macros = WysiwygSurface.macrosFor(host.macroCatalog || null, editorPane, caps)
    const port = new CaretTriggerPort(editorPane, this.#host, () => this.flushPending())
    /** @type {import('../../../shell/trigger-providers.js').TriggerProvider[]} */
    const providers = [new BlockInsertProvider({ list: () => macros })]
    if (host.mentionService) {
      providers.push(new MentionProvider(host.mentionService, (c) => host.onMentionAccepted(c)))
    }
    if (host.commandService) {
      providers.push(new SlashCommandProvider(host.commandService, () => port.caretInFirstBlock()))
    }
    // The host CLASS carries the block-making capability, so a provider probing
    // for it reads the same fact the lens published.
    const triggerHost = caps[LensCapability.BLOCKS]
      ? new BlockMakingProseMirrorHost(port)
      : new ProseMirrorHost(port)
    this.#triggerPicker = new TriggerPopover(triggerHost, providers, new CaretPlacement())
  }

  // Tiptap-bound clipboard/drag I/O, wired at editorProps.handlePaste/handleDrop.
  // Nothing here CREATES a block: every branch either steps aside or hands the
  // payload to the container and waits, because a paste that mints structure
  // locally is a second document authority.
  //
  // ONE QUERY, FOUR KINDS — a readable clipboard, a Sieve slice, a drop the OS
  // caught, a clipboard the page cannot read at all — as DATA in the payload
  // rather than four methods.

  /**
   * The container's paste DECISION, read defensively. Anything this build does
   * not recognise degrades to `none`, including a `content` outcome carrying no
   * fragment: an unknown future outcome must fall back to replaying the
   * clipboard, never to a silently swallowed paste.
   * @param {{outcome?: string, content?: string}|null|undefined} decision
   * @returns {'block'|'content'|'none'}
   */
  #pasteOutcome(decision) {
    if (!decision) return 'none'
    if (decision.outcome === 'block') return 'block'
    if (decision.outcome === 'content' && decision.content) return 'content'
    return 'none'
  }

  /**
   * Plays ONE smart-paste round-trip result into the document — the SINGLE place
   * the union is consumed.
   *
   *   block   — the block arrives over the insert-block render-back at its own
   *             server index; all that is left is consuming the empty-paragraph
   *             anchor that held its place.
   *   content — Go composed a fragment for the caret. The anchor is deliberately
   *             NOT consumed: it was minted to hold a BLOCK's place.
   *   none    — the blank line was never eaten, so `replay` lands at the intact
   *             caret. The gesture was preventDefault()'d, so PM never ran its
   *             native scroll-to-caret — restore it explicitly.
   *
   * @param {{outcome?: string, content?: string}|null|undefined} decision
   * @param {{anchor: {id: string}|null, at?: number, replay?: string|null}} placement
   *   `at` — an explicit DROP coordinate; omitted = the live caret. `replay` —
   *   the local content for `none`; omitted = nothing to replay.
   * @returns {'block'|'content'|'none'} the outcome that was applied
   */
  #applyPasteResult(decision, placement) {
    const ed = this.#editorPane
    if (!ed) return 'none'
    const outcome = this.#pasteOutcome(decision)
    if (outcome === 'block') {
      this.#host.consumeInsertAnchor(placement.anchor)
      return outcome
    }
    // `outcome === 'content'` already implies a fragment; the guard is for the
    // type-checker.
    const content = outcome === 'content' ? (decision && decision.content) : placement.replay
    if (!content) return outcome
    if (placement.at != null) ed.commands.insertContentAt(placement.at, content)
    else ed.commands.insertContent(content)
    ed.commands.scrollIntoView()
    return outcome
  }

  /**
   * Inserts `url` at the caret as a hyperlink THROUGH THE SAME Go round-trip a
   * paste of that URL takes, so Go fetches the title and composes the anchor.
   * There is deliberately no local "just make an <a>" fallback, because one that
   * cannot fetch a title is the dumber path this exists to avoid.
   *
   * The dialog's other three rungs call `editor.createBlock` because they MAKE
   * BLOCKS; a link is an inline mark with no block to create. A URL the pipeline
   * claims for a kind still becomes that BLOCK here.
   * @param {string} url
   * @returns {Promise<boolean>} true when Go's content (or block) landed
   */
  insertLink(url) {
    const provider = this.#pasteProvider()
    if (!url || !this.#editorPane || !provider) return Promise.resolve(false)
    const peek = this.#host.peekInsertAnchorForBlock()
    return provider
      .paste({ kind: 'smart', entries: [{ mimeType: 'text/plain', content: url }] }, peek.afterBlockId)
      // `none` replays the bare URL. Not reachable while Go composes an anchor
      // for every http(s) URL.
      .then((decision) => this.#applyPasteResult(decision, { anchor: peek.anchor, replay: url }) !== 'none')
      .catch((err) => {
        console.error('[wysiwyg-surface] insert link failed', err)
        return false
      })
  }

  /**
   * @override — pastes plain text through the SAME pipeline a keyboard paste
   * takes. A container with no paste query falls back to the local insert.
   * @param {string} text
   * @returns {Promise<'block'|'content'|'none'>}
   */
  pasteText(text) {
    const ed = this.#editorPane
    if (!ed || !text) return Promise.resolve('none')
    const provider = this.#pasteProvider()
    if (!provider) {
      ed.commands.insertContent(text)
      ed.commands.scrollIntoView()
      return Promise.resolve('none')
    }
    const peek = this.#host.peekInsertAnchorForBlock()
    return provider
      .paste({ kind: 'smart', entries: [{ mimeType: 'text/plain', content: text }] }, peek.afterBlockId)
      .then((decision) => this.#applyPasteResult(decision, { anchor: peek.anchor, replay: text }))
      .catch((err) => {
        console.error('[wysiwyg-surface] menu paste failed', err)
        ed.commands.insertContent(text)
        return 'none'
      })
  }

  /** The container's paste query, or null. The prompt pseudo-document is excluded
   *  by TYPE, not by a uuid test: its provider carries no block extension.
   *  @returns {any} */
  #pasteProvider() {
    const provider = this.#host.provider
    return (provider && typeof provider.paste === 'function') ? provider : null
  }

  /**
   * @param {ClipboardEvent} event
   * @returns {boolean} true when handled (native paste suppressed)
   */
  #handleSmartPaste(event) {
    if (!event.clipboardData || !this.#editorPane) return false

    if (event.target && (/** @type {any} */ (event.target).tagName === 'INPUT' || /** @type {any} */ (event.target).tagName === 'TEXTAREA')) {
      return false
    }

    // Caret inside a raw-text fenced block: paste is a literal text paste into
    // that block, not a smart-paste. Step aside.
    if (caretInRawTextBlock && caretInRawTextBlock(this.#editorPane)) {
      return false
    }

    var text = event.clipboardData.getData('text/plain')
    var html = event.clipboardData.getData('text/html')

    // A pasted ```ai-block fence is NOT handled here: it is a block arriving in
    // serialized form, which is a structural mutation and belongs to Go.

    // A multi-block slice is reconstructed by Go, one block per item at
    // cursorIndex+i, each render-backing via insert-block. A single-block slice
    // falls through to the smart-paste pipeline below.
    var sliceData = event.clipboardData.getData('sieve/slice')
    if (sliceData && this.#pasteProvider()) {
      try {
        var slice = JSON.parse(sliceData)
        if (Array.isArray(slice) && slice.length > 1) {
          event.preventDefault()
          this.#pasteProvider()
            .paste({ kind: 'slice', slice: slice }, this.#host.insertAnchorForBlock())
            .catch(function (err) { console.error('[wysiwyg-surface] paste-slice failed', err) })
          return true
        }
      } catch (e) {
        console.error('[wysiwyg-surface] failed to parse a sieve/slice paste', e)
      }
    }

    // Two shapes leave through Go: gestures the webview can see but not READ.
    if (this.#pasteProvider()) {
      // A COPIED FILE the page can name still routes to the NATIVE clipboard
      // read. The list the page read is only the RECOGNISER; Go asks GTK itself.
      if (WysiwygSurface.#localFileURIs(event.clipboardData) !== null) {
        return this.#pasteThroughGo(event, 'native file paste')
      }
      // A CLIPBOARD THE PAGE CANNOT SEE AT ALL. WebKitGTK delivers a paste event
      // whose DataTransfer is completely empty for a desktop-tool screenshot,
      // while any normal GTK process reads the same offer fine. That emptiness is
      // the only signal there is, so it is the trigger.
      if (WysiwygSurface.#offersNothing(event.clipboardData)) {
        return this.#pasteThroughGo(event, 'native clipboard paste')
      }
    }

    if (this.#pasteProvider()) {
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

        // PEEK, not consume: the caret's empty-paragraph anchor is eaten ONLY
        // once a match is confirmed, so a no-match leaves the blank line and
        // caret intact and the fallback pastes there.
        var peek = this.#host.peekInsertAnchorForBlock()
        event.preventDefault()

        Promise.all(promises).then(function(results) {
          var validEntries = results.filter(function(r) { return r !== null })
          var provider = self.#pasteProvider()
          if (!provider) return
          provider.paste({ kind: 'smart', entries: validEntries }, peek.afterBlockId)
            .then(function (decision) {
              self.#applyPasteResult(decision, { anchor: peek.anchor, replay: html || text })
            })
            .catch(function (err) {
              console.error('[wysiwyg-surface] smart paste failed', err)
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
   * Claims a paste whose content the page cannot read and hands the gesture to
   * Go, at the CARET.
   *
   * BOTH native paste shapes are ONE payload kind — `native-clipboard` — because
   * they are one question: the page cannot read this, please read it yourself.
   * There is deliberately no `replay`: the page never held the content, so a
   * `none` outcome has nothing to put back.
   * @param {ClipboardEvent} event
   * @param {string} label named in the failure log
   * @returns {boolean} always true — the gesture is claimed either way
   */
  #pasteThroughGo(event, label) {
    const peek = this.#host.peekInsertAnchorForBlock()
    event.preventDefault()
    const provider = this.#pasteProvider()
    if (!provider) return true // no block extension: paste suppressed, dropped
    provider.paste({ kind: 'native-clipboard' }, peek.afterBlockId)
      .then((decision) => this.#applyPasteResult(decision, { anchor: peek.anchor }))
      .catch((err) => { console.error('[wysiwyg-surface] ' + label + ' failed', err) })
    return true
  }

  /**
   * True when a DataTransfer offers nothing THE PAGE CAN READ.
   *
   * Not "no types": WebKitGTK advertises flavours whose content it then refuses
   * to hand over, and its string items only deliver after the handler returns,
   * when the store is already empty. An advertised-but-unreadable offer IS the
   * native-read signal. A real readable File takes the ordinary pipeline, as does
   * any flavour `getData` actually answers.
   * @param {DataTransfer} transfer
   * @returns {boolean}
   */
  static #offersNothing(transfer) {
    for (const flavour of ['text/plain', 'text/html', 'text/uri-list', 'sieve/slice']) {
      if (transfer.getData(flavour)) return false
    }
    if (transfer.files && transfer.files.length) return false
    return !Array.from(transfer.items || []).some((i) => i.kind === 'file')
  }

  /**
   * A DROP is a native-file gesture the page can see but cannot READ. WebKitGTK
   * never materialises a `File` for a file-manager drag: the whole drop arrives
   * as the `text/uri-list` the OS put on it, and no amount of reading
   * `DataTransfer` produces bytes. So this owns the GESTURE and the PLACEMENT
   * only, and hands the uri-list to Go, which does the reading.
   *
   * Everything else is left to ProseMirror.
   * @param {DragEvent} event
   * @returns {boolean} true when handled (native drop suppressed)
   */
  #handleSmartDrop(event, slice, moved) {
    if (!event.dataTransfer || !this.#editorPane) return false
    // A container with no block extension (a prompt) has no block tree to drop into.
    if (!this.#pasteProvider()) return false
    // Internal PM drags are PM's own and never claimed. THE TRAP: `slice` is NOT
    // the discriminator, because PM parses any droppable content into a slice,
    // including an external drop's path text, so gating on it hands every
    // external drop back to PM. `view.dragging` marks a drag that ORIGINATED
    // here; everything else is external and pages the backend. The page's own
    // view of the drop is never consulted — WebKitGTK starves it — so the
    // OS-level catch (Wails OnFileDrop) feeds the native drop bucket.
    if (moved || this.#editorPane.view.dragging) return false

    const coords = this.#editorPane.view.posAtCoords({ left: event.clientX, top: event.clientY })
    const insertPos = coords ? coords.pos : this.#editorPane.state.selection.to
    // PEEK, never an eager consume: a drag the bucket cannot answer still resolves
    // `none`, and the caret's empty paragraph must survive that.
    const peek = this.#host.peekInsertAnchorAt(insertPos)

    // Claim the drop BEFORE the round trip. Without this PM inserts the `file:///…`
    // path as text.
    event.preventDefault()

    const provider = this.#pasteProvider()
    // The frame means "there was a drop at this position — take it from the
    // native drop bucket", plus whatever text the page could read as a HINT: some
    // source apps never offer a file URI at any layer. Go consults the hint ONLY
    // when the bucket is empty.
    const hint = []
    for (const flavour of ['text/uri-list', 'text/plain']) {
      const v = event.dataTransfer.getData(flavour)
      if (v) hint.push({ mimeType: flavour, content: v })
    }
    // WebKitGTK starves getData for EVERY flavour, but PM parsed the drop into
    // `slice` through WebKit's INTERNAL channel — the one readable view left.
    if (hint.length === 0 && slice && slice.content && slice.content.size) {
      const text = slice.content.textBetween(0, slice.content.size, '\n', '\n').trim()
      if (text) hint.push({ mimeType: 'text/plain', content: text })
    }
    provider.paste({ kind: 'native-drop', entries: hint }, peek.afterBlockId)
      .then((decision) => this.#applyPasteResult(decision, { anchor: peek.anchor, at: insertPos }))
      .catch((err) => { console.error('[wysiwyg-surface] native file drop failed', err) })
    return true
  }

  /**
   * Whether a `text/uri-list` names at least one LOCAL file. The test is the URI
   * SCHEME: a link dragged out of a browser puts its http URL on this same
   * flavour, and that is content to paste rather than a file to read.
   * @param {string} list
   * @returns {boolean}
   */
  static #namesAFile(list) {
    return list.split('\n').some((line) => {
      const uri = line.trim()
      return uri !== '' && !uri.startsWith('#') && uri.toLowerCase().startsWith('file:')
    })
  }

  /**
   * The `text/uri-list` of a transfer that names LOCAL FILES, or null. This is the
   * synchronous getData view, which WebKitGTK may answer with '' — fine HERE,
   * because an unreadable copied-file paste falls through to the
   * `native-clipboard` read. Only the DROP path needs the async items read.
   * @param {DataTransfer} transfer
   * @returns {string|null}
   */
  static #localFileURIs(transfer) {
    const list = transfer.getData('text/uri-list')
    if (!list) return null
    return WysiwygSurface.#namesAFile(list) ? list : null
  }

  /**
   * Builds a RAW selection descriptor from the LIVE PM state — the ONLY place PM
   * selection is read for the SelectionModel, and no PM node escapes.
   *
   * This owns the PARTS THAT NEED THE LIVE VIEW/DOM: the effective range and the
   * read-only-region DOM highlight fold. The PM-only assembly is
   * #buildSelectionDescriptor's.
   * @returns {import('../selection-model.js').RawSelectionDescriptor}
   */
  feedSelection() {
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

    // The EFFECTIVE range: block-chrome's authoritative range, falling back to
    // the live PM selection.
    let er = (T && getBlockSelectionRange)
      ? getBlockSelectionRange(ed.view)
      : { from: sel.from, to: sel.to, active: !sel.empty, isBlockRange: false, isNodeSelection: !!sel.node }

    // A highlight inside a contentEditable=false region leaves PM's selection
    // elsewhere, so re-target onto the block it actually lives in.
    const domSel = (typeof window !== 'undefined' && window.getSelection) ? window.getSelection() : null
    let domSelText = null
    if (domSel && !domSel.isCollapsed && domSel.toString && domSel.toString().trim() && T) {
      const blockDescs = this.#topBlockDescriptors(ed)
      const retarget = BlockSelection.blockRange(domSel, er, blockDescs)
      if (retarget) {
        er = { from: retarget.from, to: retarget.to, active: true, isBlockRange: false, isNodeSelection: false }
        domSelText = domSel.toString()
      }
    }

    const raw = this.#buildSelectionDescriptor(state.doc, sel, er, T, domSelText)
    // The DOM read the pure PM core must NOT do: focus inside a block's inner
    // editor merges its OWN cursor as the opaque blockCursor.
    raw.blockCursor = this.#captureBlockCursor()
    // The marks this surface is DRAWING under that same range. They live in the
    // plugin, not in the document, so they are read here rather than off the doc
    // the pure core walks.
    raw.textMarks = this.#textMarksAt(state, er.from, er.to)
    return raw
  }

  /**
   * Every mark this surface draws under `[from, to]`, from ALL of its decoration
   * sets, as one flat list in the order the sets are held. The advertisement is
   * a broadcast: it says everything the surface knows is under there, each mark
   * stamped with the feature that drew it, and a consumer decides which of them
   * are its business.
   * @param {any} state a ProseMirror editor state
   * @param {number} from @param {number} to
   * @returns {Array<Record<string, any>>}
   */
  #textMarksAt(state, from, to) {
    /** @type {Array<Record<string, any>>} */ const marks = []
    for (const set of [this.#spell, this.#find]) {
      if (set) marks.push(...set.marksAt(state, from, to))
    }
    return marks
  }

  /**
   * DORMANT SEAM: captures a block's inner cursor only when focus sits in a
   * `.sieve-block__edit` form control. No shipped block is built that way — code,
   * diagram and log edit via a PM contentDOM — so this returns null in practice.
   * Kept as the extension point for a future non-PM inner editor.
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
   * Restores focus/selection from a SelectionContext coordinate — the symmetric
   * WRITE of feedSelection. A ctx naming a block that hosts an inner editor AND
   * carrying a blockCursor restores INSIDE that block; otherwise the DOCUMENT
   * caret/range is re-resolved against the current doc size.
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
    // (b) doc caret/range re-resolved against the CURRENT doc: a captured Selection
    // is bound to its doc instance and would throw if anything edited in between.
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

  /** Ordered top-level sieve-block descriptors — the read-only-region fold input.
   *  Only sieve nodes hold a region PM cannot track.
   *  @param {any} ed @returns {Array<{from:number,to:number,dom:any}>} */
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

  /**
   * Build the full PLAIN raw descriptor from a live PM — the ONE place PM is read
   * into a descriptor, and no PM node ever escapes.
   *
   * Classification: single NodeSelection → 'block'; block-range or dom-fold →
   * 'range'; collapsed → 'caret'; else non-empty text → 'range'.
   *
   * @param {any} doc              the PM doc
   * @param {any} sel              the PM selection (state.selection)
   * @param {{from:number,to:number,active:boolean,isBlockRange?:boolean,isNodeSelection?:boolean}} er  the effective range (surface-computed)
   * @param {any} T                truthy gate: enables the rich getSieveBlockLabel path (#labelFor)
   * @param {string|null} [domSelText]  read-only-region DOM highlight text, or null
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
    // A COLLAPSED caret spans exactly ONE block — its primary. A RANGE keeps the
    // full multi-block overlap span.
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
   * The resolved AI `target` — four ordered cases, from PLAIN values:
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
   * block at the selection HEAD, when that block is inside the spanned range.
   * When the effective range was re-targeted the head block is NOT in the span,
   * so fall to the FIRST block the range spans.
   *
   * DOC-LEVEL GAP (a collapsed caret between top-level nodes): prefer the
   * ADJACENT non-flowing UNIT, so a caret in the gap after an hr targets that
   * unit rather than a flowing paragraph.
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

  /** Every top-level block whose extent overlaps `[from,to]`, in document order.
   *  A collapsed caret still lands in exactly the block it sits in.
   *  @param {any} doc @param {number} from @param {number} to
   *  @returns {Array<{node:any,id:string|null}>} */
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

  /** The block kind as a PLAIN string: a sieve-* node carries `attrs.kind`, a
   *  native prose node is its PM type name.
   *  @param {any} node @returns {string|null} */
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
   * The friendly display label for the resolved target, ALWAYS populated. The
   * surface holds the PM `primary` node here, so RICH sieve labels (e.g.
   * 'Javascript Code Block') are preserved and must not regress to a bare
   * title-cased kind.
   * @param {any} primary                    the PM node owning the selection (or null)
   * @param {'none'|'caret'|'range'|'block'} selectionType
   * @param {string|null} blockKind
   * @param {string|null} selectedText
   * @param {any} T                          truthy gate: enables the rich getSieveBlockLabel path
   * @returns {string}
   */
  #labelFor(primary, selectionType, blockKind, selectedText, T) {
    // A range, or a node-selected proseGroup (invisible grouping → its passage),
    // is a text selection → a snippet.
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

  #titleCase(kind) {
    if (!kind) return 'Block'
    return kind.charAt(0).toUpperCase() + kind.slice(1).replace(/-/g, ' ')
  }

  /**
   * The ONE discriminator. A top-level block is flowing text iff it is a
   * paragraph, heading or proseGroup — content a bare caret cannot disambiguate,
   * so it targets the whole document. Every other top-level kind is a discrete
   * UNIT you target as a whole by its id.
   *
   * proseGroup counts as flowing text because it is a backend contrivance: one
   * multi-paragraph prose block under a shared id, visually indistinguishable
   * from individually-minted paragraphs. A bare caret may only target units the
   * user can SEE as units.
   * @param {string|null} kind
   */
  #isFlowingText(kind) {
    return kind === 'paragraph' || kind === 'heading' || kind === 'proseGroup'
  }

  // The surface is told WHAT changed and re-reads each block from the follower
  // model. Who changed it is unsayable.
  //
  // TRACKED-NESS IS NOT UNIFORM, deliberately. An ARRIVAL and a REPLACEMENT are
  // placements of something the user asked for, so they are tracked. A DEPARTURE,
  // an attrs refresh and a reorder are changes nobody here made, and tracking
  // those would mean the user's next Mod+Z undid someone else's work.

  /**
   * @param {{blockIds: ReadonlyArray<string>, orderChanged: boolean, replaced?: ReadonlyArray<string>}} change
   * @param {any} provider the mounted container's provider (reads only, here)
   */
  applyContainerChange(change, provider) {
    const ed = /** @type {any} */ (this.editorPane)
    if (!ed || !provider) return
    // The first cue after a mount IS the bootstrap: it names the whole container
    // and there is no undo history to lose, so it paints everything.
    if (!this.#painted) { this.paintContainer(provider); return }

    const replaced = new Set((change && change.replaced) || [])
    for (const id of (change && change.blockIds) || []) {
      const node = provider.getBlock(id)
      const held = this.#findNodeById(ed, id)
      if (!node) { if (held) this.#removeBlockNode(id); continue }
      if (!WysiwygSurface.#isBody(node)) continue
      if (!held) { this.#placeBlock(node, provider.getOrder().indexOf(id)); continue }
      const heldKind = (held.node.attrs && held.node.attrs.kind) || ''
      // A REPLACED block is the host's whole truth for that slot, and a block
      // that changed kind cannot be patched into the one the doc holds. Both
      // are placed, prose included.
      if (replaced.has(id) || (heldKind && heldKind !== node.kind)) { this.#replaceBlockNode(id, node); continue }
      // PROSE THE EDITOR ALREADY HOLDS IS SKIPPED: its text is the lens's own,
      // the one piece of state that legitimately lives ahead of Go. Baseline it
      // instead, so the observer does not re-create a block Go already has.
      if (node.kind === 'prose') { this.#noteServerBlock(id); continue }
      this.#refreshBlockAttrs(id, node.attrs)
    }
    if (change && change.orderChanged) this.#reconcileOrder(this.#bodyOrder(provider))
  }

  /** Paints the WHOLE container from the model — the bootstrap cue, and a genuine
   *  LOAD. One non-undoable transaction, so it WIPES UNDO HISTORY by
   *  construction: never call it for a change.
   *  @param {any} provider */
  paintContainer(provider) {
    const ed = /** @type {any} */ (this.editorPane)
    if (!ed || !provider) return
    const blocks = this.#blocksFromContainer(provider)
    this.#suppressUpdate = true
    try {
      this.#renderBlocksIntoEditor(ed, blocks, { allowEmpty: true })
      this.#seedBlockCache(ed, blocks)
      this.#painted = true
    } catch (err) {
      console.error('[wysiwyg-surface] container paint failed', err)
    } finally {
      this.#suppressUpdate = false
    }
  }

  /** The container's BODY blocks as the pipeline's typed blocks, in order. The
   *  model hands out plain frozen data and the pipeline is block-native; this is
   *  where the two meet.
   *  @param {any} provider @returns {SieveBlock[]} */
  #blocksFromContainer(provider) {
    const out = []
    for (const id of provider.getOrder()) {
      const n = provider.getBlock(id)
      if (n && WysiwygSurface.#isBody(n)) {
        out.push(new SieveBlock(n.kind, Object.assign({}, n.attrs, { id: n.id, kind: n.kind })))
      }
    }
    return out
  }

  /** The ids of the container's body blocks, in container order — the order the
   *  document can actually state, since it holds nothing else.
   *  @param {any} provider @returns {string[]} */
  #bodyOrder(provider) {
    return provider.getOrder().filter((/** @type {string} */ id) =>
      WysiwygSurface.#isBody(provider.getBlock(id)))
  }

  /**
   * Whether a container block is BODY — material a surface paints.
   *
   * A reference declaring a `rel` is a QUESTION ELEMENT wearing its role stamp:
   * it belongs to the question some block IS, not to the text being written, so
   * no surface paints one and the observer never sees it. A document's own
   * references carry an empty `rel`, and every other kind is body whatever it
   * holds.
   * @param {{kind: string, attrs?: Record<string, any>}|null} node
   * @returns {boolean}
   */
  static #isBody(node) {
    if (!node) return false
    return !(node.kind === 'reference' && !!(node.attrs && node.attrs.rel))
  }

  /** The first node carrying this id, at any depth, or null.
   *  @param {any} ed @param {string} id @returns {{pos: number, node: any}|null} */
  #findNodeById(ed, id) {
    if (!id) return null
    let hit = null
    ed.state.doc.descendants(function (node, pos) {
      if (hit) return false
      if (node.attrs && node.attrs.id === id) { hit = { pos: pos, node: node }; return false }
    })
    return hit
  }

  /** Places a block the container holds but this doc does not, at the container
   *  position it occupies — a TRACKED transaction, so it is one undoable step.
   *  @param {{id: string, kind: string, attrs: Record<string, any>}} node
   *  @param {number} index the block's position in the container */
  #placeBlock(node, index) {
    var self = this
    var ed = /** @type {any} */ (this.editorPane)
    if (!ed) return
    var kind = node.kind || 'code'
    var blk = new SieveBlock(kind, Object.assign({}, node.attrs, { id: node.id, kind: kind }))
    var content = this.#blockToNodes(ed, blk).map(function (n) { return n.toJSON() })
    if (!content.length) return

    // Go's index is the CONTAINER's; a negative index appends.
    var at = index >= 0 ? this.#docPosForBlockIndex(ed, index) : ed.state.doc.content.size
    ed.commands.insertContentAt(at, content)

    // A server-authored block is authoritative — baseline it so the observer
    // never re-creates it (prose especially, which it otherwise owns).
    this.#noteServerBlock(node.id)

    if (!node.attrs.source && (kind === 'code' || kind === 'diagram')) {
      setTimeout(function () {
        var focusEl = document.querySelector('[data-id="' + node.id + '"] .sieve-block__edit')
        if (focusEl) /** @type {HTMLElement} */ (focusEl).focus()
      }, 50)
    } else if (kind !== 'ai-block') {
      // Return focus with the caret AFTER the new block so the user can keep
      // typing. code/diagram focus their own edit surface; AI answers never do.
      setTimeout(function () {
        var e2 = /** @type {any} */ (self.editorPane)
        if (!e2) return
        var doc = e2.state.doc
        var idxAfter = blockIndexAfter(doc, node.id)
        if (idxAfter < 0) { e2.commands.focus(); return }
        var pos = docPosForBlockIndex(doc, idxAfter)
        e2.chain().focus().setTextSelection(Math.min(pos, e2.state.doc.content.size)).run()
      }, 60)
    }

    this.#scrollTo(node.id)
  }

  /** Places the host's block over the one the doc holds for that id — a
   *  transform, or a text rewrite Go executed. Tracked: insertContentAt(range, …)
   *  is undoable, and the observer propagates an undo to the backend.
   *  @param {string} id @param {{id: string, kind: string, attrs: Record<string, any>}} node */
  #replaceBlockNode(id, node) {
    var ed = /** @type {any} */ (this.editorPane)
    if (!ed) return
    var held = this.#findNodeById(ed, id)
    if (!held) return
    var kind = node.kind || 'prose'
    var blk = new SieveBlock(kind, Object.assign({}, node.attrs, { id: node.id, kind: kind }))
    var content = this.#blockToNodes(ed, blk).map(function (n) { return n.toJSON() })
    if (!content.length) return
    ed.commands.insertContentAt({ from: held.pos, to: held.pos + held.node.nodeSize }, content) // tracked → undoable
    this.#noteServerBlock(node.id)
    this.#scrollTo(node.id)
  }

  /** A block left the container. UNTRACKED: nobody here made this edit, and a
   *  tracked delete would put someone else's change atop the user's undo stack.
   *  @param {string} id */
  #removeBlockNode(id) {
    var ed = /** @type {any} */ (this.editorPane)
    if (!ed) return
    var held = this.#findNodeById(ed, id)
    if (!held) return
    // A remove cue names a TOP-LEVEL block. A nested NATIVE PROSE match is a
    // stale leftover id on a node something wrapped (identity strips it on the
    // next pass), never the container's block — deleting it would tear content
    // out of a blockquote or list the user is inside. A nested sieve-* match
    // stays deletable: a container kind's children are genuinely addressed.
    if (isNativeProseNodeName(held.node.type.name) && ed.state.doc.resolve(held.pos).depth > 0) return
    var tr = ed.state.tr.delete(held.pos, held.pos + held.node.nodeSize)
    tr.setMeta('addToHistory', false)
    ed.view.dispatch(tr)
    if (this.#blockContentCache) delete this.#blockContentCache[id]
  }

  /** A block's attrs changed. Untracked, for the same reason a departure is.
   *  @param {string} id @param {Record<string, any>} attrs */
  #refreshBlockAttrs(id, attrs) {
    var ed = /** @type {any} */ (this.editorPane)
    if (!ed) return
    var parsed = attrs || {}

    ed.commands.command(function (commandProps) {
      var tr = commandProps.tr
      commandProps.state.doc.descendants(function (node, pos) {
        // Match any sieve-* node by id (the container's data says nothing about
        // which PM node type renders it).
        if (node.type.name.startsWith('sieve-') && node.attrs.id === id) {
          var nextAttrs = Object.assign({}, node.attrs, {
            status:          parsed.status   || node.attrs.status,
          })
          Object.keys(parsed).forEach(function (k) {
            // Apply only keys already in the schema. `kind` is refused alongside
            // id/status: BASE_ATTRS declares it on EVERY sieve-* node, so a
            // processor attrs bag carrying one would silently retype the node the
            // moment a job completed. Kind changes by replacement only.
            if (k !== 'id' && k !== 'status' && k !== 'kind' && (k in node.attrs)) {
              nextAttrs[k] = parsed[k]
            }
          })
          try {
            tr.setNodeMarkup(pos, null, nextAttrs)
            tr.setMeta('addToHistory', false)
          } catch (err) {
            console.error('[wysiwyg-surface] setNodeMarkup failed:', err, nextAttrs)
          }
          return false
        }
      })
      return true
    })
  }

  /**
   * Re-orders the doc's top-level blocks to match the container's order.
   *
   * ONLY when the doc holds exactly the container's blocks: while a node is still
   * pending the two lists describe different things, and reordering against a
   * list missing an id would move a block past something the container cannot
   * see. Leaving it alone is safe — the next cue after the sets agree reorders.
   * @param {ReadonlyArray<string>} order
   */
  #reconcileOrder(order) {
    var ed = /** @type {any} */ (this.editorPane)
    if (!ed) return
    var doc = ed.state.doc
    var held = []
    var trailing = []
    var byId = new Map()
    doc.forEach(function (child) {
      var id = child.attrs && child.attrs.id
      if (id) { held.push(id); byId.set(id, child) } else { trailing.push(child) }
    })
    if (held.length !== order.length) return
    for (var i = 0; i < order.length; i++) if (!byId.has(order[i])) return
    var same = true
    for (var j = 0; j < order.length; j++) if (held[j] !== order[j]) { same = false; break }
    if (same) return

    var nodes = order.map(function (id) { return byId.get(id) }).concat(trailing)
    var tr = ed.state.tr.replaceWith(0, doc.content.size, nodes)
    tr.setMeta('addToHistory', false)
    ed.view.dispatch(tr)
    this.#blockOrderCache = order.slice()
  }

  /** Brings a block into view. An async answer carries no focus, so it can land
   *  below the fold; deferred so the NodeView has rendered, 'nearest' so it does
   *  not jump when already visible, and vertically only so an arrival never
   *  moves the text the reader is looking at sideways.
   *  @param {string} id */
  #scrollTo(id) {
    if (!id) return
    setTimeout(function () {
      VerticalScroll.into(document.querySelector('[data-id="' + id + '"]'), 'nearest')
    }, 60)
  }

  /**
   * Renders ONE SieveBlock to its ProseMirror node(s) — the single place that
   * knows how a block becomes editor nodes, shared by the whole-document load and
   * the per-block render-back so a block renders identically however it arrives.
   * Parsed in ISOLATION, so a block the schema rejects is logged and skipped.
   * @param {any} editorPane @param {import('../../../contract/sieve-block.js').SieveBlock} b @returns {any[]}
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
        // proseBlockNodes stamps the block id: one node → that node; >1 → one
        // proseGroup.
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
   * Replaces the whole document with the block list, in one non-undoable
   * transaction. opts.allowEmpty: a genuinely-empty block list clears the editor
   * to one empty paragraph instead of keeping stale content. Set only by
   * paintContainer.
   * @param {any} editorPane @param {import('../../../contract/sieve-block.js').SieveBlock[]} blocks @param {{allowEmpty?: boolean}} [opts]
   */
  #renderBlocksIntoEditor(editorPane, blocks, opts) {
    var self = this
    var T = this.#T
    var nodes = []
    ;(blocks || []).forEach(function (b) {
      self.#blockToNodes(editorPane, b).forEach(function (n) { nodes.push(n) })
    })
    var replacement = reloadReplacement(nodes, opts || {}, editorPane.state.schema)
    if (replacement === null) return // keep existing content (transient empty)
    var tr = editorPane.state.tr
    tr.replaceWith(0, editorPane.state.doc.content.size, replacement)
    tr.setMeta('addToHistory', false)
    // The whole-doc replace maps the prior selection to the END of the new
    // content; a load is not an edit, so park the caret at the doc start IN THE
    // SAME transaction. PM's view DEFAULTS to preserving the scroller's prior
    // offset unless the transaction's scrollToSelection counter advanced, so an
    // unadorned replace carries the PREVIOUS document's scroll into this one.
    // `scrollIntoView()` bumps that counter. Never assign scrollTop after the
    // fact: that races PM's own restore rather than replacing it.
    try {
      tr.setSelection(T.TextSelection.atStart(tr.doc))
      tr.scrollIntoView()
    } catch (_) {}
    editorPane.view.dispatch(tr)
  }

  /**
   * Serialize one top-level block to the (id, kind, content) the sync diff needs.
   * A structured sieve block's `content` is a change-SIGNATURE only, never emitted
   * as an op: the JSON of its attrs, which changes iff its persistent state does.
   * Every other top-level node is a prose block, whose content is its CLEAN
   * markdown — native nodes never embed markers, and Go re-wraps on save.
   * @param {any} ed @param {any} node
   */
  #topBlockTriple(ed, node) {
    var name = node.type.name
    if (name.indexOf('sieve-') === 0) {
      return { id: node.attrs.id || '', kind: node.attrs.kind || name, content: JSON.stringify(sieveBlockAttrs(node)) }
    }
    var content = (serializeNode(ed, node) || '').trim()
    return { id: node.attrs.id || '', kind: 'prose', content: content }
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
   * Seed the sync baseline from GO's view, NOT the editor, so a block PM created
   * client-side is absent from it and the first sync emits a create-block.
   * Seeding from the editor would hide such a block from Go forever, its
   * update-block failing "block not found".
   * @param {any} editorPane @param {Array<any>|null} serverBlocks
   */
  #seedBlockCache(editorPane, serverBlocks) {
    // The structured signature is the JSON of the RENDERED node's attrs. The
    // SERVER block's would stringify differently and phantom-flag a change on the
    // first diff, so read it straight off the just-rendered editor.
    var structuredSig = {}
    this.#collectTopBlocks(editorPane).forEach(function (t) {
      if (t.kind !== 'prose' && t.id) structuredSig[t.id] = t.content
    })
    var triples = (serverBlocks || []).map(function (b) {
      return {
        id: b.id,
        kind: b.kind,
        content: b.kind === 'prose' ? proseContent(b) : (structuredSig[b.id] || ''),
      }
    })
    // Includes EVERY id'd server block, even an empty one, so the first edit to a
    // loaded block is an update-block and never a duplicate create.
    this.#blockContentCache = seedBaseline
      ? seedBaseline(triples)
      : {}
    this.#blockOrderCache = triples.filter(function (t) { return !!t.id }).map(function (t) { return t.id })
  }

  /**
   * The debounced domain submit: granular block-ops only, with NO whole-document
   * fallback. It NEVER mutates the document — pure read + submit.
   * @param {any} ed
   */
  #syncDocument(ed) {
    var curr = this.#collectTopBlocks(ed)
    if (!curr || !computeBlockSync) return
    var r = computeBlockSync(curr, this.#blockContentCache)
    this.#blockContentCache = r.next
    // Order rides LAST: it installs the COMPLETE order, so it must land after
    // this tick's creates and deletes have moved the server's set.
    var o = computeOrderOp(curr, this.#blockOrderCache, r.ops)
    this.#blockOrderCache = o.next
    var ops = o.op ? r.ops.concat([o.op]) : r.ops
    if (ops.length) this.#submitOps(ops, curr)
  }

  /**
   * The ONE place the observer's op batch becomes facade verbs. Emission order is
   * preserved, so the container sees the tick's creates before its order
   * statement. A create-block block NAMES ITSELF: the id minted at birth rides in
   * `attrs.id`, and the anchor is the block it follows — never an index. A surface
   * with no block-capable provider drops the batch.
   * @param {any[]} ops @param {any[]} curr the top-level blocks this batch was diffed from
   */
  #submitOps(ops, curr) {
    var provider = this.#host.provider
    if (!provider || typeof provider.requestAddBlock !== 'function') return
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i]
      if (op.type === 'create-block') {
        var attrs = Object.assign({}, op.attrs, { id: op.blockId })
        provider.requestAddBlock(op.kind, attrs, this.#anchorBefore(curr, op.index))
      } else if (op.type === 'update-block') {
        provider.requestSetBlock(op.blockId, op.attrs)
      } else if (op.type === 'delete-block') {
        provider.requestRemoveBlock(op.blockId)
      } else if (op.type === 'set-order') {
        provider.requestSetOrder(op.order)
      }
    }
  }

  /** The block a new child at document index `index` should follow. Walks BACK
   *  past anything with no id, and answers `null` at the front — a real place, and
   *  a different statement from "wherever".
   *  @param {any[]} curr @param {number} index @returns {string|null} */
  #anchorBefore(curr, index) {
    for (var i = Math.min(index, (curr || []).length) - 1; i >= 0; i--) {
      if (curr[i] && curr[i].id) return curr[i].id
    }
    return null
  }

  /** Baseline a server-created block so the thin observer sees it as
   *  already-present and never re-creates it. Derived from the rendered node so
   *  its signature matches topBlockTriple exactly.
   *  @param {string} id */
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

  /** Maps a top-level BLOCK index (Go's tree position) to the editor doc position
   *  before that node, so a render-back lands where Go put it.
   *  @param {any} editorPane @param {number} idx */
  #docPosForBlockIndex(editorPane, idx) {
    return docPosForBlockIndex(editorPane.state.doc, idx)
  }
}

window.SieveWysiwygSurface = WysiwygSurface
