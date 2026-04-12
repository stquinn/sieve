- Markdown editor doesnt have lines, should it?
- buffer names could be better - more natural to call them "untitled 1" or something.

fixed
- [x] Sidebar nav widths disappear from sessions file — SaveSession now merges with existing widths
- [x] right panel width disappears from sessions file — same fix
- [x] Height of tabs too small — resolved
- [x] closed unsaved buffers need to be deleted — verified correct, dead-code comment removed
- [x] assets are not handled correctly when buffer becomes note — asset path depth now computed from folder depth
- [x] markdown changes are lost when switch back to wysiwyg — setContent deferred with requestAnimationFrame
