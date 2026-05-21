// ai-block-legacy-extension.js — parse-only shim for the old [!ai]…[!ai-end] format.
// Produces <div data-type="aiBlock"> elements that AiBlock.parseHTML picks up.
// No serializer — the canonical AiBlock serializer writes fenced YAML on every save.
// Remove this file once GrepAllDocuments("\[!ai\]") returns zero.

;(function () {
  'use strict'

  var T = window.TipTap
  var Extension = T.Extension

  // Simple DOM-to-plain-text helper that preserves paragraph breaks for the
  // response migration. Perfect fidelity isn't required — blocks will be
  // re-rendered as YAML on next save and users can re-ask if needed.
  function domToText(el) {
    var parts = []
    Array.from(el.childNodes).forEach(function (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(node.textContent)
      } else if (node.tagName === 'P' || node.tagName === 'DIV') {
        var inner = domToText(node)
        if (inner.trim()) parts.push(inner)
      } else if (node.tagName === 'BR') {
        parts.push('\n')
      } else if (node.tagName === 'PRE') {
        var code = node.querySelector('code')
        var lang = code ? (code.className.replace(/language-/, '') || '') : ''
        parts.push('```' + lang + '\n' + (code ? code.textContent : node.textContent) + '\n```')
      } else if (node.tagName === 'UL') {
        Array.from(node.children).forEach(function (li) {
          parts.push('- ' + domToText(li).trim())
        })
      } else if (node.tagName === 'OL') {
        Array.from(node.children).forEach(function (li, i) {
          parts.push((i + 1) + '. ' + domToText(li).trim())
        })
      } else if (/^H[1-6]$/.test(node.tagName)) {
        var level = parseInt(node.tagName[1])
        parts.push('#'.repeat(level) + ' ' + node.textContent.trim())
      } else if (node.tagName === 'HR') {
        parts.push('---')
      } else if (node.tagName === 'STRONG' || node.tagName === 'B') {
        parts.push('**' + domToText(node) + '**')
      } else if (node.tagName === 'EM' || node.tagName === 'I') {
        parts.push('_' + domToText(node) + '_')
      } else if (node.tagName === 'CODE' && node.parentElement.tagName !== 'PRE') {
        parts.push('`' + node.textContent + '`')
      } else {
        var inner = domToText(node)
        if (inner) parts.push(inner)
      }
    })
    return parts.join('\n')
  }

  var AiBlockLegacy = Extension.create({
    name: 'aiBlockLegacy',

    addStorage() {
      return {
        markdown: {
          parse: {
            updateDOM: function (element) {
              function processEl(el) {
                var changed = true
                while (changed) {
                  changed = false
                  var children = Array.from(el.children)
                  for (var i = 0; i < children.length; i++) {
                    var child = children[i]
                    if (child.tagName !== 'P') continue
                    var text = (child.textContent || '').trim()
                    if (!text.startsWith('[!ai]') || text.startsWith('[!ai-end]')) continue

                    var endIdx = -1
                    for (var j = i + 1; j < children.length; j++) {
                      if (children[j].tagName === 'P' && (children[j].textContent || '').startsWith('[!ai-end]')) {
                        endIdx = j; break
                      }
                    }
                    if (endIdx === -1) break

                    var idMatch  = text.match(/id="([^"]+)"/)
                    var refMatch = text.match(/ref="([^"]+)"/)
                    var thinking = text.includes('thinking="true"')

                    // Collect inner nodes between the [!ai] and [!ai-end] paragraphs
                    var inner = []
                    for (var k = i + 1; k < endIdx; k++) inner.push(children[k])

                    // The first non-empty paragraph is the question (contains Ask:/Explain:).
                    // Everything after it is the response. The old format used --- inside the
                    // response body as a visual divider — NOT as a question/response separator.
                    var firstNonEmpty = inner.findIndex(function (n) {
                      return n.tagName === 'P' && (n.textContent || '').trim() !== ''
                    })
                    var questionNodes = firstNonEmpty !== -1 ? [inner[firstNonEmpty]] : []
                    var responseNodes = firstNonEmpty !== -1 ? inner.slice(firstNonEmpty + 1) : inner

                    // Extract question text and detect type from prefix
                    var questionText = questionNodes.map(function (n) { return n.textContent || '' }).join(' ').trim()
                    var blockType = 'ASK'
                    if (/^\*{0,3}Explain:\*{0,3}\s*/i.test(questionText)) {
                      blockType = 'EXPLAIN'
                      questionText = questionText.replace(/^\*{0,3}Explain:\*{0,3}\s*/i, '').trim()
                    } else {
                      questionText = questionText.replace(/^\*{0,3}Ask:\*{0,3}\s*/i, '').trim()
                    }

                    // Extract response as markdown text
                    var responseContainer = document.createElement('div')
                    responseNodes.forEach(function (n) { responseContainer.appendChild(n.cloneNode(true)) })
                    var responseText = domToText(responseContainer).trim()

                    // For EXPLAIN blocks with no HR, everything landed in questionText —
                    // but it's really the response. Promote it.
                    if (blockType === 'EXPLAIN' && !responseText && questionText) {
                      responseText = questionText
                      questionText = ''
                    }

                    // Determine status
                    var status = thinking || responseText.includes('(thinking…)') ? 'PENDING' : 'COMPLETE'
                    if (status === 'PENDING') responseText = ''

                    // Build the canonical aiBlock div
                    var div = document.createElement('div')
                    div.setAttribute('data-type', 'aiBlock')
                    div.setAttribute('data-id', idMatch ? idMatch[1] : '')
                    div.setAttribute('data-ref', refMatch ? refMatch[1] : 'doc')
                    div.setAttribute('data-status', status)
                    div.setAttribute('data-block-type', blockType)
                    if (questionText) div.setAttribute('data-question', questionText)
                    if (responseText) div.setAttribute('data-response', responseText)

                    el.insertBefore(div, child)
                    // Remove [!ai] header, all inner nodes, and [!ai-end] footer
                    for (var k = i; k <= endIdx; k++) {
                      if (children[k] && children[k].parentNode === el) children[k].remove()
                    }
                    changed = true
                    break
                  }
                }
                // Recurse into nested containers (e.g. blockRef divs)
                Array.from(el.children).forEach(function (c) {
                  if (c.tagName === 'DIV' && c.children.length > 0) processEl(c)
                })
              }
              processEl(element)
            },
          },
        },
      }
    },
  })

  T.AiBlockLegacy = AiBlockLegacy

})()
