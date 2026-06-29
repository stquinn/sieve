// ai-actions.js — Status bar driven by ai:job-started / ai:job-ended SSE events from Go.
// Exposes window.SieveAI namespace; maintains window.__sieveActiveJobs for the close-guard.
(function() {
  // activeJobs: jobId → {label, docId, spinTab}. Populated by SSE events and loadActiveJobs().
  var activeJobs = {};
  window.__sieveActiveJobs = 0;

  function updateStatusBar() {
    // Write only into the dedicated jobs slot — NOT .status-bar__left, which also
    // holds the library chip (#library-chip). Clobbering the whole left cell wiped
    // the chip (and its hx-get wrapper) on every job start/end.
    var sbLeft = document.querySelector('.status-bar__jobs');
    if (!sbLeft) return;
    var ids = Object.keys(activeJobs);
    if (ids.length === 0) { sbLeft.innerHTML = ''; return; }

    var firstLabel = activeJobs[ids[0]].label;
    var span = document.createElement('span');
    span.className = 'flex items-center gap-1.5';
    var spinner = document.createElement('span');
    spinner.className = 'w-[10px] h-[10px] shrink-0 rounded-full border-[1.5px] border-solid border-tn-cyan border-t-transparent animate-spin';
    var text = document.createElement('span');
    var extra = ids.length > 1 ? ' +' + (ids.length - 1) + ' more' : '';
    text.textContent = firstLabel + extra;
    span.appendChild(spinner);
    span.appendChild(text);
    sbLeft.innerHTML = '';
    sbLeft.appendChild(span);
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

  function parseSSEDetail(e) {
    var raw = e.detail && e.detail.data != null ? e.detail.data : (typeof e.detail === 'string' ? e.detail : null)
    if (!raw) return {}
    try { return JSON.parse(raw); } catch (_) { return {}; }
  }

  document.addEventListener('sse:ai:job-started', function(e) {
    var data = parseSSEDetail(e);
    if (!data.jobId) return;
    activeJobs[data.jobId] = { label: data.label || 'Working...', docId: data.docId, spinTab: !!data.spinTab };
    window.__sieveActiveJobs = Object.keys(activeJobs).length;
    if (data.spinTab && data.docId) setEvaluating(data.docId, true);
    updateStatusBar();
  });

  document.addEventListener('sse:ai:job-ended', function(e) {
    var data = parseSSEDetail(e);
    if (!data.jobId) return;
    var job = activeJobs[data.jobId] || {};
    delete activeJobs[data.jobId];
    window.__sieveActiveJobs = Object.keys(activeJobs).length;
    var docId = job.docId || data.docId;
    var spinTab = job.spinTab != null ? job.spinTab : !!data.spinTab;
    if (spinTab && docId) setEvaluating(docId, false);
    updateStatusBar();
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
        // Go emits ai:job-started and ai:job-ended via SSE — no JS tracking needed here.
      }
    });
  }

  window.SieveAI = {
    // loadActiveJobs: called by editor.js on tab load to restore status bar state.
    loadActiveJobs: function() {
      fetch('/api/ai/active-jobs')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var jobs = data.jobs || [];
          jobs.forEach(function(job) {
            if (!job.jobId) return;
            activeJobs[job.jobId] = { label: job.label || 'Working...', docId: job.docId, spinTab: !!job.spinTab };
            if (job.spinTab && job.docId) setEvaluating(job.docId, true);
          });
          window.__sieveActiveJobs = Object.keys(activeJobs).length;
          updateStatusBar();
        })
        .catch(function() {});
    },
    smartFile:        function(id) { saveAndPost('/api/ai/smartFile/',    id); },
    smartMetadata:    function(id) { saveAndPost('/api/ai/smartMetadata/', id); },
    keepAndSmartFile: function(id) { saveAndPost('/api/ai/keepAndFile/',  id); }
  };
})();
