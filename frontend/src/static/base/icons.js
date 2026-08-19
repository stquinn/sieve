;(function() {
  'use strict';

  function svg(body) {
    return '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none">' + body + '</svg>';
  }

  window.SieveIcons = {
    copy:        svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    cut:         svg('<circle cx="6" cy="20" r="2"/><circle cx="6" cy="4" r="2"/><line x1="6" y1="6" x2="6" y2="18"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>'),
    paste:       svg('<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>'),
    trash:       svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>'),
    selectAll:   svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6"/><path d="M9 12h6"/><path d="M9 15h6"/>'),
    sparkle:     svg('<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.937A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.582a.5.5 0 0 1 0 .962L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>'),
    promote:     svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'),
    expand:      svg('<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>'),
    // Explain + Ask are the TOOLBAR's own pair, distinct from `info` (the
    // smart-image menu) and `sparkle` (the ai-block's kind icon). Both are chosen
    // for SILHOUETTE: at 14px with a 2px stroke only the outer shape survives, so
    // the old pair — a circle holding a 4px tick, and a 4-pointed star whose
    // concave points closed up into a blob — were unreadable, and the circle also
    // collided with `help`.
    explain:     svg('<path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5.76.76 1.23 1.52 1.41 2.5"/>'),
    ask:         svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
    info:        svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
    refresh:     svg('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><polyline points="3 3 3 8 8 8"/>'),
    smartFile:   svg('<path d="M4.5 16.5c-1.5 1.5-1.5 3 0 3s3-1.5 3-3L19.5 4.5"/><path d="m19.5 4.5-3 3"/>'),
    smartMeta:   svg('<path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 8v4l3 3"/><circle cx="18" cy="6" r="3"/>'),
    keep:        svg('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>'),
    markTrash:   svg('<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'),
    clearIntent: svg('<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.78"/>'),
    edit:        svg('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>'),
    folder:      svg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
    close:       svg('<path d="M18 6L6 18"/><path d="M6 6l12 12"/>'),
    closeAll:    svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>'),
    externalLink: svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'),
    code:         svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
    diagram:      svg('<rect x="8" y="2" width="8" height="5" rx="1"/><line x1="12" y1="7" x2="12" y2="11"/><line x1="3" y1="11" x2="21" y2="11"/><line x1="3" y1="11" x2="3" y2="14"/><line x1="12" y1="11" x2="12" y2="14"/><line x1="21" y1="11" x2="21" y2="14"/><rect x="1" y="14" width="5" height="4" rx="1"/><rect x="9" y="14" width="6" height="4" rx="1"/><rect x="18" y="14" width="5" height="4" rx="1"/>'),
    highlight:   svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/><line x1="15" y1="5" x2="18" y2="8"/>'),
    globe:       svg('<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>'),
    arrowDown:   svg('<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>'),
    arrowUp:     svg('<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>'),
    arrowLeft:   svg('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
    arrowRight:  svg('<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>'),
    tableColumnPlusLeft:  svg('<rect x="10" y="3" width="11" height="18" rx="2" ry="2"/><line x1="16" y1="3" x2="16" y2="21"/><line x1="3" y1="12" x2="7" y2="12"/><line x1="5" y1="10" x2="5" y2="14"/>'),
    tableColumnPlusRight: svg('<rect x="3" y="3" width="11" height="18" rx="2" ry="2"/><line x1="8" y1="3" x2="8" y2="21"/><line x1="17" y1="12" x2="21" y2="12"/><line x1="19" y1="10" x2="19" y2="14"/>'),
    tableColumnRemove:    svg('<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/><line x1="7" y1="7" x2="17" y2="17"/><line x1="17" y1="7" x2="7" y2="17"/>'),
    tableRowPlusTop:      svg('<rect x="3" y="10" width="18" height="11" rx="2" ry="2"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="12" y1="3" x2="12" y2="7"/><line x1="10" y1="5" x2="14" y2="5"/>'),
    tableRowPlusBottom:   svg('<rect x="3" y="3" width="18" height="11" rx="2" ry="2"/><line x1="3" y1="8" x2="21" y2="8"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="10" y1="19" x2="14" y2="19"/>'),
    tableRowRemove:       svg('<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="7" y1="7" x2="17" y2="17"/><line x1="17" y1="7" x2="7" y2="17"/>'),
    tableHeader:          svg('<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><rect x="3" y="3" width="18" height="6" fill="currentColor"/><line x1="3" y1="15" x2="21" y2="15"/>'),
    tableMerge:           svg('<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="12" y1="3" x2="12" y2="12"/>'),
    table:                svg('<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="9" x2="9" y2="21"/><line x1="15" y1="9" x2="15" y2="21"/>'),
    paperclip:            svg('<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'),
    image:                svg('<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>'),
    markdown:             svg('<rect x="3" y="5" width="18" height="14" rx="2" ry="2"/><path d="M7 15V9l2 2 2-2v6M14 13l2 2 2-2M16 15V9"/>'),
    eye:                  svg('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
    bold:                 svg('<path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/><path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/>'),
    italic:               svg('<line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/>'),
    strike:               svg('<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" y1="12" x2="20" y2="12"/>'),
    h1:                   svg('<g transform="translate(0, 2)"><path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M17 12l3-2v8"/></g>'),
    h2:                   svg('<g transform="translate(0, 2)"><path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1"/></g>'),
    h3:                   svg('<g transform="translate(0, 2)"><path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M17.5 10.5c1.7-1 3.5 0 3.5 1.5 0 1.7-2.3 2.5-4 2.5 1.7 0 4 .8 4 2.5 0 1.5-1.8 2.5-3.5 1.5"/></g>'),
    bulletList:           svg('<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>'),
    orderedList:          svg('<line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>'),
    taskList:             svg('<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
    blockquote:           svg('<path d="M5 4v16"/><line x1="11" y1="6" x2="19" y2="6"/><line x1="11" y1="12" x2="21" y2="12"/><line x1="11" y1="18" x2="18" y2="18"/>'),
    horizontalRule:       svg('<line x1="4" y1="12" x2="20" y2="12"/>'),
    terminal:             svg('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>'),
    help:                 svg('<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>')
  };
})();
