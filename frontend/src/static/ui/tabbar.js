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
        overflowBtn.textContent = '\u25be ' + hiddenCount;
        overflowBtn._firstHidden = firstHidden;
      } else {
        overflowWrap.style.display = 'none';
      }
    };

    if (activeRo) activeRo.disconnect();
    activeRo = new ResizeObserver(update);
    activeRo.observe(area);
    update();
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
