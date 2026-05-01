(function () {
  var menuEl = null;

  function closeMenu() {
    if (menuEl) {
      menuEl.remove();
      menuEl = null;
    }
  }
  window.sieveCloseMenu = closeMenu;

  document.addEventListener('click', function (e) {
    if (menuEl && !menuEl.contains(e.target)) closeMenu();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeMenu();
  });

  document.addEventListener('contextmenu', function (e) {
    var target = e.target.closest('[data-ctx-id]');
    if (!target) {
      closeMenu();
      return;
    }
    e.preventDefault();
    closeMenu();

    var id = target.dataset.ctxId;
    var isDir = target.dataset.ctxIsDir === 'true';
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
    ].join(';');
    document.body.appendChild(menuEl);

    var params = new URLSearchParams({ id: id, name: name, intent: intent, isDir: String(isDir) });
    window.htmx.ajax('GET', '/api/context-menu?' + params.toString(), {
      target: '#sieve-context-menu',
      swap: 'innerHTML',
    });

    // Clamp to viewport after HTMX populates the menu.
    requestAnimationFrame(function () {
      if (!menuEl) return;
      var r = menuEl.getBoundingClientRect();
      if (r.right > window.innerWidth - 8)
        menuEl.style.left = (window.innerWidth - r.width - 8) + 'px';
      if (r.bottom > window.innerHeight - 8)
        menuEl.style.top = (window.innerHeight - r.height - 8) + 'px';
    });
  });

})();
