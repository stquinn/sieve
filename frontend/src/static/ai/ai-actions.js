// ai-actions.js — Status bar driven by the workspace channel's jobs-changed
// push (a full snapshot, republished as the sieve:jobs-changed DOM event).
// Exposes window.SieveAI namespace; maintains window.__sieveActiveJobs for the close-guard.
(function() {
  // activeJobs: jobId → {label, docId, spinTab}. Replaced wholesale on every push.
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

    // ── Active cell: spinner + first label (+N more) ──────────────────────────
    if (ids.length > 0) {
      var active = document.createElement('span');
      active.className = 'status-bar__job-active';
      var spinner = document.createElement('span');
      spinner.className = 'status-bar__spinner';
      var task = document.createElement('span');
      task.className = 'status-bar__task';
      task.textContent = activeJobs[ids[0]].label || 'Working…';
      active.appendChild(spinner);
      active.appendChild(task);
      if (ids.length > 1) {
        var more = document.createElement('span');
        more.className = 'status-bar__job-more';
        more.textContent = '+' + (ids.length - 1) + ' more';
        active.appendChild(more);
      }
      frag.appendChild(active);
    }

    // ── Queued cell: waiting count (divider vs the active cell is CSS) ─────────
    if (queuedJobs.length > 0) {
      var queued = document.createElement('span');
      queued.className = 'status-bar__job-queued';
      queued.textContent = queuedJobs.length + ' queued';
      queued.title = queuedJobs.map(function (j) { return j.label || 'queued'; }).join('\n');
      frag.appendChild(queued);
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
  function applyJobsSnapshot(payload) {
    // Clear spinners for jobs that are about to be removed.
    Object.keys(activeJobs).forEach(function(id) {
      var job = activeJobs[id];
      if (job.spinTab && job.docId) setEvaluating(job.docId, false);
    });
    // Rebuild from snapshot. EVERY JobEngine job paints here uniformly —
    // commands included (their CommandBadge is an additional affordance, not a
    // replacement; #55 decision #5's filter was reversed 2026-07-26).
    activeJobs = {};
    (payload.active || []).forEach(function(j) {
      if (!j.jobId) return;
      activeJobs[j.jobId] = { label: j.label || 'Working...', docId: j.docId || '', spinTab: !!j.spinTab };
      if (j.spinTab && j.docId) setEvaluating(j.docId, true);
    });
    queuedJobs = (payload.queued || []).filter(function(j) { return !!j.jobId; });
    window.__sieveActiveJobs = Object.keys(activeJobs).length;
    updateStatusBar();
  }

  // ── Full-snapshot listener — the SOLE driver of status bar state. The server
  // sends one unprompted on connect, so there is nothing to seed on page load.
  document.addEventListener('sieve:jobs-changed', function(e) {
    applyJobsSnapshot(e.detail || {});
  });

  // saveAndDispatch saves the editor first and waits for the save to LAND,
  // because filing reads what is ON DISK: the AI must judge the document the
  // user is looking at, not the last save. The filing verb then rides the
  // WORKSPACE channel — a different socket from the save, with no ordering
  // between them — which is exactly why the wait is on the landed fact rather
  // than on having sent the flush. Its result is not read here: the work happens
  // in a job, and the job's progress is what repaints this bar.
  function saveAndDispatch(verb, id) {
    var p = window.sieveWorkspace ? window.sieveWorkspace.saveAndSettle() : Promise.resolve();
    p.then(function() {
      if (!id) {
        var mount = document.getElementById('tiptap-mount');
        if (mount) id = mount.getAttribute('data-uuid');
      }
      var cs = window.sieveWorkspace && window.sieveWorkspace.commandService;
      if (id && cs) cs.dispatchFiling(verb, id);
    });
  }

  window.SieveAI = {
    smartFile:        function(id) { saveAndDispatch('file',          id); },
    smartMetadata:    function(id) { saveAndDispatch('metadata',      id); },
    keepAndSmartFile: function(id) { saveAndDispatch('keep-and-file', id); }
  };
})();
