// focus-context.js — ephemeral "where was I" capture/restore for the editor.
//
// App-level VIEW state, never serialised: it answers "when I tab into a transient
// surface (the Ask box) and back, put me exactly where I was." Three shapes:
//   { kind:'editor',   from, to }        — the main ProseMirror text selection
//   { kind:'block',    blockId, token }  — inside a Sieve block's inner editor
//   { kind:'markdown', start, end }      — the raw markdown textarea
//
// Block capture is GENERIC via the shared `.sieve-block__edit` + `[data-id]`
// convention, so code, diagram-in-edit, and any future block work with zero
// per-renderer code. A flavour with a richer inner surface (multiple panes, a
// terminal, …) may OPT IN by setting `host.__sieveFocus = { capture(), restore(token) }`
// on its `[data-id]` host element — the lazy per-flavour seam. We discover it if
// present, else fall back to the textarea's selectionStart/End. Nothing here
// touches YAML: caret offsets are a nicety, not knowledge.
;(function () {
  'use strict'
  var T = (typeof window !== 'undefined' && window.TipTap) ? window.TipTap : (window.TipTap = {})

  function blockHostOf(el) {
    return el && el.closest ? el.closest('[data-id]') : null
  }

  // Capture the current focus location as a restorable token, or null.
  function captureFocusContext(editor) {
    var ae = (typeof document !== 'undefined') ? document.activeElement : null

    // Inside a Sieve block's inner editor.
    if (ae && ae.classList && ae.classList.contains('sieve-block__edit')) {
      var host = blockHostOf(ae)
      if (host) {
        var hook = host.__sieveFocus
        var token = (hook && typeof hook.capture === 'function')
          ? hook.capture()
          : { start: ae.selectionStart, end: ae.selectionEnd }
        return { kind: 'block', blockId: host.getAttribute('data-id'), token: token }
      }
    }

    // Raw markdown mode.
    var mdTa = (typeof document !== 'undefined') ? document.querySelector('.markdown-raw') : null
    if (mdTa && ae === mdTa) {
      return { kind: 'markdown', start: mdTa.selectionStart, end: mdTa.selectionEnd }
    }

    // Main ProseMirror editor.
    if (editor) {
      var sel = editor.state.selection
      return { kind: 'editor', from: sel.from, to: sel.to }
    }
    return null
  }

  // Restore focus + caret from a token. Falls back gracefully if the target is
  // gone (block flipped to a non-edit view, torn down, etc).
  function restoreFocusContext(editor, ctx) {
    if (!ctx) { if (editor) editor.view.focus(); return }

    if (ctx.kind === 'block') {
      var host = document.querySelector('[data-id="' + ctx.blockId + '"]')
      if (host) {
        var hook = host.__sieveFocus
        if (hook && typeof hook.restore === 'function') { hook.restore(ctx.token); return }
        var ta = host.querySelector('.sieve-block__edit')
        if (ta) {
          ta.focus()
          var tk = ctx.token || {}
          var len = ta.value.length
          var s = Math.min(tk.start || 0, len)
          var e = Math.min(tk.end != null ? tk.end : s, len)
          try { ta.selectionStart = s; ta.selectionEnd = e } catch (_) {}
          return
        }
      }
      if (editor) editor.view.focus()   // block/textarea gone → fall back
      return
    }

    if (ctx.kind === 'markdown') {
      var md = document.querySelector('.markdown-raw')
      if (md) {
        md.focus()
        var mlen = md.value.length
        try { md.selectionStart = Math.min(ctx.start || 0, mlen); md.selectionEnd = Math.min(ctx.end != null ? ctx.end : ctx.start || 0, mlen) } catch (_) {}
      }
      return
    }

    // editor
    if (editor) {
      editor.view.focus()
      // Re-resolve by position against the CURRENT doc: a captured Selection is
      // bound to its doc instance and would throw if anything edited in between.
      var size = editor.state.doc.content.size
      var from = Math.min(ctx.from, size), to = Math.min(ctx.to, size)
      try { editor.commands.setTextSelection({ from: from, to: to }) } catch (_) {}
    }
  }

  T.captureFocusContext = captureFocusContext
  T.restoreFocusContext = restoreFocusContext
})()
