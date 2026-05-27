// ai-actions.js — Category D: AI save-then-post operations + evaluating UI state.
// Exposes window.SieveAI namespace; keeps window.__sieveActiveJobs counter for close-guard.
(function() {
  var activeJobLabels = {};  // jobId → display label
  window.__sieveActiveJobs = 0;

  function updateStatusBar() {
    var sbLeft = document.querySelector('.status-bar__left');
    if (!sbLeft) return;
    var ids = Object.keys(activeJobLabels);
    if (ids.length === 0) { sbLeft.innerHTML = ''; return; }

    var firstLabel = activeJobLabels[ids[0]];
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
    updateStatusBar();
  }

  function saveAndPost(url, id, label) {
    var p = window._editorSave ? window._editorSave() : Promise.resolve();
    p.then(function() {
      if (!id) {
        var mount = document.getElementById('tiptap-mount');
        if (mount) id = mount.getAttribute('data-uuid');
      }
      if (id) {
        activeJobLabels[id] = label || 'Filing note...';
        window.__sieveActiveJobs = Object.keys(activeJobLabels).length;
        setEvaluating(id, true);
        fetch(url + id, { method: 'POST' }).finally(function() {
          delete activeJobLabels[id];
          window.__sieveActiveJobs = Object.keys(activeJobLabels).length;
          setEvaluating(id, false);
        });
      }
    });
  }

  window.SieveAI = {
    // trackJob: called by editor.js for ask/explain/web-clip jobs.
    // delta: +1 to register a job, -1 to remove it.
    // id: stable key for the job (blkId). label: human-readable status text.
    trackJob: function(delta, id, label) {
      if (delta > 0 && id) {
        activeJobLabels[id] = label || 'Working...';
      } else if (id) {
        delete activeJobLabels[id];
      }
      window.__sieveActiveJobs = Object.keys(activeJobLabels).length;
      updateStatusBar();
    },
    smartFile:        function(id) { saveAndPost('/api/ai/smartFile/',    id, 'Filing note...'); },
    smartMetadata:    function(id) { saveAndPost('/api/ai/smartMetadata/', id, 'Updating metadata...'); },
    keepAndSmartFile: function(id) { saveAndPost('/api/ai/keepAndFile/',  id, 'Filing note...'); }
  };
})();
