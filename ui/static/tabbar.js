(function () {
  let dragFromIdx = null;
  let dragToPos = null;
  let activeRo = null;

  function initDrag(area) {
    area.addEventListener('dragstart', e => {
      const tab = e.target.closest('[data-tab-idx]');
      if (!tab) return;
      dragFromIdx = parseInt(tab.dataset.tabIdx, 10);
      dragToPos = null;
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });

    area.addEventListener('dragover', e => {
      e.preventDefault();
      const tab = e.target.closest('[data-tab-idx]');
      if (!tab || dragFromIdx === null) return;
      const rect = tab.getBoundingClientRect();
      const idx = parseInt(tab.dataset.tabIdx, 10);
      dragToPos = e.clientX < rect.left + rect.width / 2 ? idx : idx + 1;
    });

    area.addEventListener('drop', e => {
      e.preventDefault();
      commitDrop();
    });

    area.addEventListener('dragend', () => {
      dragFromIdx = null;
      dragToPos = null;
    });

    const spacer = document.getElementById('tab-spacer');
    if (spacer) {
      spacer.addEventListener('dragover', e => {
        e.preventDefault();
        if (dragFromIdx !== null) {
          dragToPos = area.querySelectorAll('[data-tab-idx]').length;
        }
      });
      spacer.addEventListener('drop', e => {
        e.preventDefault();
        commitDrop();
      });
    }
  }

  function commitDrop() {
    if (dragFromIdx !== null && dragToPos !== null &&
        dragToPos !== dragFromIdx && dragToPos !== dragFromIdx + 1) {
      window.sieveReorderTabs && window.sieveReorderTabs(dragFromIdx, dragToPos);
    }
    dragFromIdx = null;
    dragToPos = null;
  }

  function initOverflow(area, overflowWrap, overflowBtn) {
    let showDropdown = false;

    const update = () => {
      const areaRight = area.getBoundingClientRect().right;
      const tabs = area.querySelectorAll('[data-tab-idx]');
      let firstHidden = tabs.length;
      for (let i = 0; i < tabs.length; i++) {
        if (tabs[i].getBoundingClientRect().right > areaRight + 1) {
          firstHidden = i;
          break;
        }
      }
      const hiddenCount = tabs.length - firstHidden;
      if (hiddenCount > 0) {
        overflowWrap.style.display = 'flex';
        overflowWrap.style.alignItems = 'stretch';
        overflowBtn.textContent = '\u25be ' + hiddenCount;
        overflowBtn._firstHidden = firstHidden;
      } else {
        overflowWrap.style.display = 'none';
        if (showDropdown) closeDropdown();
      }
    };

    if (activeRo) activeRo.disconnect();
    activeRo = new ResizeObserver(update);
    activeRo.observe(area);
    update();

    const closeDropdown = () => {
      showDropdown = false;
      const dd = document.getElementById('tab-overflow-dropdown');
      if (dd) dd.remove();
    };

    overflowBtn.addEventListener('click', () => {
      if (showDropdown) { closeDropdown(); return; }
      showDropdown = true;
      const firstHidden = overflowBtn._firstHidden || 0;
      const tabs = area.querySelectorAll('[data-tab-idx]');
      const dd = document.createElement('div');
      dd.id = 'tab-overflow-dropdown';
      dd.style.cssText = 'position:absolute;right:0;top:100%;margin-top:2px;z-index:50;' +
        'background:var(--theme-bgAlt);border:1px solid rgba(255,255,255,0.2);' +
        'border-radius:6px;box-shadow:0 8px 32px rgba(0,0,0,0.4);padding:4px 0;min-width:200px;';
      for (let i = firstHidden; i < tabs.length; i++) {
        const tab = tabs[i];
        const id = tab.dataset.tabId;
        const labelEl = tab.querySelector('.tab-item__label');
        const btn = document.createElement('button');
        btn.style.cssText = 'display:flex;align-items:center;width:100%;background:transparent;border:none;' +
          'text-align:left;padding:6px 12px;font-size:14px;color:var(--theme-textDim);cursor:pointer;transition:background 0.1s;';
        btn.textContent = labelEl ? labelEl.textContent.trim() : 'Untitled';
        btn.onmouseenter = () => { btn.style.background = 'var(--theme-bg)'; };
        btn.onmouseleave = () => { btn.style.background = 'transparent'; };
        btn.onclick = () => { window.sieveSelectTab && window.sieveSelectTab(id); closeDropdown(); };
        dd.appendChild(btn);
      }
      overflowWrap.appendChild(dd);
      setTimeout(() => {
        document.addEventListener('mousedown', function handler(e) {
          if (!overflowWrap.contains(e.target)) {
            closeDropdown();
            document.removeEventListener('mousedown', handler);
          }
        });
      });
    });
  }

  function initContextMenu() {
    let menuEl = null;

    const close = () => {
      if (menuEl) { menuEl.remove(); menuEl = null; }
      document.removeEventListener('mousedown', outsideHandler);
      document.removeEventListener('keydown', escHandler);
    };

    const outsideHandler = e => {
      if (menuEl && !menuEl.contains(e.target)) close();
    };

    const escHandler = e => {
      if (e.key === 'Escape') close();
    };

    window.sieveTabContextMenu = (id, name, event) => {
      close();

      menuEl = document.createElement('div');
      menuEl.style.cssText = 'position:fixed;z-index:9999;background:var(--theme-bg);' +
        'border:1px solid var(--theme-border2);border-radius:6px;' +
        'box-shadow:0 8px 32px rgba(0,0,0,0.5);padding:4px 0;min-width:200px;';
      menuEl.style.left = event.clientX + 'px';
      menuEl.style.top = event.clientY + 'px';

      const addItem = (label, icon, action, danger) => {
        const btn = document.createElement('button');
        btn.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;background:transparent;' +
          'border:none;text-align:left;padding:6px 12px;font-size:14px;cursor:pointer;transition:background 0.1s;' +
          (danger ? 'color:var(--theme-accentRed);' : 'color:var(--theme-text);');
        btn.innerHTML = (icon ? '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none">' + icon + '</svg>' : '') + label;
        btn.onmouseenter = () => { btn.style.background = 'var(--theme-border2)'; };
        btn.onmouseleave = () => { btn.style.background = 'transparent'; };
        btn.onclick = () => { close(); action(); };
        menuEl.appendChild(btn);
        return btn;
      };

      const addSep = () => {
        const d = document.createElement('div');
        d.style.cssText = 'height:1px;background:var(--theme-border2);margin:4px 0;';
        menuEl.appendChild(d);
      };

      // Title
      const title = document.createElement('div');
      title.style.cssText = 'padding:6px 12px;font-size:11px;font-weight:700;color:var(--theme-muted);' +
        'text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid var(--theme-border2);' +
        'margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      title.textContent = name || 'Note';
      menuEl.prepend(title);

      // Note actions
      addItem('Smart File', '<path d="M4.5 16.5c-1.5 1.5-1.5 3 0 3s3-1.5 3-3L19.5 4.5"/><path d="m19.5 4.5-3 3"/>',
        () => window.sieveSmartFile && window.sieveSmartFile(id));
      addItem('Smart Metadata', '<path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 8v4l3 3"/><circle cx="18" cy="6" r="3"/>',
        () => window.sieveSmartMetadata && window.sieveSmartMetadata(id));

      addSep();

      addItem('Rename...', '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
        () => window.sieveRenameNote && window.sieveRenameNote(id, name));
      addItem('Show in Files', '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
        () => window.sieveShowInFiles && window.sieveShowInFiles(id));

      addSep();

      // Tab-specific actions
      addItem('Close Tab', '<path d="M18 6L6 18"/><path d="M6 6l12 12"/>',
        () => window.sieveCloseTab && window.sieveCloseTab(id));
      addItem('Close All Tabs', '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>',
        () => window.sieveCloseAllTabs && window.sieveCloseAllTabs());

      addSep();

      addItem('Delete Note...', '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>',
        () => {
          window.sieveOpenDelete && window.sieveOpenDelete(id, name, 'note');
        }, true);

      document.body.appendChild(menuEl);

      // Clamp to viewport
      requestAnimationFrame(() => {
        if (!menuEl) return;
        const r = menuEl.getBoundingClientRect();
        if (r.right > window.innerWidth - 4) menuEl.style.left = (window.innerWidth - r.width - 4) + 'px';
        if (r.bottom > window.innerHeight - 4) menuEl.style.top = (window.innerHeight - r.height - 4) + 'px';
      });

      setTimeout(() => {
        document.addEventListener('mousedown', outsideHandler);
        document.addEventListener('keydown', escHandler);
      });
    };

    window.sieveCloseTabMenu = close;
  }

  function init() {
    const area = document.getElementById('tabs-area');
    const overflowWrap = document.getElementById('tab-overflow');
    const overflowBtn = document.getElementById('tab-overflow-btn');
    if (!area) return;
    initDrag(area);
    if (overflowWrap && overflowBtn) initOverflow(area, overflowWrap, overflowBtn);
    initContextMenu();
  }

  window.sieveTabBarInit = init;

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
