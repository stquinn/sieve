(function() {
    let isDragging = false;
    let currentHandle = null;
    let startX, startY;
    let startWidth, startHeight;

    function onMouseDown(e) {
        currentHandle = e.target;
        if (!currentHandle.classList.contains('sidebar-handle') && 
            !currentHandle.classList.contains('meta-handle') && 
            !currentHandle.classList.contains('prompts-handle')) return;

        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;

        const appRoot = document.getElementById('app-root');
        const sidebarWrapper = document.getElementById('sidebar-wrapper');
        const metaPanel = document.getElementById('htmx-meta-panel');
        const promptsPanel = document.getElementById('prompts-panel');

        if (currentHandle.classList.contains('sidebar-handle')) {
            startWidth = sidebarWrapper.offsetWidth;
        } else if (currentHandle.classList.contains('meta-handle')) {
            startWidth = metaPanel.offsetWidth;
        } else if (currentHandle.classList.contains('prompts-handle')) {
            startHeight = promptsPanel.offsetHeight;
        }

        document.body.style.cursor = window.getComputedStyle(currentHandle).cursor;
        document.body.classList.add('is-resizing'); // Optional: for global styling during drag
        
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        e.preventDefault();
    }

    function onMouseMove(e) {
        if (!isDragging) return;

        const appRoot = document.getElementById('app-root');
        const sidebarWrapper = document.getElementById('sidebar-wrapper');
        const metaPanel = document.getElementById('htmx-meta-panel');
        const promptsPanel = document.getElementById('prompts-panel');

        if (currentHandle.classList.contains('sidebar-handle')) {
            const dx = e.clientX - startX;
            let newWidth = startWidth + dx;
            if (newWidth < 150) newWidth = 150;
            if (newWidth > 600) newWidth = 600;
            appRoot.style.setProperty('--sidebar-w', newWidth + 'px');
        } else if (currentHandle.classList.contains('meta-handle')) {
            const dx = startX - e.clientX; // Reverse because it's on the right
            let newWidth = startWidth + dx;
            if (newWidth < 150) newWidth = 150;
            if (newWidth > 600) newWidth = 600;
            appRoot.style.setProperty('--meta-w', newWidth + 'px');
            metaPanel.style.width = newWidth + 'px';
        } else if (currentHandle.classList.contains('prompts-handle')) {
            const dy = startY - e.clientY; // Dragging up increases height
            let newHeight = startHeight + dy;
            if (newHeight < 50) newHeight = 50;
            if (newHeight > 600) newHeight = 600;
            promptsPanel.style.height = newHeight + 'px';
        }
    }

    function onMouseUp() {
        if (!isDragging) return;
        isDragging = false;
        document.body.style.cursor = '';
        document.body.classList.remove('is-resizing');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);

        // Save to backend
        const appRoot = document.getElementById('app-root');
        const promptsPanel = document.getElementById('prompts-panel');
        
        const sidebarWidth = parseInt(getComputedStyle(appRoot).getPropertyValue('--sidebar-w'));
        const metaWidth = parseInt(getComputedStyle(appRoot).getPropertyValue('--meta-w'));
        const promptsHeight = promptsPanel ? promptsPanel.offsetHeight : 0;

        const params = new URLSearchParams();
        params.append('sidebarWidth', sidebarWidth);
        params.append('metaWidth', metaWidth);
        params.append('promptsHeight', promptsHeight);

        fetch('/api/session/layout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString()
        });
    }

    document.addEventListener('mousedown', function(e) {
        if (e.target.classList.contains('sidebar-handle') || 
            e.target.classList.contains('meta-handle') || 
            e.target.classList.contains('prompts-handle')) {
            onMouseDown(e);
        }
    });

})();
