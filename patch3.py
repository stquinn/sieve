import re

with open('frontend/src/static/editor.js', 'r') as f:
    content = f.read()

start_marker = "    // HTMX SSE extension dispatches sse:ai:block-resolved"
end_marker = "    function toggleAiBlocks() {"

start_idx = content.find(start_marker)
end_idx = content.find(end_marker)

replacement = """    function runAiJob(type, question, precomputedCtx) {
      if (!currentEditor && currentMode !== 'markdown') return

      var ctx = precomputedCtx || window.TipTap.buildAiContext(currentEditor, currentMode === 'markdown', lastSyncedBody, currentUuid)
      var refId = (ctx && ctx.blockRef) || 'doc'
      var blockType = type === 'explain' ? 'EXPLAIN' : 'ASK'

      flushSave().then(function () {
        wsSend({
          type: 'create-block',
          kind: 'ai-block',
          attrs: {
            type:     blockType,
            ref:      refId,
            question: question || '',
          },
          uuid: currentUuid,
        })
      }).catch(function(err) {
        console.error('runAiJob flush save error:', err)
      })
    }

"""

new_content = content[:start_idx] + replacement + content[end_idx:]

with open('frontend/src/static/editor.js', 'w') as f:
    f.write(new_content)

