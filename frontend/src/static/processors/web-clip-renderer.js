// web-clip-renderer.js — Web Clip block renderer.
// Registers window.TipTap.registerSieveRenderer('web-clip', WebClipRenderer)

import { renderMarkdown, applyHighlighting, isJobStale } from '../base/fenced-block-base.js'

;(function () {
  'use strict'

  var T = window.TipTap

  function isStale(createdAt, id) {
    return isJobStale(createdAt, id)
  }

  function makeRetryBtn(blkId) {
    var btn = document.createElement('button')
    btn.className = 'web-clip-block__retry'
    btn.textContent = 'Retry'
    btn.addEventListener('click', function () {
      document.dispatchEvent(new CustomEvent('sieve:block-retry', {
        detail: { id: blkId }
      }))
    })
    return btn
  }

  // Returns a human-readable summary of a web-clip node for AI context (Rule 14).
  function webClipSummary(n) {
    var parts = []
    if (n.attrs.title)   parts.push('**' + n.attrs.title + '**')
    if (n.attrs.source)  parts.push('Source: ' + n.attrs.source)
    if (n.attrs.content) parts.push(n.attrs.content.trim())
    return parts.join('\n\n')
  }

  var WebClipRenderer = {

    getIcon: function() { return window.SieveIcons && window.SieveIcons.externalLink },
    getFriendlyName: function(node) { return 'Web Clip' },

    // TITLE (metadata) = the title; CONTENT (data) = the fetched article. The
    // interactive source link stays as chrome (an <a href> the renderer builds).
    titleProvider: 'title',
    contentProvider: 'content',

    getInitialContentHTML: function() { return '<p></p>' },

    asContentEntry: function(node) {
      if (!node.attrs.source) return null
      return [{ mimeType: 'text/uri-list', content: node.attrs.source }]
    },

    getExtractionMenuItems: function(sourceNode, entries, defaultAction, opts) {
      var IC = window.SieveIcons || {}
      // "Upgrade" only when REPLACING a native source in place. Extracting a link out
      // of an existing sieve block is additive — the source block survives — so it must
      // read "Extract", matching the framework's verb for every other target kind.
      var verb = (opts && opts.operation === 'transform') ? 'Upgrade to' : 'Extract as'
      return [
        {
          icon: IC['web-clip'] || IC.code,
          label: verb + ' Web Clip (Fetch)',
          action: function() { defaultAction({ mode: 'fetch' }) }
        },
        {
          icon: IC['web-clip'] || IC.code,
          label: verb + ' Web Clip (Summarise)',
          action: function() { defaultAction({ mode: 'summarise' }) }
        }
      ]
    },

    // Read-only container: arrows treat it as a single caret stop.
    interactionPolicy: { caretStop: true },

    nodeConfig: {
      atom: false,
      selectable: true,
      draggable: false,
      group: 'block',
      inline: false,
      content: 'block+'
    },

    attrs: {
      source:      { default: '',      parseHTML: function (el) { return el.getAttribute('data-source')       || '' } },
      title:       { default: null,    parseHTML: function (el) { return el.getAttribute('data-title')        || null } },
      mode:        { default: 'fetch', parseHTML: function (el) { return el.getAttribute('data-mode')         || 'fetch' } },
      model:       { default: null,    parseHTML: function (el) { return el.getAttribute('data-model')        || null } },
      completedAt: { default: null,    parseHTML: function (el) { return el.getAttribute('data-completed-at') || null } },
      content:     { default: null,    parseHTML: function (el) { return el.getAttribute('data-content')      || null } },
      error:       { default: null,    parseHTML: function (el) { return el.getAttribute('data-error')        || null } },
    },

    parseAttrs: function (data) {
      return {
        source:      data.source      || '',
        title:       data.title       || null,
        mode:        data.mode        || 'fetch',
        model:       data.model       || null,
        completedAt: data.completedAt || null,
        content:     data.content     || null,
        error:       data.error       || null,
      }
    },

    makeNodeView: function (node, editor, getPos) {

      var nodeTypeName = 'sieve-web-clip'
      var dom = document.createElement('div')
      dom.className = 'web-clip-block'
      dom.setAttribute('draggable', 'false')
      dom.setAttribute('data-id', node.attrs.id || '')
      dom.style.userSelect = 'text'

      // renderEl holds the chrome (badge, source link, status/spinner/retry) and is
      // cleared on each render(). It is contentEditable=false — like ai-block's badge
      // and question — so the caret can never land in it.
      var renderEl = document.createElement('div')
      renderEl.className = 'web-clip-block__render'
      renderEl.contentEditable = 'false'
      dom.appendChild(renderEl)

      // contentDOM is a VISIBLE, ProseMirror-owned region holding the fetched/summarised
      // markdown as real document nodes — a direct analog of ai-block's response body.
      // ProseMirror tracks it by reference; it is never removed from dom.
      var contentDOM = document.createElement('div')
      contentDOM.className = 'web-clip-block__content tiptap'
      dom.appendChild(contentDOM)

      dom.addEventListener('dragstart', function (e) { e.preventDefault() })
      dom.addEventListener('click', function (e) {
        var a = e.target.closest ? e.target.closest('a') : null
        if (a && a.href) {
          // Prevent Wails from navigating the internal webview.
          // Note: Ctrl+Click is already handled by the global capture in editor.js
          e.preventDefault()
        }
      })

      // Reverse chain highlight: when hovering the web-clip, light up any AI blocks
      // that reference it via data-ai-ref. Forward direction (AI → web-clip) is in ai-block-extension.js.
      function applyReverseChain(action) {
        var id = dom.getAttribute('data-id') || ''
        if (!id) return
        document.querySelectorAll('.ai-block').forEach(function (el) {
          var refs = (el.getAttribute('data-ai-ref') || '').split(',').map(function (r) { return r.trim() })
          if (refs.indexOf(id) !== -1) el.classList[action]('ai-block--chain-active')
        })
      }
      dom.addEventListener('mouseenter', function () { applyReverseChain('add') })
      dom.addEventListener('mouseleave', function () { applyReverseChain('remove') })

      function render(n) {
        // Clear only renderEl — contentDOM stays permanently attached to dom.
        renderEl.innerHTML = ''
        dom.setAttribute('data-id', n.attrs.id || '')

        var outerBadge = document.createElement('span')
        outerBadge.className = 'web-clip-block__badge'
        outerBadge.textContent = 'WEB CLIP'
        renderEl.appendChild(outerBadge)

        var attrs = n.attrs
        var status = attrs.status || 'PENDING'
        var domain = attrs.source || ''
        var modeLabel = attrs.mode === 'summarise' ? 'Summarising' : 'Fetching'
        var completeModeLabel = attrs.mode === 'summarise' ? 'Summarised' : 'Fetched'

        var header = document.createElement('div')
        header.className = 'web-clip-block__header'

        if (status === 'PENDING' || status === 'DISPATCHED') {
          var stale = isStale(attrs.createdAt, attrs.id)
          if (stale) {
            header.innerHTML = '<span class="web-clip-block__icon web-clip-block__icon--warn">⚠</span>' +
              '<span class="web-clip-block__label">' + modeLabel.replace('ing', '') + ' interrupted — ' + domain + '</span>'
            renderEl.appendChild(header)
            renderEl.appendChild(makeRetryBtn(attrs.id))
          } else {
            header.innerHTML = '<span class="web-clip-block__spinner"></span>' +
              '<span class="web-clip-block__label">' + modeLabel + ' from ' + domain + '…</span>'
            renderEl.appendChild(header)
          }

        } else if (status === 'COMPLETE') {
          var statusEl = document.createElement('span')
          statusEl.className = 'web-clip-block__status'
          statusEl.textContent = completeModeLabel + ' — '
          header.appendChild(statusEl)
          var srcLink = document.createElement('a')
          srcLink.className = 'web-clip-block__source-link'
          srcLink.href = attrs.source || ''
          srcLink.textContent = attrs.source || domain
          srcLink.target = '_blank'
          srcLink.rel = 'noopener noreferrer'
          header.appendChild(srcLink)
          renderEl.appendChild(header)
          // The title + fetched body are rendered into contentDOM as real PM nodes
          // via the markdownProvider seam (title folds in as an h1), not here — only
          // the interactive source link stays as header chrome.

        } else if (status === 'TIMEOUT') {
          header.innerHTML = '<span class="web-clip-block__icon web-clip-block__icon--warn">⚠</span>' +
            '<span class="web-clip-block__label">Timed out — ' + domain + '</span>'
          renderEl.appendChild(header)
          renderEl.appendChild(makeRetryBtn(attrs.id))

        } else if (status === 'ERROR') {
          var errMsg = (attrs.error || 'Unknown error').trim()
          header.innerHTML = '<span class="web-clip-block__icon web-clip-block__icon--error">✕</span>' +
            '<span class="web-clip-block__label">' + errMsg + '</span>'
          renderEl.appendChild(header)
          renderEl.appendChild(makeRetryBtn(attrs.id))
        }
      }

      render(node)

      return {
        dom: dom,
        contentDOM: contentDOM,
        update: function (updatedNode) {
          if (updatedNode.type.name !== nodeTypeName) return false
          node = updatedNode
          render(updatedNode)
          // Body (attrs.content) is synced into contentDOM by the framework markdown seam.
          return true
        },
        ignoreMutation: function (mutation) {
          return !contentDOM.contains(mutation.target)
        },
      }
    },

    // ── Plugins ───────────────────────────────────────────────────────────────

    buildPlugins: function(nodeType) {
      var Plugin = window.TipTap.Plugin

      function isInside(state, from, to) {
        var inside = false
        state.doc.nodesBetween(from, to, function(node) {
          if (node.type === nodeType) inside = true
        })
        return inside
      }

      return [
        new Plugin({
          props: {
            handleTextInput: function(view, from, to, text) {
              return isInside(view.state, from, to)
            },
            handleKeyDown: function(view, event) {
              if (event.key === 'Backspace' || event.key === 'Delete' || event.key === 'Enter') {
                return isInside(view.state, view.state.selection.from, view.state.selection.to)
              }
              if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
                return isInside(view.state, view.state.selection.from, view.state.selection.to)
              }
              return false
            },
            handlePaste: function(view, event, slice) {
              return isInside(view.state, view.state.selection.from, view.state.selection.to)
            },
            handleDrop: function(view, event, slice, moved) {
              var pos = view.posAtCoords({ left: event.clientX, top: event.clientY })
              if (pos && isInside(view.state, pos.pos, pos.pos)) return true
              return false
            }
          }
        })
      ]
    },

    buildContextMenuItems: function ({ node }) {
      var status = node.attrs.status || 'PENDING'
      var isComplete = status === 'COMPLETE'

      var domain = ''
      try { domain = new URL(node.attrs.source || '').hostname } catch (_) { domain = node.attrs.source || '' }
      var modeLabel = node.attrs.mode === 'summarise' ? 'Summarised' : 'Fetched'
      var headerLabel = isComplete ? (modeLabel + ' from ' + domain) : domain

      // Copy/Cut/Delete are intentionally NOT here. Highlighted text copies natively;
      // whole-block copy + the universal Delete come from the framework. The old
      // bespoke Copy wrote the entire block's YAML instead of the selection.
      return [{ type: 'header', label: headerLabel }]
    },

    buildAiCtx: function (node) {
      return { contextLabel: 'Web Clip' }
    },
  }

  T.registerSieveRenderer('web-clip', WebClipRenderer)
})()
