# How the sidebar's items work

The library tree has four items that are not folders of notes: **Notebooks** first, **Diary**
directly after it, **Chats** directly after Diary, **Buffers** last. Each is a folder-like row rendered in place by
`SideBarHandler.Render` (`requesthandlers/sidebar_handler.go`) inside its own element, and each
keeps its expansion as a folder does: an id in `Session.OpenFolders`, set through
`PATCH /api/folder/{id}`. The sidebar search view shows none of them.

| Item | Present | Template | Element | Tree id | Refetches itself |
|---|---|---|---|---|---|
| Notebooks | while Ink is enabled | `ink_sidebar.html` | `#sidebar-ink` | `ink` (`inkTreeID`) | `GET /ui/views/sidebar/ink` on `sieve:invalidate-ink from:document` |
| Diary | while Ink is enabled and a diary chunk is held | `diary_sidebar.html` | `#sidebar-diary` | `diary` (`diaryTreeID`) | `GET /ui/views/sidebar/diary` on `sieve:invalidate-ink from:document` |
| Chats | always | `chats_sidebar.html` | `#sidebar-chats` | `chats` (`chatsTreeID`) | `GET /ui/views/sidebar/chats` on `sieve:invalidate-chats from:document` |
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

## Chats

- A folder-like row with a speech-bubble icon, `chat_icon`, drawn as the Notebooks item is. Its
  context menu (`data-ctx-type="chats"`) offers New Chat.
- Expanded: a row per chat, most recently changed first, under quiet headings (`.chats-tree__group`)
  Today, Yesterday and Earlier, each shown only when it has rows, or "No chats yet". The grouping
  is Go's: `chatsSidebarView.show` puts each hit under `chatsSidebarView.dayGroup` of its
  `Modified` at the reader's now (a chat that does not say is Earlier). At its right a row says,
  quietly (`.chats-tree__when`), when its chat last changed: the time on the day it is read, the
  weekday on the six days before, the day and month before that (`chatsSidebarView.changedAt`).
- Each row is a CHAT row to `context-menu.js` (`data-ctx-type="chat"`), opens the chat, and offers
  Open, Name now, Rename… and Delete; the chat's tab offers the same but Open, then every tab's
  verbs. Name now is `POST /api/chat/{id}/describe` and Rename… the rename dialog (`type=chat`)
  posting to `POST /api/chat/{id}/rename`: both are `ChatHandler`'s, over `ChatNamer`
  ("Naming a chat" below). Delete asks first, in the delete dialog's chat wording, then
  `DELETE /api/chat/{id}` removes the chat and its files through `ChatService`, ends its open
  session and closes its tab.
- Its list is ONE search: `SideBarHandler.chatCriteria` (no terms, `NAME`, kind `chat`) through
  `ServiceProvider.Search`, which `ChatService.Search` answers newest first. Data:
  `chatsSidebarView.show` in `requesthandlers/sidebar_handler.go`; `GET /ui/views/sidebar/chats`
  serves the item alone.
- New Chat is `POST /api/chat` (`ChatHandler`, `requesthandlers/chat_handler.go`): it creates an
  untitled chat through `ChatService` and opens it in a tab. It is also File › New Chat,
  `Mod+Shift+N`, through `window.sieveWorkspace.newChat()`.
- It refetches ONLY itself, on the `chats` topic, which is raised when a chat is created
  (`ChatHandler`), deleted (`ChatHandler`) or called something else
  (`WorkspaceBroadcast.ChatNamed`, which `EditorService` calls after a chat's save and `ChatNamer`
  after a description or a rename, and which also raises `session`, because the chat's tab is
  named by it).
- A chat's tab is kind `chat`, is named by `domain.Chat.Name`, and carries a CHAT tag before the
  name, in the icon's place: small, mono, in `--theme-accentTeal`, on no pill. A chat is
  never a buffer: closing its tab files nothing, and it has no keep or trash intent.
- Styles: the Ink item's `.ink-tree*`, and `.chats-tree__group` and `.chats-tree__when` in
  `sidebar.css`.

### Naming a chat

- A chat is called by its name (`domain.Chat.Title`, its `.meta` `display_name`), else by the
  opening words of its first question. Its description is kept under the keys a notebook's is
  (`domain.NoteMetadata.WriteTo`): `display_name`, `summary`, `tags`, `note_keywords`,
  `note_categories`, `note_meta_seq` (for a chat, how many answered exchanges it was of) and
  `note_named_by` (`hand`). `ChatService.Describe` and `ChatService.Rename` write them through
  `ChatService.SaveMeta`, the `.meta` alone: the version does not move and no snapshot is written.
- The workspace Meta panel shows a chat's meta (`MetaHandler.chatView`) in a note's words: Display name, Name you gave (a name given by hand), CLI and AI described (the `cli` and `ai_last_evaluated` keys a note's filing writes, which a description records through `DocumentMeta.RecordAiRun` and `AIService.DescribeChat` reports), Summary, Tags and Categories, then Modified and the uuid; what is not known is a dash.
- **`ChatNamer`** (`sieve/editor/chat_namer.go`) describes a chat after its first answer, and again
  each time it settles having grown: no question asked and no job of it running for
  `chat.settle_seconds` (default five minutes, Settings › Chats), counted from the chat's
  `modified`, across a restart alike. It hears a chat's job end from `EditorService`
  (`ChatAnsweredListener`), reads every chat when it starts and whenever its one timer fires, and
  runs ONE AI-pool job, `AIService.DescribeChat` (task `chat-meta`), shown each answered exchange's
  question and answer (`block.ChatView.Answered`) and offered the library's top-level folders as
  categories. A chat that has not grown is not described again; one whose description failed
  waits until it grows.
- **`ChatNamer.NameNow`** describes a chat at once; **`ChatNamer.Rename`** gives a name by hand,
  which every later description keeps while describing the rest. A blank name hands naming back:
  the chat counts as never described and is described at once.
- `ChatService.Search` matches a chat's name, summary, and keywords and categories as its tags, as a
  notebook's search does; the `search` MCP tool says so.

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
