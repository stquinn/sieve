// ai-actions.js — Status bar driven by jobs:changed (full snapshot) SSE events from Go.
// Exposes window.SieveAI namespace; maintains window.__sieveActiveJobs for the close-guard.
(function() {
  // activeJobs: jobId → {label, docId, spinTab}. Populated by SSE events and loadActiveJobs().
  var activeJobs = {};
  var queuedJobs = [];
  window.__sieveActiveJobs = 0;

  function updateStatusBar() {
    // Write only into the dedicated jobs slot — NOT .status-bar__left, which also
    // holds the library chip (#library-chip). Clobbering the whole left cell wiped
    // the chip (and its hx-get wrapper) on every job start/end.
    var sbLeft = document.querySelector('.status-bar__jobs');
    if (!sbLeft) return;
    var ids = Object.keys(activeJobs);
    if (ids.length === 0 && queuedJobs.length === 0) { sbLeft.innerHTML = ''; return; }

    var frag = document.createDocumentFragment();

    // ── Active section ────────────────────────────────────────────────────────
    if (ids.length > 0) {
      var firstLabel = activeJobs[ids[0]].label;
      var activeSpan = document.createElement('span');
      activeSpan.className = 'flex items-center gap-1.5';
      var spinner = document.createElement('span');
      spinner.className = 'w-[10px] h-[10px] shrink-0 rounded-full border-[1.5px] border-solid border-tn-cyan border-t-transparent animate-spin';
      var activeText = document.createElement('span');
      var extra = ids.length > 1 ? ' +' + (ids.length - 1) + ' more' : '';
      activeText.textContent = firstLabel + extra;
      activeSpan.appendChild(spinner);
      activeSpan.appendChild(activeText);
      frag.appendChild(activeSpan);
    }

    // ── Queued section ────────────────────────────────────────────────────────
    if (queuedJobs.length > 0) {
      var queuedSpan = document.createElement('span');
      queuedSpan.className = 'flex items-center gap-1';
      queuedSpan.style.opacity = '0.6';
      var sep = document.createElement('span');
      sep.textContent = ids.length > 0 ? '·' : '';
      sep.style.marginRight = '2px';
      var qText = document.createElement('span');
      qText.textContent = queuedJobs.length === 1
        ? (queuedJobs[0].label || '1 queued')
        : queuedJobs.length + ' queued';
      if (ids.length > 0) queuedSpan.appendChild(sep);
      queuedSpan.appendChild(qText);
      frag.appendChild(queuedSpan);
    }

    sbLeft.innerHTML = '';
    sbLeft.appendChild(frag);
  }

  function setEvaluating(id, isEval) {
    var tab = document.querySelector('.group[data-tab-id="' + id + '"]');
    if (tab) {
      var normal = tab.querySelector('.tab-icon-normal');
      var spinner = tab.querySelector('.tab-spinner');
      if (isEval) {
        if (normal) normal.classList.add('hidden');
        if (spinner) spinner.classList.remove('hidden');
      } else {
        if (normal) normal.classList.remove('hidden');
        if (spinner) spinner.classList.add('hidden');
      }
    }
    var metaSpinner = document.getElementById('meta-thinking-spinner');
    if (metaSpinner) {
      var mount = document.getElementById('tiptap-mount');
      if (mount && mount.getAttribute('data-uuid') === id) {
        if (isEval) metaSpinner.classList.remove('hidden');
        else metaSpinner.classList.add('hidden');
      }
    }
  }

  // applyJobsSnapshot — replaces activeJobs/queuedJobs from a full server snapshot.
  // Called by the sse:jobs:changed listener and by loadActiveJobs() on page load.
  function applyJobsSnapshot(payload) {
    // Clear spinners for jobs that are about to be removed.
    Object.keys(activeJobs).forEach(function(id) {
      var job = activeJobs[id];
      if (job.spinTab && job.docId) setEvaluating(job.docId, false);
    });
    // Rebuild from snapshot.
    activeJobs = {};
    (payload.active || []).forEach(function(j) {
      if (!j.jobId) return;
      activeJobs[j.jobId] = { label: j.label || 'Working...', docId: j.docId || '', spinTab: !!j.spinTab };
      if (j.spinTab && j.docId) setEvaluating(j.docId, true);
    });
    queuedJobs = payload.queued || [];
    window.__sieveActiveJobs = Object.keys(activeJobs).length;
    updateStatusBar();
  }

  // ── Full-snapshot listener (jobs:changed) — sole driver of status bar state ──
  document.addEventListener('sse:jobs:changed', function(e) {
    var raw = e.detail && e.detail.data != null ? e.detail.data : (typeof e.detail === 'string' ? e.detail : null);
    if (!raw) return;
    var payload; try { payload = JSON.parse(raw); } catch (_) { return; }
    applyJobsSnapshot(payload);
  });

  function saveAndPost(url, id) {
    var p = window._editorSave ? window._editorSave() : Promise.resolve();
    p.then(function() {
      if (!id) {
        var mount = document.getElementById('tiptap-mount');
        if (mount) id = mount.getAttribute('data-uuid');
      }
      if (id) {
        fetch(url + id, { method: 'POST' });
        // Go emits jobs:changed via SSE — status bar updates via applyJobsSnapshot.
      }
    });
  }

  window.SieveAI = {
    // loadActiveJobs: called by editor.js on tab load to restore status bar state.
    // Reads from /api/jobs → {active:[...], queued:[...]} and applies snapshot.
    loadActiveJobs: function() {
      fetch('/api/jobs')
        .then(function(r) { return r.json(); })
        .then(function(data) { applyJobsSnapshot(data); })
        .catch(function() {});
    },
    smartFile:        function(id) { saveAndPost('/api/ai/smartFile/',    id); },
    smartMetadata:    function(id) { saveAndPost('/api/ai/smartMetadata/', id); },
    keepAndSmartFile: function(id) { saveAndPost('/api/ai/keepAndFile/',  id); }
  };
})();
