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

  function init() {
    const area = document.getElementById('tabs-area');
    const overflowWrap = document.getElementById('tab-overflow');
    const overflowBtn = document.getElementById('tab-overflow-btn');
    if (!area) return;
    initDrag(area);
    if (overflowWrap && overflowBtn) initOverflow(area, overflowWrap, overflowBtn);
  }

  window.sieveTabBarInit = init;

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
