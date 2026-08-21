package requesthandlers

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"sieve/sieve"
	"sieve/sieve/ai"
	"sieve/sieve/protocol"
	"sieve/sieve/services"
	"sieve/store"
	"sieve/store/filestore"
)

// newItemServer boots the sidebar's item handlers over a real store and the
// real templates, so a CRUD round trip is proved against the bytes the app
// serves rather than a stand-in. The workspace wire is mounted alongside them
// and the announcements are wired exactly as Registry.Mount wires them, so a
// test can watch the push a real client would receive.
func newItemServer(t *testing.T) (*httptest.Server, *sieve.ServiceProvider) {
	t.Helper()
	fs, err := filestore.NewFileStore(t.TempDir(), "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	ds, err := services.NewDocumentService(fs)
	if err != nil {
		t.Fatalf("NewDocumentService: %v", err)
	}
	state, err := services.NewStateService(fs, "", nil)
	if err != nil {
		t.Fatalf("NewStateService: %v", err)
	}
	tmpl, err := NewTemplates(os.DirFS(".."))
	if err != nil {
		t.Fatalf("NewTemplates: %v", err)
	}
	sp := &sieve.ServiceProvider{Store: fs, Documents: ds, State: state}

	broadcast := NewWorkspaceBroadcast(nil)

	r := chi.NewRouter()
	(&SideBarHandler{ServiceProvider: sp, Tmpl: tmpl}).RegisterPaths(r)
	(&NoteHandler{ServiceProvider: sp, Tmpl: tmpl, EmitContainerDeleted: broadcast.ContainerDeleted}).RegisterPaths(r)
	(&ContextMenuHandler{
		ServiceProvider:      sp,
		Tmpl:                 tmpl,
		EmitContainerDeleted: broadcast.ContainerDeleted,
		EmitNotesChanged:     func() { broadcast.Invalidate(protocol.TopicNotes) },
		EmitIntentChanged:    func() { broadcast.Invalidate(protocol.TopicIntent) },
	}).RegisterPaths(r)
	(&SessionHandler{ServiceProvider: sp}).RegisterPaths(r)
	NewWsHandler(sp, broadcast).RegisterPaths(r)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return srv, sp
}

// do sends one request and returns its status and body.
func do(t *testing.T, method, url, contentType, body string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	defer resp.Body.Close()
	got, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(got)
}

// folderID finds a folder by display name in the listed tree.
func folderID(t *testing.T, sp *sieve.ServiceProvider, name string) string {
	t.Helper()
	entries, err := sp.Documents.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	for _, e := range entries {
		if e.IsDir && e.Name == name {
			return e.ID
		}
	}
	return ""
}

// A note is one resource with one path: PATCH renames it, and both encodings of
// the same body are accepted — the JSON a typed client sends and the urlencoded
// form the rename dialog submits.
func TestNotePatch_RenamesFromEitherEncoding(t *testing.T) {
	srv, sp := newItemServer(t)

	for _, enc := range []struct {
		name        string
		contentType string
		body        string
		want        string
	}{
		{"json", "application/json", `{"name":"From JSON"}`, "From JSON"},
		{"form", "application/x-www-form-urlencoded", "name=From+Form", "From Form"},
	} {
		t.Run(enc.name, func(t *testing.T) {
			doc, err := sp.Documents.New()
			if err != nil {
				t.Fatalf("New: %v", err)
			}
			doc, _ = sp.Documents.Save(doc)

			status, body := do(t, http.MethodPatch, srv.URL+"/api/note/"+doc.UUID(), enc.contentType, enc.body)
			if status != http.StatusOK {
				t.Fatalf("status %d: %s", status, body)
			}
			renamed, err := sp.Documents.LoadByUUID(doc.UUID())
			if err != nil {
				t.Fatalf("LoadByUUID: %v", err)
			}
			if got := renamed.Meta().DisplayName(); got != enc.want {
				t.Errorf("display name = %q, want %q", got, enc.want)
			}
			if !strings.Contains(body, "sidebar") {
				t.Errorf("a rename answers with the refreshed sidebar, got %q", body)
			}
		})
	}

	// A patch with nothing to change is a bad request, not a silent no-op.
	if status, _ := do(t, http.MethodPatch, srv.URL+"/api/note/whatever", "application/json", `{}`); status != http.StatusBadRequest {
		t.Errorf("empty patch status = %d, want 400", status)
	}
}

// Deleting a note answers with three things at once, and two of them are easy
// to get subtly wrong: the sidebar must ride back as a CONTENT swap (an
// outerHTML replacement would strip the host's layout style and its whole
// refresh-trigger set for the rest of the session), and the deletion must be
// announced on the workspace wire, because no swap in this response reaches the
// Tab of a note that was open in the BACKGROUND — nor any other window at all.
func TestNoteDelete_KeepsTheSidebarHostAndAnnouncesTheDeletion(t *testing.T) {
	srv, sp := newItemServer(t)

	doc, err := sp.Documents.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	doc, _ = sp.Documents.Save(doc)

	ws := dialWorkspaceWS(t, srv)
	defer ws.Close()

	req, err := http.NewRequest(http.MethodDelete, srv.URL+"/api/note/"+doc.UUID(), nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	body := string(raw)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d: %s", resp.StatusCode, body)
	}

	// The HOST survives: nothing in the answer re-declares #htmx-sidebar, so
	// index.html's element — style, hx-get and every hx-trigger on it — stands.
	if strings.Contains(body, `id="htmx-sidebar"`) {
		t.Errorf("the answer re-declares the sidebar host, which strips its triggers: %q", body)
	}
	if !strings.Contains(body, `hx-swap-oob="innerHTML:#htmx-sidebar"`) {
		t.Errorf("the sidebar must ride back as a content swap, got %q", body)
	}
	// …and it carries the rendered tree, so the sidebar is fresh without a
	// second round trip.
	if !strings.Contains(body, "sidebar__section-title") {
		t.Errorf("the OOB sidebar swap carries no tree: %q", body)
	}

	// The deletion is broadcast, not carried in a response header: a header
	// reaches only the requester, and the clients that must reconcile are every
	// other one — including the window that never made this request.
	if got := resp.Header.Get("HX-Trigger-After-Settle"); got != "" {
		t.Errorf("HX-Trigger-After-Settle = %q, want nothing — the wire carries this now", got)
	}
	news := readFrame(t, ws, 2*time.Second)
	if news["type"] != protocol.TypeContainerDeleted || news["uuid"] != doc.UUID() {
		t.Errorf("workspace frame = %v, want container-deleted naming %s", news, doc.UUID())
	}

	if _, err := sp.Documents.LoadByUUID(doc.UUID()); err == nil {
		t.Error("note survived its delete")
	}
}

// seedNotesInFolder creates the named folder, files a note per title under it,
// and returns the folder's id with the set of uuids it now holds.
func seedNotesInFolder(t *testing.T, srv *httptest.Server, sp *sieve.ServiceProvider, folderName string, titles ...string) (string, map[string]bool) {
	t.Helper()
	if status, body := do(t, http.MethodPost, srv.URL+"/api/folder", "application/json", `{"name":"`+folderName+`"}`); status != http.StatusOK {
		t.Fatalf("create folder status %d: %s", status, body)
	}
	folder := folderID(t, sp, folderName)
	if folder == "" {
		t.Fatal("created folder is not in the tree")
	}

	held := map[string]bool{}
	for _, name := range titles {
		doc, err := sp.Documents.New()
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		if doc, err = sp.Documents.Save(doc); err != nil {
			t.Fatalf("Save: %v", err)
		}
		// A buffer lives outside the library and folders are a library-side
		// notion, so file it before moving it under the folder. Rename comes
		// after: a document's directory is named for its display name, and two
		// same-minute notes would otherwise collide on the move.
		if doc, err = sp.Documents.File(doc); err != nil {
			t.Fatalf("File: %v", err)
		}
		if doc, err = sp.Documents.Rename(doc, name); err != nil {
			t.Fatalf("Rename: %v", err)
		}
		if _, err := sp.Documents.Move(doc, folderName); err != nil {
			t.Fatalf("Move: %v", err)
		}
		held[doc.UUID()] = true
	}
	return folder, held
}

// Deleting a folder deletes every document beneath it — the Store removes the
// whole directory — so each one is announced by uuid. A client holding a note
// from that folder open has no other way to learn its document is gone.
func TestFolderDelete_AnnouncesEveryDocumentItTookWithIt(t *testing.T) {
	srv, sp := newItemServer(t)
	folder, want := seedNotesInFolder(t, srv, sp, "Doomed", "First", "Second")

	ws := dialWorkspaceWS(t, srv)
	defer ws.Close()

	if status, body := do(t, http.MethodDelete, srv.URL+"/api/folder/"+folder, "", ""); status != http.StatusOK {
		t.Fatalf("delete folder status %d: %s", status, body)
	}

	got := map[string]bool{}
	for range want {
		frame := readFrame(t, ws, 2*time.Second)
		if frame["type"] != protocol.TypeContainerDeleted {
			t.Fatalf("workspace frame = %v, want container-deleted", frame)
		}
		uuid, ok := frame["uuid"].(string)
		if !ok {
			t.Fatalf("container-deleted carries no uuid string: %v", frame)
		}
		got[uuid] = true
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("announced %v, want %v", got, want)
	}
}

// A folder delete answers with the SAME workspace fragment a note delete does,
// and it has to: the announcement it just made tells every client to destroy the
// editor behind each deleted uuid. Answer with the sidebar alone and the window
// that had one of those notes open is left with a torn-down editor, a mount
// still stamped with the dead uuid, and nothing to re-init it — a blank dead
// end no further interaction recovers from.
func TestFolderDelete_HandsBackAWorkspaceWhenItTookTheActiveNote(t *testing.T) {
	srv, sp := newItemServer(t)
	folder, held := seedNotesInFolder(t, srv, sp, "Doomed", "First", "Second")

	// Open a survivor first, then the doomed notes, so the active tab is one the
	// folder takes and a tab that must SURVIVE sits ahead of them in the strip.
	survivor := newSavedNote(t, sp)
	if status, body := do(t, http.MethodPost, srv.URL+"/api/note/open/"+survivor, "", ""); status != http.StatusOK {
		t.Fatalf("open survivor status %d: %s", status, body)
	}
	var active string
	for uuid := range held {
		if status, body := do(t, http.MethodPost, srv.URL+"/api/note/open/"+uuid, "", ""); status != http.StatusOK {
			t.Fatalf("open doomed status %d: %s", status, body)
		}
		active = uuid
	}
	if session := sp.State.LoadSession(); session.Tabs[session.ActiveIdx].ID != active {
		t.Fatalf("setup: active tab is %s, want the doomed %s", session.Tabs[session.ActiveIdx].ID, active)
	}

	status, body := do(t, http.MethodDelete, srv.URL+"/api/folder/"+folder, "", "")
	if status != http.StatusOK {
		t.Fatalf("delete folder status %d: %s", status, body)
	}

	// The response carries a live editor mount for the tab that survived, which
	// is the signal the client re-inits on.
	if !strings.Contains(body, `id="tiptap-mount"`) {
		t.Error("the answer carries no editor mount, so nothing re-mounts")
	}
	if !strings.Contains(body, `data-uuid="`+survivor+`"`) {
		t.Errorf("the editor mount does not name the surviving note %s", survivor)
	}
	for uuid := range held {
		if strings.Contains(body, `data-uuid="`+uuid+`"`) {
			t.Errorf("the editor mount names the deleted note %s", uuid)
		}
	}
	// …alongside the tab strip and the sidebar, on the same terms the note
	// delete answers: the sidebar as a CONTENT swap, so its host survives.
	if !strings.Contains(body, `id="tabs-area"`) {
		t.Error("the answer is not the tab strip")
	}
	if !strings.Contains(body, `hx-swap-oob="innerHTML:#htmx-sidebar"`) {
		t.Errorf("the sidebar must ride back as a content swap, got %q", body)
	}
	if strings.Contains(body, `id="htmx-sidebar"`) {
		t.Errorf("the answer re-declares the sidebar host, which strips its triggers: %q", body)
	}

	// The server session agrees with what it just sent: no tab names a document
	// the store no longer has.
	session := sp.State.LoadSession()
	for _, tab := range session.Tabs {
		if held[tab.ID] {
			t.Errorf("session still holds a tab for the deleted note %s", tab.ID)
		}
	}
	if len(session.Tabs) != 1 || session.Tabs[0].ID != survivor {
		t.Fatalf("session tabs = %v, want only the survivor %s", session.Tabs, survivor)
	}
	if session.Tabs[session.ActiveIdx].ID != survivor {
		t.Errorf("active tab = %s, want the survivor %s", session.Tabs[session.ActiveIdx].ID, survivor)
	}
}

// The active tab is re-pointed by IDENTITY, not by an index left where it was:
// closing tabs out from under it shifts every later tab left, so an untouched
// index silently activates a different note. This is the multi-uuid case the
// folder delete introduced, but the note delete goes through the same seam.
func TestFolderDelete_KeepsTheReaderOnTheNoteTheyWereReading(t *testing.T) {
	srv, sp := newItemServer(t)
	folder, held := seedNotesInFolder(t, srv, sp, "Doomed", "First")

	// The strip ends up [doomed, reading, trailing] with the MIDDLE tab active:
	// one deletion ahead of it, one survivor behind, so leaving the index where
	// it is quietly activates the trailing note instead.
	openUUIDs := []string{}
	for uuid := range held {
		openUUIDs = append(openUUIDs, uuid)
	}
	reading := newSavedNote(t, sp)
	trailing := newSavedNote(t, sp)
	for _, uuid := range append(openUUIDs, reading, trailing, reading) {
		if status, body := do(t, http.MethodPost, srv.URL+"/api/note/open/"+uuid, "", ""); status != http.StatusOK {
			t.Fatalf("open %s status %d: %s", uuid, status, body)
		}
	}
	if session := sp.State.LoadSession(); session.Tabs[session.ActiveIdx].ID != reading {
		t.Fatalf("setup: active tab is %s, want %s", session.Tabs[session.ActiveIdx].ID, reading)
	}

	if status, body := do(t, http.MethodDelete, srv.URL+"/api/folder/"+folder, "", ""); status != http.StatusOK {
		t.Fatalf("delete folder status %d: %s", status, body)
	}

	session := sp.State.LoadSession()
	if got := session.Tabs[session.ActiveIdx].ID; got != reading {
		t.Errorf("active tab = %s, want the untouched note %s the user was reading", got, reading)
	}
}

// newSavedNote mints a buffer and persists it, returning its uuid.
func newSavedNote(t *testing.T, sp *sieve.ServiceProvider) string {
	t.Helper()
	doc, err := sp.Documents.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	doc, err = sp.Documents.Save(doc)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	return doc.UUID()
}

// A folder's whole lifecycle over its own path: created, renamed, expanded,
// collapsed, deleted.
func TestFolderCRUD_LifecycleOverOnePath(t *testing.T) {
	srv, sp := newItemServer(t)

	if status, body := do(t, http.MethodPost, srv.URL+"/api/folder", "application/json", `{"name":"Ideas"}`); status != http.StatusOK {
		t.Fatalf("create status %d: %s", status, body)
	}
	id := folderID(t, sp, "Ideas")
	if id == "" {
		t.Fatal("created folder is not in the tree")
	}

	// open is SET, not toggled: asking twice for the same state leaves it there.
	for i := 0; i < 2; i++ {
		if status, body := do(t, http.MethodPatch, srv.URL+"/api/folder/"+id, "application/json", `{"open":true}`); status != http.StatusOK {
			t.Fatalf("open status %d: %s", status, body)
		}
		if open := sp.State.LoadSession().OpenFolders; len(open) != 1 || open[0] != id {
			t.Fatalf("after %d opens, OpenFolders = %v", i+1, open)
		}
	}
	if status, _ := do(t, http.MethodPatch, srv.URL+"/api/folder/"+id, "application/json", `{"open":false}`); status != http.StatusOK {
		t.Fatalf("close status %d", status)
	}
	if open := sp.State.LoadSession().OpenFolders; len(open) != 0 {
		t.Errorf("OpenFolders after close = %v, want empty", open)
	}

	if status, body := do(t, http.MethodDelete, srv.URL+"/api/folder/"+id, "", ""); status != http.StatusOK {
		t.Fatalf("delete status %d: %s", status, body)
	}
	if folderID(t, sp, "Ideas") != "" {
		t.Error("folder survived its delete")
	}
}

// A patch carrying only a name must leave the open state alone — the two
// properties travel in one request precisely so that neither implies the other.
func TestFolderPatch_NameOnlyLeavesTheOpenStateAlone(t *testing.T) {
	srv, sp := newItemServer(t)

	if status, _ := do(t, http.MethodPost, srv.URL+"/api/folder", "application/json", `{"name":"Ideas"}`); status != http.StatusOK {
		t.Fatalf("create status %d", status)
	}
	id := folderID(t, sp, "Ideas")
	if status, _ := do(t, http.MethodPatch, srv.URL+"/api/folder/"+id, "application/json", `{"open":true}`); status != http.StatusOK {
		t.Fatalf("open status %d", status)
	}

	if status, body := do(t, http.MethodPatch, srv.URL+"/api/folder/"+id, "application/json", `{"name":"Later"}`); status != http.StatusOK {
		t.Fatalf("rename status %d: %s", status, body)
	}
	if folderID(t, sp, "Later") != id {
		t.Error("folder was not renamed to Later")
	}

	if open := sp.State.LoadSession().OpenFolders; len(open) != 1 || open[0] != id {
		t.Errorf("a name-only patch changed the open state: %v", open)
	}
}

// Every panel toggles through ONE route: the panel is a parameter, the flag it
// flips and the OOB <style> it answers with are the panel's own.
func TestSessionToggle_EveryPanelFlipsItsOwnFlag(t *testing.T) {
	srv, sp := newItemServer(t)

	for _, panel := range []struct {
		name    string
		styleID string
		flag    func() bool
	}{
		{"sidebar", "layout-overrides-sidebar", func() bool { return sp.State.LoadSession().ShowSidebar }},
		{"meta", "layout-overrides-meta", func() bool { return sp.State.LoadSession().ShowMeta }},
		{"prompts", "layout-overrides-prompts", func() bool { return sp.State.LoadSession().ShowPrompts }},
		{"toolbar", "layout-overrides-toolbar", func() bool { return sp.State.LoadSession().ShowToolbar }},
		{"linenumbers", "layout-overrides-linenumbers", func() bool { return sp.State.LoadSession().ShowLineNumbers }},
		{"askpanel", "layout-overrides-askpanel", func() bool { return sp.State.LoadSession().ShowAskPanel }},
	} {
		t.Run(panel.name, func(t *testing.T) {
			before := panel.flag()
			status, body := do(t, http.MethodPost, srv.URL+"/api/session/toggle/"+panel.name, "", "")
			if status != http.StatusOK {
				t.Fatalf("status %d: %s", status, body)
			}
			if panel.flag() == before {
				t.Errorf("%s flag did not flip (still %v)", panel.name, before)
			}
			if !strings.Contains(body, panel.styleID) || !strings.Contains(body, `hx-swap-oob="true"`) {
				t.Errorf("answer must be the panel's OOB style, got %q", body)
			}
		})
	}

	if status, _ := do(t, http.MethodPost, srv.URL+"/api/session/toggle/nonesuch", "", ""); status != http.StatusNotFound {
		t.Errorf("unknown panel status = %d, want 404", status)
	}
}

// The three dialogs are one route: the kind picks the template, an unknown kind
// is refused rather than answered with an empty dialog.
func TestSidebarDialog_KindPicksTheTemplate(t *testing.T) {
	srv, _ := newItemServer(t)

	for _, dialog := range []struct{ kind, query, want string }{
		{"rename", "?id=n1&name=Draft&type=note", "Rename Note"},
		{"delete", "?id=n1&name=Draft&type=folder", "Delete Folder"},
		{"create-folder", "?parentId=f1", "Create New Folder"},
	} {
		status, body := do(t, http.MethodGet, srv.URL+"/ui/views/sidebar/dialog/"+dialog.kind+dialog.query, "", "")
		if status != http.StatusOK {
			t.Fatalf("%s status %d", dialog.kind, status)
		}
		if !strings.Contains(body, dialog.want) {
			t.Errorf("%s dialog does not read %q: %q", dialog.kind, dialog.want, body)
		}
	}

	if status, _ := do(t, http.MethodGet, srv.URL+"/ui/views/sidebar/dialog/nonesuch", "", ""); status != http.StatusNotFound {
		t.Errorf("unknown dialog status = %d, want 404", status)
	}
}

// Setting an intent is announced on the workspace wire as well as in the
// response header. The header reaches the one client that clicked; the meta
// panel restating that intent may be open in another window, and the broadcast
// is the only thing that reaches it.
func TestSidebarIntent_AnnouncesTheIntentOnTheWire(t *testing.T) {
	srv, sp := newItemServer(t)

	doc, err := sp.Documents.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if doc, err = sp.Documents.Save(doc); err != nil {
		t.Fatalf("Save: %v", err)
	}

	ws := dialWorkspaceWS(t, srv)
	defer ws.Close()

	if status, body := do(t, http.MethodPost,
		srv.URL+"/api/sidebar/intent?id="+doc.UUID()+"&value=keep", "", ""); status != http.StatusOK {
		t.Fatalf("set intent status %d: %s", status, body)
	}

	// The intent topic rides alongside notes, so read past whatever arrives first.
	deadline := time.Now().Add(2 * time.Second)
	for {
		if time.Now().After(deadline) {
			t.Fatal("no invalidate frame named the intent topic — the topic is published but nothing emits it")
		}
		frame := readUntil(t, ws, protocol.TypeInvalidate, time.Until(deadline))
		if frame["topic"] == string(protocol.TopicIntent) {
			break
		}
	}

	reloaded, err := sp.Documents.LoadByUUID(doc.UUID())
	if err != nil {
		t.Fatalf("LoadByUUID: %v", err)
	}
	intent := reloaded.Meta().UserIntent()
	if intent == nil || *intent != "keep" {
		t.Errorf("stored user_intent = %v, want keep", intent)
	}
}

// undeletableStore is a Store whose Delete always fails, so a test can drive the
// failure branch of an operation that ends in one.
type undeletableStore struct {
	store.Store
}

func (undeletableStore) Delete(store.Storable) error {
	return errors.New("store is read-only")
}

// A revert that did not happen announces nothing. The prompt override is still
// on disk, so a prompts:changed — on the wire or in the header — would send
// every client to refetch a library that still holds the thing they asked to
// remove, and the requester would read 204 as success.
func TestRevertPrompt_AnnouncesNothingWhenTheDeleteFails(t *testing.T) {
	fs, err := filestore.NewFileStore(t.TempDir(), "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	prompts, err := ai.NewPromptService(undeletableStore{fs})
	if err != nil {
		t.Fatalf("NewPromptService: %v", err)
	}
	if err := prompts.SavePrompt("file", "an override to revert"); err != nil {
		t.Fatalf("SavePrompt: %v", err)
	}

	announced := []string{}
	h := &ContextMenuHandler{
		ServiceProvider:    &sieve.ServiceProvider{Store: fs, Prompts: prompts},
		EmitPromptsChanged: func() { announced = append(announced, "prompts") },
		EmitNotesChanged:   func() { announced = append(announced, "notes") },
	}
	r := chi.NewRouter()
	h.RegisterPaths(r)
	srv := httptest.NewServer(r)
	defer srv.Close()

	status, _ := do(t, http.MethodPost, srv.URL+"/api/sidebar/revert-prompt?id=prompt:file", "", "")
	if status != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500 — the revert did not happen", status)
	}
	if len(announced) != 0 {
		t.Errorf("announced %v, want nothing — the override is still on disk", announced)
	}
}
