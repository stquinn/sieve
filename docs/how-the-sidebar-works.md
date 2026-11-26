# How the sidebar's items work

The library tree has three items that are not folders of notes: **Notebooks** first, **Diary**
directly after it, **Buffers** last. Each is a folder-like row rendered in place by
`SideBarHandler.Render` (`requesthandlers/sidebar_handler.go`) inside its own element, and each
keeps its expansion as a folder does: an id in `Session.OpenFolders`, set through
`PATCH /api/folder/{id}`. The sidebar search view shows none of them.

| Item | Present | Template | Element | Tree id | Refetches itself |
|---|---|---|---|---|---|
| Notebooks | while Ink is enabled | `ink_sidebar.html` | `#sidebar-ink` | `ink` (`inkTreeID`) | `GET /ui/views/sidebar/ink` on `sieve:invalidate-ink from:document` |
| Diary | while Ink is enabled and a diary chunk is held | `diary_sidebar.html` | `#sidebar-diary` | `diary` (`diaryTreeID`) | `GET /ui/views/sidebar/diary` on `sieve:invalidate-ink from:document` |
| Buffers | always | `buffers_sidebar.html` | `#sidebar-buffers` | `buffers` (`buffersTreeID`) | no trigger of its own |

Templates are in `frontend/src/templates/`; styles are in `sidebar.css`.

## Notebooks

- A folder-like row with its own pen icon in `--theme-accentPrimary` and a live dot while
  collapsed. It has no menu of its own.
- Expanded: the Live row (`data-ctx-type="inkLive"`), then the synced notebooks
  (`data-ctx-type="notebook"`). Their menus — and their tabs' — are built by `context-menu.js`.
- Data: `inkSidebarView.show` in `requesthandlers/ink.go`; the fragment is served by
  `InkHandler.handleSidebar`.
- It refetches ONLY itself, so ink changes never re-render the tree; the tree's own triggers
  re-render both.
- Diary chunks are not in its list, but it still emits the hidden `data-ink-facts` markers for
  every synced note, chunks too.
- Styles: `.ink-tree*`.

## Diary

- A folder-like row with a calendar icon, `diary_icon` — the one the sidebar search also draws a
  diary chunk's hit with (the hit says so in `domain.Candidate.Type`). Its chevron expands it; the
  rest of the row opens today.
- Expanded: the chunks newest first, each named by its month (`November 2026`) and a notebook row
  to `context-menu.js` (`ink_note_row`, shared with Notebooks). With several devices: a plain row
  per device opening that device's today, its chunks beneath.
- Data: `diarySidebarView.show` in `requesthandlers/ink.go`. What a diary is and where it opens on
  a day is `docs/how-ink-works.md` §10.
- It refetches ONLY itself.
- Styles: the Ink item's `.ink-tree*` plus `.diary-tree*`.

## Buffers

- A folder-like row with a dashed-page icon, italic and in `--theme-muted`, a dashed rule above it
  and a count.
- Expanded: every buffer, open in a tab or not. Each row is a NOTE row to `context-menu.js`
  (`data-ctx-type="note"`) and is not draggable.
- Its list is ONE search: `SideBarHandler.bufferCriteria` (no terms, `NAME`, kind `buffer`)
  through `ServiceProvider.Search`. Data: `buffersSidebarView.show` in
  `requesthandlers/sidebar_handler.go`; a row's intent is read from its open tab.
- It has no trigger of its own because every change to a buffer (creation, rename, intent, filing,
  deletion) raises `session` or `notes`, on which the whole tree already re-renders — a trigger of
  its own would fetch it twice. `GET /ui/views/sidebar/buffers` serves the item alone.
- Styles: `.buffers-tree*`.
