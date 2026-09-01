// Single source of truth for all context menus. Components fire 'sieve:contextmenu'
// with { x, y, context } in the detail; context.type must be one of
// 'editor' | 'sieveBlock' | 'aiBlock' | 'note' | 'folder' | 'prompt'.
import { applyTargetHighlight } from '../extensions.js'
import { NodeViewRegistry, detectAndAppendExtractions, serializeNode } from './surfaces/sieve-block-extension.js'
import { enclosingBlockId } from './surfaces/block-position.js'
import { ProseLink } from './surfaces/prose-link.js'
import { WysiwygSurface } from './surfaces/wysiwyg-surface.js'
import { listRegisteredLanguages } from '../../renderers/highlighting.js'

  var IC = window.SieveIcons || {}

  /** The lens whose surface this menu was raised over, or null in a bare pane.
   *  @param {any} editor the live TipTap pane @returns {any} */
  function mountLens(editor) {
    return (editor && editor.sieveHost) || null
  }

  /** Whether that mount can hold a block. A menu verb that MAKES one asks this,
   *  and reads the very fact the lens published about itself.
   *  @param {any} editor @returns {boolean} */
  function mountHoldsBlocks(editor) {
    var lens = mountLens(editor)
    return !!(lens && lens.canEditBlocks)
  }

  /** The insert entries this mount offers, composed exactly as its `{` picker
   *  composes them — the host's catalog plus the surface's own presets, filtered
   *  by the lens's published capabilities.
   *  @param {any} editor @returns {any[]} */
  function menuMacros(editor) {
    var lens = mountLens(editor)
    if (!lens || typeof lens.getCapabilities !== 'function') return []
    return WysiwygSurface.macrosFor(lens.macroCatalog || null, editor, lens.getCapabilities())
  }

  /** Every entry consumes the token that reached it; a menu pick was reached by
   *  no token, so it is handed an empty one and clearing it writes nothing. */
  var NO_TOKEN = Object.freeze({ start: 0, end: 0, prefix: '' })

  /** How many of a mark's corrections stand IN the menu. A spelling list is read
   *  at a glance or not at all, and the rest of the menu has to stay reachable;
   *  the offers past this hang in a flyout rather than being dropped. */
  var SPELLING_OFFERS = 3

  /** The mark this menu is about, or null. The caret sits on one word, but a
   *  caret between two marked words touches both — so the one carrying
   *  corrections wins, and the first is the fallback when neither does. A mount
   *  that cannot be written to this way is not asked at all.
   *  @param {any} lens @returns {any} */
  function spellingMark(lens) {
    if (!lens || typeof lens.getSelectionContext !== 'function' || typeof lens.replaceText !== 'function') return null
    var marks = lens.getSelectionContext().textMarks || []
    return marks.filter(function (m) { return m.suggestions && m.suggestions.length })[0] || marks[0] || null
  }

  /** The host's spelling verbs — ignore and learn are workspace-wide, so they
   *  belong to the workspace and not to any lens.
   *  @returns {any} */
  function spellVerbs() {
    var ws = window.sieveWorkspace
    return (ws && ws.spell) || null
  }

  /** The innermost ancestor of `$pos` whose type is one of `names`, with the
   *  document position it starts at — or null when the caret is in none of them.
   *  Resolved from the DOCUMENT: what the caret is IN is a fact the document
   *  answers, and the DOM under a pointer is not asked.
   *  @param {any} $pos a resolved position @param {Record<string, boolean>} names
   *  @returns {{node: any, pos: number}|null} */
  function enclosingNode($pos, names) {
    if (!$pos) return null
    for (var d = $pos.depth; d > 0; d--) {
      var node = $pos.node(d)
      if (node && names[node.type.name]) return { node: node, pos: $pos.before(d) }
    }
    return null
  }

  /** A menu entry running ONE named command against the pane.
   *  @param {any} editor @param {string} name @returns {() => void} */
  function paneCommand(editor, name) {
    return function () { editor.chain().focus()[name]().run() }
  }

  /** Whether `table`'s first row is entirely header cells — read from the
   *  DOCUMENT, the same rule GFM pipe markdown enforces on a table it can
   *  represent. @param {any} table @returns {boolean} */
  function tableHasHeaderRow(table) {
    var firstRow = table.firstChild
    if (!firstRow || !firstRow.childCount) return false
    var allHeader = true
    firstRow.forEach(function (cell) { if (cell.type.name !== 'tableHeader') allHeader = false })
    return allHeader
  }

  /**
   * The languages the fence may be tagged with, from the shared registry
   * enumeration. "Plain" leads, and is the ABSENCE of a tag rather than a
   * language of its own.
   * @param {any} editor @param {{node: any}} fence @returns {any[]}
   */
  function languageItems(editor, fence) {
    var current = (fence.node.attrs && fence.node.attrs.language) || ''
    var type = fence.node.type.name
    var items = [languageItem(editor, type, 'Plain', null, !current)]
    listRegisteredLanguages().forEach(function (name) {
      items.push(languageItem(editor, type, name, name, name === current))
    })
    return items
  }

  /** @param {any} editor @param {string} type the fence's node type
   *  @param {string} label @param {string|null} language @param {boolean} current */
  function languageItem(editor, type, label, language, current) {
    return {
      icon: current ? IC.check : null,
      label: label,
      cls: current ? 'ctx-item--active' : '',
      action: function () {
        editor.chain().focus().updateAttributes(type, { language: language }).run()
      },
    }
  }

  /**
   * The TriggerHost a MENU offers a macro: no text to complete into, and
   * everything a block-making entry needs is the lens's own.
   */
  class MenuMacroHost {
    /** @param {any} lens the mount the entry acts against */
    constructor(lens) { this.lens = lens }

    replaceRange() {}

    /** @param {string} kind @param {Record<string, any>} attrs */
    createBlock(kind, attrs) { if (this.lens) this.lens.createBlock(kind, attrs) }
  }

  /** Caps `el`'s height to whatever room is left above the window's bottom
   *  edge — the case a top-shift alone cannot fix, because the element is
   *  simply taller than the window has room for even flush with its own
   *  earliest position. Scrollability arrives HERE, with the cap, never as a
   *  static style: a scrollable menu clips its absolutely-positioned flyout
   *  children, so a surface may scroll only once it is actually capped.
   *  @param {HTMLElement} el @param {number} topInViewport */
  function capHeightToFit(el, topInViewport) {
    var available = window.innerHeight - 8 - topInViewport
    if (available >= el.getBoundingClientRect().height) return
    el.style.boxSizing = 'border-box'
    el.style.maxHeight = Math.max(0, available) + 'px'
    el.style.overflowY = 'auto'
  }

  /** Keeps `menu` inside the window: flipped left when its right edge would
   *  pass the window's, shifted up when its bottom would, and — should even
   *  that not be enough — height-capped so it scrolls within itself rather
   *  than spilling past either edge. @param {HTMLElement} menu */
  function repositionMenu(menu) {
    var r = menu.getBoundingClientRect()
    if (r.right > window.innerWidth - 8)
      menu.style.left = (window.innerWidth - r.width - 8) + 'px'
    var top = r.top
    if (r.bottom > window.innerHeight - 8) {
      top = Math.max(0, window.innerHeight - r.height - 8)
      menu.style.top = top + 'px'
    }
    capHeightToFit(menu, top)
  }

  function render(x, y, items) {
    var existing = document.getElementById('sieve-context-menu')
    if (existing) existing.remove()

    var menu = document.createElement('div')
    menu.id = 'sieve-context-menu'
    menu.className = 'sieve-context-menu'
    menu.style.left = x + 'px'
    menu.style.top = y + 'px'

    appendItemsToMenu(menu, items)

    document.body.appendChild(menu)

    requestAnimationFrame(function () { repositionMenu(menu) })
  }

  function appendItemsToMenu(menu, items) {
    items.forEach(function (item) {
      if (item.type === 'header') {
        var hdr = document.createElement('div')
        hdr.className = 'ctx-header'
        hdr.textContent = item.label
        menu.appendChild(hdr)
      } else if (item.type === 'divider') {
        var sep = document.createElement('div')
        sep.className = 'ctx-separator'
        menu.appendChild(sep)
      } else {
        var btn = buildItemButton(item)
        if (item.children && item.children.length) attachSubmenu(btn, item.children)
        menu.appendChild(btn)
      }
    })
  }

  /** One item's button. A PARENT — an item carrying `children` — is the same
   *  button with a flyout attached; it accepts nothing itself, so its click and
   *  its Enter both open rather than act.
   *  @param {any} item @returns {HTMLElement} */
  function buildItemButton(item) {
    var btn = document.createElement('button')
    btn.className = 'ctx-item' + (item.cls ? ' ' + item.cls : '') + (item.disabled ? ' ctx-item--disabled' : '')
    if (item.disabled) btn.setAttribute('disabled', '')
    if (item.icon) {
      var wrap = document.createElement('span')
      wrap.innerHTML = item.icon
      btn.appendChild(wrap)
    }
    var lbl = document.createElement('span')
    lbl.textContent = item.label
    btn.appendChild(lbl)
    if (item.children && item.children.length) return btn
    btn.addEventListener('click', function (/** @type {Event} */ ev) {
      ev.stopPropagation()
      // The ROOT menu closes, not the list this button happens to sit in: a
      // submenu item accepting must take the whole menu with it.
      closeMenu()
      if (typeof item.action === 'function') item.action()
    })
    return btn
  }

  // The hover path between a parent item and its flyout is a straight line, not
  // a teleport: the pointer transits a strip that belongs to neither element
  // (the CSS overlap in sidebar.css narrows it, never removes it). A hover close
  // fires on a GRACE TIMER for that reason — armed on leaving button or flyout,
  // cancelled by entering either — so a transit never outruns it. Keyboard close
  // is a deliberate act and stays immediate.
  var SUBMENU_CLOSE_GRACE_MS = 150

  /**
   * ONE LEVEL OF FLYOUT, and one mechanism for it. The submenu is a child of the
   * menu it hangs off, so closing the menu closes it and the document Escape
   * listener needs to know nothing about it.
   *
   * Pointer: hover opens; leaving both the parent and the flyout closes after
   * the grace timer, unless the pointer re-enters one of them first.
   * Keyboard: Right/Enter opens and takes focus, Up/Down move within, Left/Escape
   * close immediately and hand focus back.
   * @param {HTMLElement} btn @param {any[]} children
   */
  function attachSubmenu(btn, children) {
    btn.classList.add('ctx-item--parent')
    btn.setAttribute('aria-haspopup', 'true')
    btn.setAttribute('aria-expanded', 'false')
    var arrow = document.createElement('span')
    arrow.className = 'ctx-item__arrow'
    arrow.textContent = '›'
    btn.appendChild(arrow)

    /** @type {any} */ var flyout = null
    /** @type {any} */ var closeTimer = null

    function cancelScheduledClose() {
      if (closeTimer == null) return
      clearTimeout(closeTimer)
      closeTimer = null
    }

    /** Arms the grace-period close; a close already pending is left running. */
    function scheduleClose() {
      if (closeTimer != null) return
      closeTimer = setTimeout(function () { closeTimer = null; close(false) }, SUBMENU_CLOSE_GRACE_MS)
    }

    /** @param {boolean} takeFocus whether the caret follows into the flyout */
    function open(takeFocus) {
      cancelScheduledClose()
      if (flyout) {
        if (takeFocus) focusFirst(flyout)
        return
      }
      // Read lazily: the button is given its flyout before it is put in the
      // menu, and the menu is what the flyout hangs in.
      /** @type {any} */ var owner = btn.parentNode
      flyout = document.createElement('div')
      flyout.className = 'sieve-context-submenu'
      appendItemsToMenu(flyout, children)
      owner.appendChild(flyout)
      btn.setAttribute('aria-expanded', 'true')
      placeSubmenu(btn, flyout)
      flyout.addEventListener('mouseenter', cancelScheduledClose)
      // Containment, never identity: the pointer leaves for the element it is
      // now over, which is a BUTTON inside the flyout, not the flyout itself.
      flyout.addEventListener('mouseleave', function (/** @type {any} */ ev) {
        if (!btn.contains(ev.relatedTarget)) scheduleClose()
      })
      flyout.addEventListener('keydown', onFlyoutKey)
      if (takeFocus) focusFirst(flyout)
    }

    /** @param {boolean} refocus */
    function close(refocus) {
      cancelScheduledClose()
      if (!flyout) return
      flyout.remove()
      flyout = null
      btn.setAttribute('aria-expanded', 'false')
      if (refocus) btn.focus()
    }

    /** @param {any} ev */
    function onFlyoutKey(ev) {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault()
        moveFocus(flyout, ev.key === 'ArrowDown' ? 1 : -1)
      } else if (ev.key === 'ArrowLeft') {
        ev.preventDefault()
        ev.stopPropagation()
        close(true)
      } else if (ev.key === 'Escape') {
        // Escape closes the FLYOUT first; a second one reaches the document
        // listener and closes the menu.
        ev.stopPropagation()
        close(true)
      }
    }

    btn.addEventListener('mouseenter', function () { open(false) })
    btn.addEventListener('mouseleave', function (/** @type {any} */ ev) {
      if (!flyout || !flyout.contains(ev.relatedTarget)) scheduleClose()
    })
    btn.addEventListener('click', function (/** @type {Event} */ ev) {
      ev.stopPropagation()
      open(true)
    })
    btn.addEventListener('keydown', function (/** @type {any} */ ev) {
      if (ev.key !== 'ArrowRight' && ev.key !== 'Enter' && ev.key !== ' ') return
      ev.preventDefault()
      open(true)
    })
  }

  /** Beside the parent item, flipped to its other side when the right edge
   *  would put it off-screen and shifted up when its bottom would — the same
   *  placement care the menu itself takes, `capHeightToFit` included: a
   *  flyout with enough entries (Language, with everything the highlighter
   *  is registered for) can be taller than the window has room for even
   *  flush with the menu's own top, which no shift alone fixes (#118).
   *  @param {HTMLElement} btn @param {any} flyout */
  function placeSubmenu(btn, flyout) {
    flyout.style.top = Math.max(0, btn.offsetTop - 6) + 'px'
    var menuRect = /** @type {any} */ (btn.parentNode).getBoundingClientRect()
    var width = flyout.getBoundingClientRect().width
    if (menuRect.right + width > window.innerWidth - 8) {
      flyout.classList.add('sieve-context-submenu--flipped')
    }
    var top = flyout.offsetTop
    var bottom = menuRect.top + top + flyout.getBoundingClientRect().height
    if (bottom > window.innerHeight - 8) {
      top = Math.max(0, top - (bottom - (window.innerHeight - 8)))
      flyout.style.top = top + 'px'
    }
    capHeightToFit(flyout, menuRect.top + top)
  }

  /** @param {any} list */
  function focusFirst(list) {
    var first = list.querySelector('.ctx-item:not([disabled])')
    if (first) first.focus()
  }

  /** @param {any} list @param {number} step */
  function moveFocus(list, step) {
    var buttons = Array.prototype.slice.call(list.querySelectorAll('.ctx-item:not([disabled])'))
    if (!buttons.length) return
    var at = buttons.indexOf(document.activeElement)
    if (at === -1) { buttons[step > 0 ? 0 : buttons.length - 1].focus(); return }
    buttons[(at + step + buttons.length) % buttons.length].focus()
  }

  window.SieveContextMenu = {
    appendItems: function (items) {
      var menu = document.getElementById('sieve-context-menu')
      if (!menu) return
      appendItemsToMenu(menu, items)
      requestAnimationFrame(function () { repositionMenu(menu) })
    }
  }

  function hx(method, url, opts) {
    return window.htmx.ajax(method, url, opts || {})
  }

  function closeMenu() {
    var menu = document.getElementById('sieve-context-menu')
    if (menu) menu.remove()
  }

  // Middle-truncate a URL so a long one stays readable in a menu header without
  // dragging the menu across the window.
  function ellipsise(text, max) {
    var s = String(text || '')
    if (s.length <= max) return s
    var head = Math.ceil((max - 1) / 2)
    return s.slice(0, head) + '…' + s.slice(s.length - (max - 1 - head))
  }

  function tabItems(id) {
    return [
      { type: 'divider' },
      { icon: IC.close, label: 'Close Tab', action: function () {
        window.sieveWorkspace.close(id)
      }},
      { icon: IC.close, label: 'Close Others', action: function () {
        window.sieveWorkspace.closeOthers(id)
      }},
      { icon: IC.closeAll, label: 'Close All Tabs', action: function () {
        window.sieveWorkspace.closeAll()
      }},
    ]
  }

  function buildEditorItems(ctx, x, y) {
    var editor = ctx.editor
    // Markdown mode has no ProseMirror editor to build items from (editorPane
    // is null there) — no editor items rather than a throw.
    if (!editor) return []

    // Snap selection to right-click coordinates if click is outside current selection
    if (x != null && y != null) {
      var posAt = editor.view.posAtCoords({ left: x, top: y })
      if (posAt && posAt.pos != null) {
        var currentSel = editor.state.selection
        if (posAt.pos < currentSel.from || posAt.pos > currentSel.to) {
          editor.commands.setTextSelection(posAt.pos)
        }
      }
    }

    var state = editor.state
    var sel = state.selection
    var hasSelection = !sel.empty

    // The link the (snapped) selection is about, if any. The menu only speaks about
    // links that exist — `isNew` is Mod+K's creation path, not a menu affordance.
    var proseLink = ProseLink.forSelection(editor.view)
    if (proseLink && proseLink.isNew) proseLink = null

    /** @type {any} */ var targetNode = null
    /** @type {number|null} */ var targetPos = null
    var doc = state.doc
    var from = sel.from, to = sel.to
    var scanFrom = (from === to) ? Math.max(0, from - 1) : from
    var scanTo   = (from === to) ? Math.min(doc.content.size, to + 1) : to
    doc.nodesBetween(scanFrom, scanTo, function (node, pos) {
      if (!targetNode && (node.type.name === 'sieve-smart-image' || node.type.name === 'codeBlock' || node.type.name === 'image' || node.type.name === 'table')) {
        targetNode = node
        targetPos = pos
        return false
      }
    })

    var items = []
    var lens = mountLens(editor)

    // SPELLING LEADS THE MENU. The right-click above has already put the caret
    // in the word under the pointer, so the marks the LENS advertises for that
    // caret are the ones this menu is about: no position arithmetic here, and no
    // DOM read.
    //
    // The corrections are the MARK'S. Nothing here holds a dictionary, so a mark
    // that came with none offers no replacements — but it still offers the two
    // verbs about the word itself, because "this is a word" is an answer a
    // reader has for exactly the word nothing was close to.
    //
    // A menu is read at a glance: the first few corrections stand in the menu
    // and the rest hang in the flyout every other long list here uses.
    var spelling = spellingMark(lens)
    if (spelling) {
      var offers = spelling.suggestions || []
      var replace = function (word) {
        return { icon: IC.check, label: "Replace with '" + word + "'", action: function () {
          lens.replaceText(spelling, word)
          editor.commands.focus()
        }}
      }
      offers.slice(0, SPELLING_OFFERS).forEach(function (word) { items.push(replace(word)) })
      if (offers.length > SPELLING_OFFERS) {
        items.push({ label: 'More suggestions', children: offers.slice(SPELLING_OFFERS).map(replace) })
      }
      if (offers.length) items.push({ type: 'divider' })
      // Both verbs are the WORKSPACE's: a word accepted here is accepted in
      // every document open beside this one, so neither goes through the lens.
      items.push({ label: 'Ignore', action: function () {
        var verbs = spellVerbs()
        if (verbs) verbs.ignore(spelling.quote)
        editor.commands.focus()
      }})
      items.push({ label: 'Add to dictionary', action: function () {
        var verbs = spellVerbs()
        if (verbs) verbs.learn(spelling.quote)
        editor.commands.focus()
      }})
      items.push({ type: 'divider' })
    }

    if (hasSelection) {
      items.push({ icon: IC.copy, label: 'Copy', action: function () {
        var s = editor.state
        var text = s.doc.textBetween(s.selection.from, s.selection.to, '\n')
        if (text) navigator.clipboard.writeText(text).catch(console.error)
      }})
      items.push({ icon: IC.cut, label: 'Cut', action: function () {
        var s = editor.state
        var text = s.doc.textBetween(s.selection.from, s.selection.to, '\n')
        if (text) navigator.clipboard.writeText(text).then(function () {
          editor.commands.deleteSelection()
          editor.commands.focus()
        }).catch(console.error)
      }})
    }

    // Paste is a CALLER of the paste path, never a second mechanism: recognising a
    // block's serialized form is the pipeline's job, and Go's ai-block processor
    // claims its own fence.
    items.push({ icon: IC.paste, label: 'Paste', action: function () {
      editor.commands.focus()
      navigator.clipboard.readText().then(function (text) {
        if (!text) return
        var host = editor.sieveHost
        if (host && typeof host.pasteText === 'function') { host.pasteText(text); return }
        editor.commands.insertContent(text)
      }).catch(function (err) {
        console.error('[context-menu] clipboard read failed, falling back to execCommand', err)
        editor.commands.focus()
        document.execCommand('paste')
      })
    }})

    if (hasSelection) {
      items.push({ icon: IC.trash, label: 'Delete', action: function () {
        editor.commands.deleteSelection()
      }})
    }

    items.push({ icon: IC.selectAll, label: 'Select All', action: function () {
      editor.commands.focus()
      editor.commands.selectAll()
    }})

    // In WYSIWYG a link renders as its label alone, so the href is invisible without
    // markdown mode; the header is the cheapest visibility win. Both verbs delegate
    // to ProseLink, the same object Mod+K drives.
    if (proseLink) {
      items.push({ type: 'divider' })
      items.push({ type: 'header', label: ellipsise(proseLink.href, 52) })
      items.push({ icon: IC.edit, label: 'Edit Link…', action: function () { proseLink.edit() }})
      items.push({ icon: IC.copy, label: 'Copy Link', action: function () { proseLink.copy() }})
    }

    // An attached document and its `@Title` token are ONE object, so removing
    // either removes both — and the token's own menu is where that is said. The
    // title comes from the MARK under the caret, which is drawn from the manifest,
    // so a mount holding no manifest marks nothing and is offered nothing: the
    // gate is the data, not a branch.
    var mention = (lens && typeof lens.mentionTitleAt === 'function')
      ? lens.mentionTitleAt(sel.from) : null
    if (mention && lens && typeof lens.requestDetach === 'function') {
      items.push({ type: 'divider' })
      items.push({ icon: IC.close, label: 'Remove Attachment', action: function () {
        lens.requestDetach(mention)
      }})
    }

    // TABLE — the stock verbs, offered wherever a table is. Rearranging one is
    // EDITING, not authoring, so this asks nothing of the mount beyond holding
    // the table the caret is in.
    var table = enclosingNode(sel.$from, { table: true })
    if (table) {
      items.push({ type: 'divider' })
      items.push({ type: 'header', label: 'Table' })
      items.push({ icon: IC.table, label: 'Row', children: [
        { icon: IC.tableRowPlusTop, label: 'Add Above', action: paneCommand(editor, 'addRowBefore') },
        { icon: IC.tableRowPlusBottom, label: 'Add Below', action: paneCommand(editor, 'addRowAfter') },
        { icon: IC.tableRowRemove, label: 'Delete Row', action: paneCommand(editor, 'deleteRow') },
      ]})
      items.push({ icon: IC.table, label: 'Column', children: [
        { icon: IC.tableColumnPlusLeft, label: 'Add Left', action: paneCommand(editor, 'addColumnBefore') },
        { icon: IC.tableColumnPlusRight, label: 'Add Right', action: paneCommand(editor, 'addColumnAfter') },
        { icon: IC.tableColumnRemove, label: 'Delete Column', action: paneCommand(editor, 'deleteColumn') },
      ]})
      // GFM pipe markdown requires a header row (tiptap-markdown's table
      // serializer falls back to a raw HTML dump without one — #118), so the
      // OFF direction is deliberately gone: a table that already has a header
      // offers no entry here at all, and `toggleHeaderRow` only ever ADDS one.
      if (!tableHasHeaderRow(table.node)) {
        items.push({ icon: IC.tableHeader, label: 'Add Header Row', action: paneCommand(editor, 'toggleHeaderRow') })
      }
      items.push({ icon: IC.trash, label: 'Delete Table', cls: 'ctx-item--danger',
        action: paneCommand(editor, 'deleteTable') })
    }

    // The fence's language, as the discoverable route to what `{fence:go` types.
    var fence = enclosingNode(sel.$from, { codeBlock: true })
    if (fence) {
      items.push({ type: 'divider' })
      items.push({ icon: IC.code, label: 'Language', children: languageItems(editor, fence) })
    }

    // INSERT items are genuine inserts: they open their dialog and create a NEW block,
    // consuming nothing. They deliberately do NOT vary with the link under the cursor
    // — converting a link is a Convert offer (see describeSource below).
    //
    // THE MENU AND THE `{` PICKER READ ONE CATALOG, filtered by ONE rule, so a
    // mount cannot offer an entry in one place and refuse it in the other.
    var inserts = menuMacros(editor)
    if (inserts.length) {
      items.push({ type: 'divider' })
      inserts.forEach(function (macro) {
        items.push({ icon: macro.icon, label: 'Insert ' + macro.label, action: function () {
          macro.run(new MenuMacroHost(editor.sieveHost), NO_TOKEN)
        }})
      })
    }

    // The `==` mark names an ask TARGET — a coordinate a question answers about.
    // A mount that mints no block has nothing for it to be the target OF, so the
    // verb is not offered there.
    var isHighlighted = editor.isActive('highlight')
    if (mountHoldsBlocks(editor) && (hasSelection || isHighlighted)) {
      var label = isHighlighted ? 'Unhighlight Target' : 'Highlight Target'
      items.push({ icon: IC.highlight, label: label, action: function () {
        if (isHighlighted) {
          editor.chain().extendMarkRange('highlight').unsetMark('highlight').focus().run()
          return
        }
        // applyTargetHighlight takes an explicit range. The right-click already set the
        // selection, so its extent IS the target being marked — pass it explicitly.
        applyTargetHighlight(editor, { from: editor.state.selection.from, to: editor.state.selection.to })
        editor.commands.focus()
      }})
    }

    // Ask AI / Explain only fire the event; the editor's handler owns ALL the business
    // logic (target highlight + focus + buildAiContext + run), so menu, toolbar and
    // keyboard shortcut behave identically. They ANSWER INTO the document, so a
    // mount that holds no blocks is not offered them: there is no Ask inside an Ask.
    if (mountHoldsBlocks(editor)) {
      items.push({ type: 'divider' })
      items.push({ icon: IC.sparkle, label: 'Ask AI...', action: function () {
        document.dispatchEvent(new CustomEvent('sieve:ai-ask'))
      }})
      items.push({ icon: IC.info, label: 'Explain', action: function () {
        document.dispatchEvent(new CustomEvent('sieve:ai-explain'))
      }})
    }

    // Native source → Sieve block conversion. A native node IS its own content, so
    // converting it is an in-place TRANSFORM — the backend decides additive-vs-replace.
    // extractContentEntryFromEditor reads whatever DOM element was clicked; the menu
    // has no DOM event, so the same target is reconstructed from the click coords via
    // elementFromPoint and passed as a synthetic { target }. It reads nothing else.
    //
    // describeSource only says WHICH source; detection decides the targets. A link is
    // the one source that is a RANGE inside a block rather than a block: it has no id,
    // so it carries `sourceRange` and the editor plays the offer back by consuming it.
    function describeSource() {
      var nativeConvertible = { codeBlock: true, image: true }
      if (targetNode && nativeConvertible[targetNode.type.name] && targetPos !== null &&
          x != null && y != null) {
        var domEl = document.elementFromPoint(x, y)
        if (!domEl) return null
        var res = NodeViewRegistry.extractContentEntryFromEditor({ target: domEl }, editor)
        if (!res || !res.entries) return null
        return {
          sourceNode: targetNode,
          sourceKind: targetNode.type.name,
          entries: res.entries,
          blockId: (targetNode.attrs && targetNode.attrs.id)
            ? targetNode.attrs.id
            : enclosingBlockId(editor.state.doc, targetPos),
          sourcePos: targetPos,
          extractSourceLabel: res.extractSourceLabel,
        }
      }
      if (proseLink && proseLink.href) {
        return {
          sourceNode: null,
          // 'prose' excludes the prose processor from its own offers — "Embed in Document"
          // is meaningless for something already embedded in the document.
          sourceKind: 'prose',
          entries: proseLink.contentEntries(),
          blockId: enclosingBlockId(editor.state.doc, proseLink.from),
          sourceRange: proseLink.range,
          extractSourceLabel: 'link',
        }
      }
      return null
    }

    var source = describeSource()
    if (source) {
      source.editor = editor.sieveHost || null
      detectAndAppendExtractions(source)
    }

    // Delete — only for block-level native nodes. Paragraph text uses normal keyboard
    // deletion; this is for structured blocks with no other obvious affordance.
    // A table the caret is INSIDE is already deletable by its own section's named
    // verb, and one act needs one entry.
    var blockNodeTypes = { codeBlock: true, table: true }
    if (targetNode && blockNodeTypes[targetNode.type.name] && targetPos !== null &&
        !(table && targetNode.type.name === 'table')) {
      ;(function (node, pos) {
        items.push({ type: 'divider' })
        items.push({ icon: IC.trash, label: 'Delete Block', cls: 'ctx-item--danger', action: function () {
          editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize))
          editor.commands.focus()
        }})
      })(targetNode, targetPos)
    }

    // Emptying the draft is the mount's act, not the lens's — a draft is a
    // lifetime, and starting another one retires this lens with it. Undo-less by
    // construction, hence the label and the danger styling.
    if (lens && typeof lens.requestClear === 'function') {
      items.push({ type: 'divider' })
      items.push({ icon: IC.trash, label: 'Clear Draft', cls: 'ctx-item--danger', action: function () {
        lens.requestClear()
      }})
    }

    return items
  }

  function buildAiBlockItems(ctx) {
    var editor = ctx.editor, getPos = ctx.getPos, n = ctx.node

    function yaml() {
      return serializeNode(editor, n)
    }

    function del() {
      if (typeof getPos === 'function') {
        var pos = getPos()
        editor.view.dispatch(editor.state.tr.delete(pos, pos + n.nodeSize))
      }
    }

    var isError = n.attrs.status === 'TIMEOUT' || n.attrs.status === 'PENDING'

    return [
      { icon: IC.copy, label: 'Copy', action: function () {
        var md = yaml()
        if (!md) { console.warn('[sieve] ai-block serialize returned empty; copy aborted'); return }
        navigator.clipboard.writeText(md).catch(console.error)
      }},
      { icon: IC.cut, label: 'Cut', action: function () {
        var md = yaml()
        if (!md) { console.warn('[sieve] ai-block serialize returned empty; copy aborted'); return }
        navigator.clipboard.writeText(md).then(del).catch(console.error)
      }},
      { icon: IC.trash, label: 'Delete', action: del },
      { type: 'divider' },
      { icon: IC.sparkle, label: 'Ask AI...', action: function () {
        // Re-assert node selection so buildAiContext sees this AI block as context.
        if (typeof getPos === 'function') editor.chain().focus().setNodeSelection(getPos()).run()
        else editor.commands.focus()
        document.dispatchEvent(new CustomEvent('sieve:ai-ask'))
      }},
      { icon: IC.info, label: 'Explain', action: function () {
        if (typeof getPos === 'function') editor.chain().focus().setNodeSelection(getPos()).run()
        else editor.commands.focus()
        document.dispatchEvent(new CustomEvent('sieve:ai-explain'))
      }},
      { type: 'divider' },
      { icon: IC.refresh, label: isError ? 'Retry' : 'Replay', action: function () {
        document.dispatchEvent(new CustomEvent('sieve:ai-retry', {
          detail: { id: n.attrs.id, question: n.attrs.question, ref: n.attrs.ref, type: n.attrs.type }
        }))
      }},
    ]
  }

  function buildNoteItems(ctx) {
    var id = ctx.id, name = ctx.name, intent = ctx.intent, isTab = ctx.isTab
    var items = []

    if (name) items.push({ type: 'header', label: name })

    items.push({ icon: IC.smartFile, label: 'Smart File', action: function () {
      window.SieveAI && window.SieveAI.smartFile(id)
    }})
    items.push({ icon: IC.smartMeta, label: 'Smart Metadata', action: function () {
      window.SieveAI && window.SieveAI.smartMetadata(id)
    }})

    items.push({ type: 'divider' })

    items.push({ icon: IC.keep, label: 'Mark as Keep',
      cls: 'ctx-item--keep' + (intent === 'keep' ? ' ctx-item--active' : ''),
      action: function () {
        hx('POST', '/api/sidebar/intent?id=' + encodeURIComponent(id) + '&value=keep', { target: '#htmx-sidebar', swap: 'innerHTML' })
      }
    })
    items.push({ icon: IC.markTrash, label: 'Mark as Trash',
      cls: 'ctx-item--trash' + (intent === 'trash' ? ' ctx-item--active' : ''),
      action: function () {
        hx('POST', '/api/sidebar/intent?id=' + encodeURIComponent(id) + '&value=trash', { target: '#htmx-sidebar', swap: 'innerHTML' })
      }
    })
    if (intent) {
      items.push({ icon: IC.clearIntent, label: 'Clear Intent', action: function () {
        hx('POST', '/api/sidebar/intent?id=' + encodeURIComponent(id) + '&value=', { target: '#htmx-sidebar', swap: 'innerHTML' })
      }})
    }

    items.push({ type: 'divider' })

    items.push({ icon: IC.edit, label: 'Rename...', action: function () {
      hx('GET', '/ui/views/sidebar/dialog/rename?id=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(name) + '&type=note',
        { target: '#rename-dialog-content', swap: 'innerHTML' }
      ).then(function () { document.getElementById('rename-dialog').showModal() })
    }})
    items.push({ icon: IC.folder, label: 'Show in Files', action: function () {
      window.sieveShowInFiles && window.sieveShowInFiles(id)
    }})
    items.push({ icon: IC.trash, label: 'Delete Note...', cls: 'ctx-item--danger', action: function () {
      hx('GET', '/ui/views/sidebar/dialog/delete?id=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(name) + '&type=note',
        { target: '#delete-dialog-content', swap: 'innerHTML' }
      ).then(function () { document.getElementById('delete-dialog').showModal() })
    }})

    if (isTab) items = items.concat(tabItems(id))
    return items
  }

  function buildFolderItems(ctx) {
    var id = ctx.id, name = ctx.name
    var items = []

    if (name) items.push({ type: 'header', label: name })

    items.push({ icon: IC.edit, label: 'Rename...', action: function () {
      hx('GET', '/ui/views/sidebar/dialog/rename?id=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(name) + '&type=folder',
        { target: '#rename-dialog-content', swap: 'innerHTML' }
      ).then(function () { document.getElementById('rename-dialog').showModal() })
    }})
    items.push({ icon: IC.folder, label: 'Show in Files', action: function () {
      window.sieveShowInFiles && window.sieveShowInFiles(id)
    }})

    items.push({ type: 'divider' })

    items.push({ icon: IC.trash, label: 'Delete Folder...', cls: 'ctx-item--danger', action: function () {
      hx('GET', '/ui/views/sidebar/dialog/delete?id=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(name) + '&type=folder',
        { target: '#delete-dialog-content', swap: 'innerHTML' }
      ).then(function () { document.getElementById('delete-dialog').showModal() })
    }})

    return items
  }

  function buildPromptItems(ctx) {
    var id = ctx.id, name = ctx.name, isVirtual = ctx.isVirtual, isTab = ctx.isTab
    var items = []

    if (name) items.push({ type: 'header', label: name })

    items.push({ icon: IC.edit, label: 'Edit Prompt', action: function () {
      window.sieveWorkspace.open(id)
    }})

    if (!isVirtual) {
      items.push({ icon: IC.refresh, label: 'Reset to Default', cls: 'ctx-item--danger', action: function () {
        hx('POST', '/api/sidebar/revert-prompt?id=' + encodeURIComponent(id), { swap: 'none' })
      }})
    }

    if (isTab) items = items.concat(tabItems(id))
    return items
  }

  document.addEventListener('sieve:contextmenu', function (e) {
    var d = e.detail, ctx = d.context, items
    switch (ctx.type) {
      case 'editor':    items = buildEditorItems(ctx, d.x, d.y); break
      case 'aiBlock':   items = buildAiBlockItems(ctx); break
      case 'note':      items = buildNoteItems(ctx); break
      case 'folder':    items = buildFolderItems(ctx); break
      case 'prompt':    items = buildPromptItems(ctx); break
      case 'sieveBlock': items = ctx.items || []; break
      default: return
    }
    // A context with nothing to offer — markdown mode's editor among them —
    // gets NO menu, not an empty bordered box.
    if (!items.length) { closeMenu(); return }
    render(d.x, d.y, items)
  })

  document.addEventListener('click', function (e) {
    var menu = document.getElementById('sieve-context-menu')
    if (menu && !menu.contains(e.target)) menu.remove()
  })
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeMenu()
  })
