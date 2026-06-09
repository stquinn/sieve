 File path usage in the frontend — places where the frontend is aware of file paths (ongoing list as requested):

  ┌─────────────────────┬──────────────────┬───────────────────────────────────────────────────────────┐
  │        File         │     Line(s)      │                       What it does                        │
  ├─────────────────────┼──────────────────┼───────────────────────────────────────────────────────────┤
  │ Sidebar.tsx         │ 107              │ path.split('/').pop() — filename for delete dialog        │
  ├─────────────────────┼──────────────────┼───────────────────────────────────────────────────────────┤
  │ Sidebar.tsx         │ 133–134          │ parent dir + filename concat for rename                   │
  ├─────────────────────┼──────────────────┼───────────────────────────────────────────────────────────┤
  │ Sidebar.tsx         │ 159              │ ${parentPath || 'store'}/${name} — construct folder path  │
  ├─────────────────────┼──────────────────┼───────────────────────────────────────────────────────────┤
  │ Sidebar.tsx         │ 228–229          │ filename split + store/${fileName} — drag to root         │
  ├─────────────────────┼──────────────────┼───────────────────────────────────────────────────────────┤
  │ Sidebar.tsx         │ 402–403          │ filename split + ${basePath}/${fileName} — drag to folder │
  ├─────────────────────┼──────────────────┼───────────────────────────────────────────────────────────┤
  │ TabBar.tsx          │ 153              │ path?.split('/').pop() — filename for delete dialog       │
  ├─────────────────────┼──────────────────┼───────────────────────────────────────────────────────────┤
  │ TabBar.tsx          │ 164, 172–174     │ parent dir + filename concat for rename                   │
  ├─────────────────────┼──────────────────┼───────────────────────────────────────────────────────────┤
  │ TabBar.tsx          │ 183–184          │ path.startsWith('prompt:') + path.split(':').pop()        │
  ├─────────────────────┼──────────────────┼───────────────────────────────────────────────────────────┤
  │ App.tsx             │ 108, 138, 178    │ doc.path serialised into session                          │
  ├─────────────────────┼──────────────────┼───────────────────────────────────────────────────────────┤
  │ App.tsx             │ 198              │ tabs.findIndex(...path === path) — find open tab by path  │
  ├─────────────────────┼──────────────────┼───────────────────────────────────────────────────────────┤
  │ App.tsx             │ 343              │ dataService.load(t.path) — restore session from path      │
  ├─────────────────────┼──────────────────┼───────────────────────────────────────────────────────────┤
  │ App.tsx             │ 377–378          │ prompt:${name} — constructing and matching prompt paths   │
  ├─────────────────────┼──────────────────┼───────────────────────────────────────────────────────────┤
  │ App.tsx             │ 405              │ getAncestorPaths(path) — expanding sidebar folders        │
  ├─────────────────────┼──────────────────┼───────────────────────────────────────────────────────────┤
  │ App.tsx             │ 454–455          │ passing doc?.path to Sidebar activePath / openPaths       │
  ├─────────────────────┼──────────────────┼───────────────────────────────────────────────────────────┤
  │ fmUtils.ts          │ getAncestorPaths │ strips store/ prefix, splits on /                         │
  ├─────────────────────┼──────────────────┼───────────────────────────────────────────────────────────┤
  │ NoteContextMenu.tsx │ 101              │ path.split(':').pop() — extract prompt name for display   │
  └─────────────────────┴──────────────────┴───────────────────────────────────────────────────────────┘

  The biggest systemic issue: paths are used as tab identity throughout the session (serialised in stash.Session). The fix would be to store only UUIDs in session and resolve paths on the Go side
  — that's a deeper architectural change.

✻ Worked for 9m 49s

❯ So a folder is actually a Storeable - why do we need Paths?  The entire point was by modelling the Structure properly we wold do away with all of this kind of things.  I terms of the
  PromptStoreabel - we control both ends - we doul have just added a name attribute to the PromptStoreable

⏺ You're right. The path manipulation is a symptom of incomplete abstraction — the domain model leaks file system structure into the UI layer. Let me look at the current state of both ends before
  saying anything more:

  Searched for 2 patterns, read 3 files (ctrl+o to expand)

⏺ Now I see the full picture. The diagnosis is clear:

  The core problem is path is doing two jobs it shouldn't:

  1. Identity — path is used as the tab's address in session, as the open-state key in openPaths/activePath, as the argument to every load/save/discard call. It should be the UUID.
  2. Display/navigation — path.split('/').pop() to get a filename, path.substring(0, path.lastIndexOf('/')) to get a parent, ${parent}/${name} to construct sibling paths. That should come from the
   domain model — a name field on the storable and a parentId reference.

  For PromptStorable specifically: id = path = "prompt:name" — and then the frontend splits on : everywhere to recover name. You're right that we just needed name: string as a first-class field.
  The PromptEntry already carries name from the sidebar, but the Storable contract throws it away.

  For folders: NoteEntry carries path (the store-relative file path) as the identifier for toggling, drag-and-drop target construction, rename/delete operations. A folder Storable with its own id
  and a name field would eliminate all the ${basePath}/${fileName} constructions.

  For notes: ExternalRef() (the file path) is what flows through. The store already has Key() which is path-relative. The UUID would need to be promoted — it's already in the meta map (uuid key)
  but isn't surfaced as a first-class field in NoteEntry.

  The practical fix — in priority order:

  1. Add name: string to PromptStorable and surface it through PromptEntry — eliminates all prompt: string manipulation immediately
  2. Add id: string (the UUID) to NoteEntry — sessions and open-state can use UUID instead of path
  3. Folders: NoteEntry folder items already have name, but rename/move constructs target paths from parts — a proper parentId + name model on the Go bridge would fix that

  Want me to start with the prompt fix since, as you said, we control both ends and it's the cleanest demonstration of the principle?