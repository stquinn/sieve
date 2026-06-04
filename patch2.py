import re

with open('frontend/src/static/editor.js', 'r') as f:
    content = f.read()

# Remove the SSE listener
sse_pattern = r"    // HTMX SSE extension dispatches sse:ai:block-resolved.*?softReloadContent\(currentUuid\)\n    \}\)\n"
content = re.sub(sse_pattern, "", content, flags=re.DOTALL)

# Replace runAiJob
run_ai_job_pattern = r"    function runAiJob\(type, question, precomputedCtx\) \{.*?(?=    \n    // ── Dialog Handlers ──────────────────────────────────────────────────────)"
new_run_ai_job = """    function runAiJob(type, question, precomputedCtx) {
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

# Try to find exactly runAiJob ending at the start of Dialog Handlers
# or we can just replace up to next function
run_ai_job_pattern2 = r"    function runAiJob\(type, question, precomputedCtx\) \{.*?(?=\n    // ── Dialog Handlers ──────────────────────────────────────────────────────)"
content = re.sub(run_ai_job_pattern2, new_run_ai_job.rstrip(), content, flags=re.DOTALL)

with open('frontend/src/static/editor.js', 'w') as f:
    f.write(content)

