(function () {
  var draggedId = null;
  var draggedParentId = null;

  window.sieveShowInFiles = function(id) {
    if (window.go && window.go.main && window.go.main.App && window.go.main.App.ShowInFilesByID) {
      window.go.main.App.ShowInFilesByID(id);
    }
  };

  document.addEventListener('dragstart', function(e) {
    const file = e.target.closest('.sidebar__file');
    if (file) {
      draggedId = file.dataset.ctxId;
      draggedParentId = file.dataset.ctxParentId || '';
      
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', draggedId);
        
        const ghost = document.createElement('div');
        ghost.textContent = file.dataset.ctxName || 'Moving note...';
        ghost.style.cssText = `
          position: absolute;
          top: -1000px;
          left: -1000px;
          padding: 6px 10px;
          background: var(--theme-bgAlt);
          color: var(--theme-text);
          border: 1px solid var(--theme-accentPrimary);
          border-radius: 4px;
          font-size: 13px;
          font-weight: 500;
          pointer-events: none;
          box-shadow: 0 4px 12px rgba(0,0,0,0.4);
        `;
        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, 10, 10);
        setTimeout(() => { if (ghost.parentNode) ghost.parentNode.removeChild(ghost); }, 0);
      }
      
      file.classList.add('opacity-50');
    }
  });

  document.addEventListener('dragend', function(e) {
    const file = e.target.closest('.sidebar__file');
    if (file) file.classList.remove('opacity-50');
    draggedId = null;
    draggedParentId = null;
    document.querySelectorAll('.sidebar__dir--drag-over').forEach(el => el.classList.remove('sidebar__dir--drag-over'));
  });

  document.addEventListener('dragover', function(e) {
    if (!draggedId) return;
    const dir = e.target.closest('.sidebar__dir');
    if (dir) {
      if (dir.dataset.ctxId === draggedParentId) return;
      e.preventDefault(); 
      e.dataTransfer.dropEffect = 'move';
      if (!dir.classList.contains('sidebar__dir--drag-over')) {
        dir.classList.add('sidebar__dir--drag-over');
      }
    }
  });

  document.addEventListener('dragleave', function(e) {
    const dir = e.target.closest('.sidebar__dir');
    if (dir) {
      dir.classList.remove('sidebar__dir--drag-over');
    }
  });

  document.addEventListener('drop', function(e) {
    if (!draggedId) return;
    const dir = e.target.closest('.sidebar__dir');
    if (dir) {
      if (dir.dataset.ctxId === draggedParentId) return;
      e.preventDefault();
      dir.classList.remove('sidebar__dir--drag-over');
      const targetFolder = dir.dataset.ctxId;
      if (window.htmx) {
        window.htmx.ajax('POST', '/api/sidebar/move?id=' + encodeURIComponent(draggedId) + '&target=' + encodeURIComponent(targetFolder), {
          target: '#htmx-sidebar',
          swap: 'innerHTML'
        });
      }
    }
  });

  document.addEventListener('contextmenu', function (e) {
    var target = e.target.closest('[data-ctx-id]');
    if (!target) return;
    e.preventDefault();
    var id = target.dataset.ctxId;
    var isDir = target.dataset.ctxIsDir === 'true';
    var isTab = target.dataset.ctxIsTab === 'true';
    var isVirtual = target.dataset.ctxIsVirtual === 'true';
    var name = target.dataset.ctxName || '';
    var intent = target.dataset.ctxIntent || '';
    var ctxType = target.dataset.ctxType || (id.startsWith('prompt:') ? 'prompt' : 'note');
    if (isDir) ctxType = 'folder';
    document.dispatchEvent(new CustomEvent('sieve:contextmenu', {
      detail: {
        x: e.clientX, y: e.clientY,
        context: { type: ctxType, id: id, name: name, intent: intent, isTab: isTab, isVirtual: isVirtual }
      }
    }));
  });

})();
