(function () {
  var menuEl = null;
  var draggedId = null;
  var draggedParentId = null;

  function init() {
    console.log('[sidebar.js] init triggered');
  }

  document.addEventListener('dragstart', function(e) {
    const file = e.target.closest('.sidebar__file');
    if (file) {
      draggedId = file.dataset.ctxId;
      draggedParentId = file.dataset.ctxParentId || '';
      
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', draggedId);
        
        // Create a minimalist ghost element
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

  window.sieveSidebarInit = init;

  document.addEventListener('click', function (e) {
    if (document.getElementById('sieve-context-menu') && !document.getElementById('sieve-context-menu').contains(e.target)) window.sieveCloseMenu();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') window.sieveCloseMenu();
  });

  document.addEventListener('contextmenu', function (e) {
    var target = e.target.closest('[data-ctx-id]');
    if (!target) {
      window.sieveCloseMenu();
      return;
    }
    e.preventDefault();
    window.sieveCloseMenu();
    var id = target.dataset.ctxId;
    var isDir = target.dataset.ctxIsDir === 'true';
    var isTab = target.dataset.ctxIsTab === 'true';
    var name = target.dataset.ctxName || '';
    var intent = target.dataset.ctxIntent || '';
    menuEl = document.createElement('div');
    menuEl.id = 'sieve-context-menu';
    menuEl.style.cssText = [
      'position:fixed',
      'z-index:9999',
      'top:' + e.clientY + 'px',
      'left:' + e.clientX + 'px',
      'background:var(--theme-bgAlt)',
      'border:1px solid var(--theme-border2)',
      'border-radius:8px',
      'box-shadow:0 8px 24px rgba(0,0,0,0.4)',
      'padding:0',
      'min-width:200px'
    ].join(';');
    document.body.appendChild(menuEl);
    var params = new URLSearchParams({ id: id, name: name, intent: intent, isDir: String(isDir), isTab: String(isTab) });
    window.htmx.ajax('GET', '/api/context-menu?' + params.toString(), {
      target: '#sieve-context-menu',
      swap: 'innerHTML',
    });
    requestAnimationFrame(function () {
      if (!menuEl) return;
      var r = menuEl.getBoundingClientRect();
      if (r.right > window.innerWidth - 8)
        menuEl.style.left = (window.innerWidth - r.width - 8) + 'px';
      if (r.bottom > window.innerHeight - 8)
        menuEl.style.top = (window.innerHeight - r.height - 8) + 'px';
    });
  });

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
