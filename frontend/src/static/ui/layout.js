(function() {
    let isDragging = false;
    let currentHandle = null;
    let startX, startY;
    let startWidth, startHeight;

    function onMouseDown(e) {
        currentHandle = e.target;
        if (!currentHandle.classList.contains('sidebar-handle') &&
            !currentHandle.classList.contains('meta-handle') &&
            !currentHandle.classList.contains('prompts-handle') &&
            !currentHandle.classList.contains('ask-handle')) return;

        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;

        const appRoot = document.getElementById('app-root');
        const sidebarWrapper = document.getElementById('sidebar-wrapper');
        const metaPanel = document.getElementById('htmx-meta-panel');
        const promptsPanel = document.getElementById('prompts-panel');
        const askPanel = document.getElementById('ask-panel');

        if (currentHandle.classList.contains('sidebar-handle')) {
            startWidth = sidebarWrapper.offsetWidth;
        } else if (currentHandle.classList.contains('meta-handle')) {
            startWidth = metaPanel.offsetWidth;
        } else if (currentHandle.classList.contains('prompts-handle')) {
            startHeight = promptsPanel.offsetHeight;
        } else if (currentHandle.classList.contains('ask-handle')) {
            startHeight = askPanel.offsetHeight;
        }

        document.body.style.cursor = window.getComputedStyle(currentHandle).cursor;
        document.body.classList.add('is-resizing'); // Optional: for global styling during drag
        
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        e.preventDefault();
    }

    // The server owns the layout width vars: it renders them into
    // <style id="layout-overrides-*"> blocks with !important. A drag must therefore
    // edit THAT stylesheet's rule via CSSOM — an inline style on #app-root either
    // loses to the stylesheet's !important or, with an !important flag of its own,
    // permanently beats the server's later hide-toggle and leaves an empty column.
    // Match by selectorText, not rule index: the block also holds other rules.
    function setLayoutVar(styleElId, varName, value) {
        const styleEl = document.getElementById(styleElId);
        if (!styleEl || !styleEl.sheet) return;
        for (const rule of styleEl.sheet.cssRules) {
            if (rule.selectorText === '#app-root') {
                rule.style.setProperty(varName, value, 'important');
                break;
            }
        }
    }

    function onMouseMove(e) {
        if (!isDragging) return;

        const metaPanel = document.getElementById('htmx-meta-panel');
        const promptsPanel = document.getElementById('prompts-panel');

        if (currentHandle.classList.contains('sidebar-handle')) {
            const dx = e.clientX - startX;
            let newWidth = startWidth + dx;
            if (newWidth < 150) newWidth = 150;
            if (newWidth > 600) newWidth = 600;
            setLayoutVar('layout-overrides-sidebar', '--sidebar-w', newWidth + 'px');
        } else if (currentHandle.classList.contains('meta-handle')) {
            const dx = startX - e.clientX; // Reverse because it's on the right
            let newWidth = startWidth + dx;
            if (newWidth < 150) newWidth = 150;
            if (newWidth > 600) newWidth = 600;
            setLayoutVar('layout-overrides-meta', '--meta-w', newWidth + 'px');
            metaPanel.style.width = newWidth + 'px';
        } else if (currentHandle.classList.contains('prompts-handle')) {
            const dy = startY - e.clientY; // Dragging up increases height
            let newHeight = startHeight + dy;
            if (newHeight < 50) newHeight = 50;
            if (newHeight > 600) newHeight = 600;
            promptsPanel.style.height = newHeight + 'px';
        } else if (currentHandle.classList.contains('ask-handle')) {
            const askPanel = document.getElementById('ask-panel');
            const dy = startY - e.clientY; // handle is at the top → up grows it
            let newHeight = startHeight + dy;
            const min = askPanelMinHeight(askPanel);
            const editorCol = document.getElementById('editor-col');
            // Editor must always keep ≥100px; cap growth at the column height − 100.
            const max = editorCol ? Math.max(min, editorCol.clientHeight - 100) : 600;
            if (newHeight < min) newHeight = min;
            if (newHeight > max) newHeight = max;
            askPanel.style.height = newHeight + 'px';
        }
    }

    // Minimum Ask-panel height: footer + the writing box's own frame (its
    // margins and borders, which now include the handle riding on its top edge)
    // + exactly one line of message (line-height + the input's vertical
    // padding). Computed live so it tracks theme/font changes rather than
    // hard-coding a pixel floor. No header term: the panel no longer draws one.
    function askPanelMinHeight(askPanel) {
        const footer = askPanel.querySelector('.ask-popup__footer');
        const input = askPanel.querySelector('.ask-popup__input');
        const handle = askPanel.querySelector('.ask-handle');
        const cs = getComputedStyle(input);
        const lineH = parseFloat(cs.lineHeight) || 22;
        const padV = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
        const footerH = footer ? footer.offsetHeight : 0;
        const handleH = handle ? handle.offsetHeight : 0;
        const frameV = verticalFrame(askPanel.querySelector('.ask-composer'));
        return Math.ceil(footerH + handleH + frameV + lineH + padV);
    }

    // What an element costs vertically over its content box: margins + borders.
    function verticalFrame(el) {
        if (!el) return 0;
        const cs = getComputedStyle(el);
        return ['marginTop', 'marginBottom', 'borderTopWidth', 'borderBottomWidth']
            .reduce((sum, prop) => sum + (parseFloat(cs[prop]) || 0), 0);
    }

    function onMouseUp() {
        if (!isDragging) return;
        isDragging = false;
        document.body.style.cursor = '';
        document.body.classList.remove('is-resizing');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);

        const appRoot = document.getElementById('app-root');
        const promptsPanel = document.getElementById('prompts-panel');
        const askPanel = document.getElementById('ask-panel');

        const sidebarWidth = parseInt(getComputedStyle(appRoot).getPropertyValue('--sidebar-w'));
        const metaWidth = parseInt(getComputedStyle(appRoot).getPropertyValue('--meta-w'));
        const promptsHeight = promptsPanel ? promptsPanel.offsetHeight : 0;
        const askPanelHeight = askPanel ? askPanel.offsetHeight : 0;

        const params = new URLSearchParams();
        params.append('sidebarWidth', sidebarWidth);
        params.append('metaWidth', metaWidth);
        params.append('promptsHeight', promptsHeight);
        params.append('askPanelHeight', askPanelHeight);

        fetch('/api/session/layout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString()
        });
    }

    document.addEventListener('mousedown', function(e) {
        if (e.target.classList.contains('sidebar-handle') ||
            e.target.classList.contains('meta-handle') ||
            e.target.classList.contains('prompts-handle') ||
            e.target.classList.contains('ask-handle')) {
            onMouseDown(e);
        }
    });

})();
