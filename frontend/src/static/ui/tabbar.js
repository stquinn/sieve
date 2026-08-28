(function () {
  let dragFromIdx = null;
  let dragToPos = null;
  let activeRo = null;

  function clearIndicators() {
    document.querySelectorAll('.tab-drop-indicator-left, .tab-drop-indicator-right').forEach(el => {
      el.classList.remove('tab-drop-indicator-left', 'tab-drop-indicator-right');
    });
  }

  function commitDrop() {
    if (dragFromIdx !== null && dragToPos !== null &&
        dragToPos !== dragFromIdx && dragToPos !== dragFromIdx + 1) {
      window.sieveWorkspace.reorder(dragFromIdx, dragToPos);
    }
    dragFromIdx = null;
    dragToPos = null;
    clearIndicators();
  }

  document.addEventListener('dragstart', e => {
    const tab = e.target.closest('[data-tab-idx]');
    if (!tab || !tab.closest('#tabs-area')) return;

    dragFromIdx = parseInt(tab.dataset.tabIdx, 10);
    dragToPos = null;

    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragFromIdx.toString());
      
      // The tab itself as the drag image, cloned so the browser does not pick up
      // the nearest relative container, and made translucent.
      const ghost = tab.cloneNode(true);
      ghost.style.width = tab.offsetWidth + 'px';
      ghost.style.opacity = '0.8';
      ghost.style.position = 'absolute';
      ghost.style.top = '-1000px';
      ghost.style.left = '-1000px';
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, e.offsetX, e.offsetY);
      setTimeout(() => ghost.remove(), 0);
    }
    
    tab.style.opacity = '0.4';
  });

  document.addEventListener('dragover', e => {
    if (dragFromIdx === null) return;
    
    const tab = e.target.closest('[data-tab-idx]');
    const spacer = e.target.closest('#tab-spacer');
    const area = document.getElementById('tabs-area');
    
    if (tab && area && area.contains(tab)) {
      e.preventDefault();
      clearIndicators();
      
      const rect = tab.getBoundingClientRect();
      const mid = rect.left + rect.width / 2;
      const idx = parseInt(tab.dataset.tabIdx, 10);
      
      if (e.clientX < mid) {
        dragToPos = idx;
        tab.classList.add('tab-drop-indicator-left');
      } else {
        dragToPos = idx + 1;
        tab.classList.add('tab-drop-indicator-right');
      }
    } else if (spacer && area) {
      e.preventDefault();
      clearIndicators();
      dragToPos = area.querySelectorAll('[data-tab-idx]').length;
      const lastTab = area.querySelector('[data-tab-idx]:last-child');
      if (lastTab) lastTab.classList.add('tab-drop-indicator-right');
    }
  });

  document.addEventListener('dragleave', e => {
    if (e.target.closest('[data-tab-idx]')) {
      // dragover re-applies the indicator on the next tab immediately, so clear
      // only when the pointer leaves the tab bar entirely.
      if (!e.relatedTarget || !e.relatedTarget.closest('#tabs-bar')) {
        clearIndicators();
      }
    }
  });

  document.addEventListener('drop', e => {
    if (dragFromIdx === null) return;
    e.preventDefault();
    commitDrop();
  });

  document.addEventListener('dragend', e => {
    const tab = e.target.closest('[data-tab-idx]');
    if (tab) tab.style.opacity = '';
    dragFromIdx = null;
    dragToPos = null;
    clearIndicators();
  });

  function initOverflow(area, overflowWrap, overflowBtn) {
    let showDropdown = false;

    const closeDropdown = () => {
      showDropdown = false;
      const dd = document.getElementById('tab-overflow-dropdown');
      if (dd) dd.remove();
    };

    const update = () => {
      if (!area.isConnected) return;
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
        overflowBtn.textContent = '\u25bc ' + hiddenCount;
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

    // Opens a list of the tabs past `_firstHidden`, each activated through the
    // SAME verb a visible tab's onmousedown uses (window.sieveWorkspace.open) \u2014
    // there is no second path to focusing a tab.
    overflowBtn.addEventListener('click', () => {
      if (showDropdown) { closeDropdown(); return; }
      showDropdown = true;
      const firstHidden = overflowBtn._firstHidden || 0;
      const tabs = area.querySelectorAll('[data-tab-idx]');
      const dd = document.createElement('div');
      dd.id = 'tab-overflow-dropdown';
      dd.style.cssText = 'position:absolute;right:0;top:100%;margin-top:2px;z-index:50;' +
        'background:var(--theme-bgAlt);border:1px solid var(--theme-border2);' +
        'border-radius:6px;box-shadow:0 8px 32px color-mix(in srgb, var(--theme-bgDark) 60%, transparent);padding:4px 0;min-width:200px;';
      for (let i = firstHidden; i < tabs.length; i++) {
        const tab = tabs[i];
        const id = tab.dataset.tabId;
        const btn = document.createElement('button');
        btn.style.cssText = 'display:flex;align-items:center;width:100%;background:transparent;border:none;' +
          'text-align:left;padding:6px 12px;font-size:14px;color:var(--theme-textDim);cursor:pointer;transition:background 0.1s;';
        btn.textContent = tab.dataset.ctxName || 'Untitled';
        btn.onmouseenter = () => { btn.style.background = 'var(--theme-bg)'; };
        btn.onmouseleave = () => { btn.style.background = 'transparent'; };
        btn.onclick = () => {
          // The strip does not scroll, so a summoned tab must be SEATED where
          // it can be seen: the last visible slot, displacing that tab toward
          // the overflow. The move SETTLES FIRST — reorder is index-based and
          // the server tracks the active tab as one, so activating during the
          // move can land on whichever tab slid into the old slot. Open is
          // id-based and goes last, which no completed reorder can invalidate.
          const seat = Math.max(0, firstHidden - 1);
          const moved = (i >= firstHidden && seat < i)
            ? window.sieveWorkspace.reorder(i, seat)
            : null;
          Promise.resolve(moved).then(() => window.sieveWorkspace.open(id));
          closeDropdown();
        };
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

  function init() {
    const area = document.getElementById('tabs-area');
    const overflowWrap = document.getElementById('tab-overflow');
    const overflowBtn = document.getElementById('tab-overflow-btn');
    if (area && overflowWrap && overflowBtn) initOverflow(area, overflowWrap, overflowBtn);
  }

  document.addEventListener('htmx:afterSettle', function(e) {
    if (e.detail && e.detail.target && e.detail.target.id === 'htmx-tabbar') init();
  });

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
