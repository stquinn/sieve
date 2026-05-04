// ai-actions.js — Category D: AI save-then-post operations + evaluating UI state.
// Exposes window.SieveAI namespace; keeps window.__sieveActiveJobs counter for close-guard.
(function() {
  window.__sieveActiveJobs = 0;

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
    var sbLeft = document.querySelector('.status-bar__left');
    if (sbLeft) {
      if (window.__sieveActiveJobs > 0) {
        sbLeft.innerHTML = '<span class="flex items-center gap-1.5"><span class="w-[10px] h-[10px] shrink-0 rounded-full border-[1.5px] border-solid border-tn-cyan border-t-transparent animate-spin"></span> Evaluating (' + window.__sieveActiveJobs + ')</span>';
      } else {
        sbLeft.innerHTML = '';
      }
    }
  }

  function saveAndPost(url, id) {
    var p = window._editorSave ? window._editorSave() : Promise.resolve();
    p.then(function() {
      if (!id) {
        var mount = document.getElementById('tiptap-mount');
        if (mount) id = mount.getAttribute('data-uuid');
      }
      if (id) {
        window.__sieveActiveJobs++;
        setEvaluating(id, true);
        fetch(url + id, { method: 'POST' }).finally(function() {
          window.__sieveActiveJobs--;
          setEvaluating(id, false);
        });
      }
    });
  }

  window.SieveAI = {
    smartFile:        function(id) { saveAndPost('/api/ai/smartFile/', id); },
    smartMetadata:    function(id) { saveAndPost('/api/ai/smartMetadata/', id); },
    keepAndSmartFile: function(id) { saveAndPost('/api/ai/keepAndFile/', id); }
  };
})();
