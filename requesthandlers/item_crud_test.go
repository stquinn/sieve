package requesthandlers

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"sieve/sieve"
	"sieve/sieve/ai"
	"sieve/sieve/block"
	"sieve/sieve/block/processors"
	"sieve/sieve/domain"
	"sieve/sieve/editor"
	"sieve/sieve/ink"
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
	srv, sp, _ := newItemServerCountingSession(t)
	return srv, sp
}

// newItemServerCountingSession is newItemServer that also reports how many
// times the session handler broadcast a session change.
func newItemServerCountingSession(t *testing.T) (*httptest.Server, *sieve.ServiceProvider, *int) {
	t.Helper()
	srv, sp, sessionChanges, _ := newItemServerCountingJobs(t)
	return srv, sp, sessionChanges
}

// newItemServerCountingJobs is newItemServerCountingSession that also counts the
// job tracker's transitions — what a close that files would move. Block
// containers open beside documents, the tab strip and the asset route are
// mounted, and the AI brain is absent, so a filing job that does run fails in
// its worker without a CLI.
func newItemServerCountingJobs(t *testing.T) (*httptest.Server, *sieve.ServiceProvider, *int, *atomic.Int32) {
	t.Helper()
	sessionChanges := 0
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
	containers, err := services.NewBlockContainerService(fs, block.GlobalRegistry())
	if err != nil {
		t.Fatalf("NewBlockContainerService: %v", err)
	}
	es := editor.NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	es.SetContainers(containers)
	containers.SetChangeListener(es)
	jobs := services.NewJobTracker()
	transitions := &atomic.Int32{}
	jobs.Notify = func() { transitions.Add(1) }
	es.SetJobs(jobs)
	es.SetEngine(services.NewJobEngine(map[string]int{block.CategoryAI: 1}, 1, jobs))
	t.Cleanup(es.CloseAll)
	sp := &sieve.ServiceProvider{
		Store: fs, Documents: ds, State: state, Containers: containers, Editor: es, Jobs: jobs,
		Nodes:  editor.NewRouter(editor.NewNotesSource(ds), editor.NewBlockSource(containers)),
		Assets: services.NewAssetService(fs, ""),
	}

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
	(&SessionHandler{ServiceProvider: sp, Tmpl: tmpl, EmitSessionChanged: func() { sessionChanges++ }}).RegisterPaths(r)
	(&TabHandler{ServiceProvider: sp, Tmpl: tmpl}).RegisterPaths(r)
	NewAssetHandler(sp, nil).RegisterPaths(r)
	NewWsHandler(sp, broadcast, testWSToken).RegisterPaths(r)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return srv, sp, &sessionChanges, transitions
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

// #89 — the folder delete dialog used to claim the folder "must be empty" while
// the delete was os.RemoveAll. A confirmation that cannot name what it destroys
// is not a confirmation, so the copy counts what goes and the button is gated
// behind typing the folder name.
func TestSidebarDialog_FolderDeleteNamesWhatItDestroys(t *testing.T) {
	srv, sp := newItemServer(t)
	folder, _ := seedNotesInFolder(t, srv, sp, "Doomed", "First", "Second")

	status, body := do(t, http.MethodGet, srv.URL+"/ui/views/sidebar/dialog/delete?id="+folder+"&name=Doomed&type=folder", "", "")
	if status != http.StatusOK {
		t.Fatalf("status %d", status)
	}
	if strings.Contains(body, "must be empty") {
		t.Error("the dialog still claims the folder must be empty")
	}
	for _, want := range []string{"also deletes", "2</strong> note", "to confirm", "delete-confirm-input", "disabled"} {
		if !strings.Contains(body, want) {
			t.Errorf("dialog does not contain %q: %s", want, body)
		}
	}
}

// An EMPTY folder is the case the original wording described, and it must not be
// gated — nothing is at stake, so asking the user to type a name would be noise.
func TestSidebarDialog_EmptyFolderDeleteIsNotGated(t *testing.T) {
	srv, sp := newItemServer(t)
	if err := sp.Documents.NewFolder("Vacant"); err != nil {
		t.Fatalf("NewFolder: %v", err)
	}
	folder := folderID(t, sp, "Vacant")

	status, body := do(t, http.MethodGet, srv.URL+"/ui/views/sidebar/dialog/delete?id="+folder+"&name=Vacant&type=folder", "", "")
	if status != http.StatusOK {
		t.Fatalf("status %d", status)
	}
	if !strings.Contains(body, "It is empty") {
		t.Errorf("empty folder dialog does not say so: %s", body)
	}
	if strings.Contains(body, "delete-confirm-input") {
		t.Error("an empty folder delete should not ask the user to type the name")
	}
}

// A folder that cannot be read must not fall back to the empty wording — that is
// the LEAST alarming copy, and it would appear exactly when the app is least
// sure what it is about to destroy.
func TestSidebarDialog_UnknownFolderIsRefusedNotDescribedAsEmpty(t *testing.T) {
	srv, _ := newItemServer(t)
	status, body := do(t, http.MethodGet, srv.URL+"/ui/views/sidebar/dialog/delete?id=nosuchfolder&name=Ghost&type=folder", "", "")
	if status != http.StatusNotFound {
		t.Errorf("status = %d, want 404 (body %q)", status, body)
	}
}

// A NOTE delete is unchanged: one document, no enumeration, no gate.
func TestSidebarDialog_NoteDeleteIsUngated(t *testing.T) {
	srv, _ := newItemServer(t)
	status, body := do(t, http.MethodGet, srv.URL+"/ui/views/sidebar/dialog/delete?id=n1&name=Draft&type=note", "", "")
	if status != http.StatusOK {
		t.Fatalf("status %d", status)
	}
	if !strings.Contains(body, "Delete Note") || strings.Contains(body, "delete-confirm-input") {
		t.Errorf("note delete dialog changed shape: %s", body)
	}
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
	if status, body := do(t, http.MethodPost, srv.URL+"/api/container/open/"+survivor, "", ""); status != http.StatusOK {
		t.Fatalf("open survivor status %d: %s", status, body)
	}
	var active string
	for uuid := range held {
		if status, body := do(t, http.MethodPost, srv.URL+"/api/container/open/"+uuid, "", ""); status != http.StatusOK {
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
		if status, body := do(t, http.MethodPost, srv.URL+"/api/container/open/"+uuid, "", ""); status != http.StatusOK {
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

// Every panel toggles through ONE route: the panel is a parameter, it flips the
// panel's own flag, broadcasts the session change and answers with no body.
func TestSessionToggle_EveryPanelFlipsItsOwnFlag(t *testing.T) {
	srv, sp, sessionChanges := newItemServerCountingSession(t)

	for _, panel := range []struct {
		name string
		flag func() bool
	}{
		{"sidebar", func() bool { return sp.State.LoadSession().ShowSidebar }},
		{"meta", func() bool { return sp.State.LoadSession().ShowMeta }},
		{"prompts", func() bool { return sp.State.LoadSession().ShowPrompts }},
		{"toolbar", func() bool { return sp.State.LoadSession().ShowToolbar }},
		{"linenumbers", func() bool { return sp.State.LoadSession().ShowLineNumbers }},
		{"askpanel", func() bool { return sp.State.LoadSession().ShowAskPanel }},
	} {
		t.Run(panel.name, func(t *testing.T) {
			before, changesBefore := panel.flag(), *sessionChanges
			status, body := do(t, http.MethodPost, srv.URL+"/api/session/toggle/"+panel.name, "", "")
			if status != http.StatusNoContent || body != "" {
				t.Fatalf("want 204 with no body, got %d %q", status, body)
			}
			if panel.flag() == before {
				t.Errorf("%s flag did not flip (still %v)", panel.name, before)
			}
			if got := *sessionChanges - changesBefore; got != 1 {
				t.Errorf("session change broadcast %d times, want 1", got)
			}
		})
	}

	if status, _ := do(t, http.MethodPost, srv.URL+"/api/session/toggle/nonesuch", "", ""); status != http.StatusNotFound {
		t.Errorf("unknown panel status = %d, want 404", status)
	}
}

// The resize POST stores the sizes and broadcasts the session change.
func TestSessionLayout_ResizeBroadcastsSessionChange(t *testing.T) {
	srv, sp, sessionChanges := newItemServerCountingSession(t)

	status, _ := do(t, http.MethodPost, srv.URL+"/api/session/layout", "application/x-www-form-urlencoded", "sidebarWidth=321")
	if status != http.StatusNoContent {
		t.Fatalf("status %d, want 204", status)
	}
	if w := sp.State.LoadSession().SidebarWidth; w != 321 {
		t.Errorf("SidebarWidth = %d, want 321", w)
	}
	if *sessionChanges != 1 {
		t.Errorf("session change broadcast %d times, want 1", *sessionChanges)
	}
}

// The layout view renders each session flag as its own data-* attribute, and the
// tier as data-tier.
func TestSessionLayoutView_RendersTheSessionFlags(t *testing.T) {
	srv, sp := newItemServer(t)

	flags := []struct {
		attr string
		set  func(*domain.Session, bool)
	}{
		{"data-sidebar", func(s *domain.Session, v bool) { s.ShowSidebar = v }},
		{"data-meta", func(s *domain.Session, v bool) { s.ShowMeta = v }},
		{"data-prompts", func(s *domain.Session, v bool) { s.ShowPrompts = v }},
		{"data-toolbar", func(s *domain.Session, v bool) { s.ShowToolbar = v }},
		{"data-line-numbers", func(s *domain.Session, v bool) { s.ShowLineNumbers = v }},
		{"data-askpanel", func(s *domain.Session, v bool) { s.ShowAskPanel = v }},
	}
	for _, flag := range flags {
		for _, on := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s=%v", flag.attr, on), func(t *testing.T) {
				session := sp.State.LoadSession()
				for _, other := range flags {
					other.set(&session, !on)
				}
				flag.set(&session, on)
				if err := sp.State.SaveSession(session); err != nil {
					t.Fatalf("SaveSession: %v", err)
				}
				status, body := do(t, http.MethodGet, srv.URL+"/ui/views/session/layout", "", "")
				if status != http.StatusOK {
					t.Fatalf("status %d: %s", status, body)
				}
				want, other := "on", "off"
				if !on {
					want, other = other, want
				}
				for _, f := range flags {
					expect := other
					if f.attr == flag.attr {
						expect = want
					}
					if attr := f.attr + `="` + expect + `"`; !strings.Contains(body, attr) {
						t.Errorf("missing %s in %q", attr, body)
					}
				}
				if !strings.Contains(body, `id="session-layout"`) {
					t.Errorf("not the state element: %q", body)
				}
			})
		}
	}

	tmpl, err := NewTemplates(os.DirFS(".."))
	if err != nil {
		t.Fatalf("NewTemplates: %v", err)
	}
	for tier, want := range map[domain.Tier]string{domain.TierSmart: "smart", domain.TierDumb: "dumb"} {
		var out strings.Builder
		if err := tmpl.ExecuteTemplate(&out, "session_layout.html", NewSessionLayoutView(domain.Session{}, tier)); err != nil {
			t.Fatalf("render: %v", err)
		}
		if attr := `data-tier="` + want + `"`; !strings.Contains(out.String(), attr) {
			t.Errorf("tier %v: missing %s in %q", tier, attr, out.String())
		}
	}
}

// The three dialogs are one route: the kind picks the template, an unknown kind
// is refused rather than answered with an empty dialog.
func TestSidebarDialog_KindPicksTheTemplate(t *testing.T) {
	srv, sp := newItemServer(t)
	folder, _ := seedNotesInFolder(t, srv, sp, "Doomed", "First")

	for _, dialog := range []struct{ kind, query, want string }{
		{"rename", "?id=n1&name=Draft&type=note", "Rename Note"},
		{"delete", "?id=" + folder + "&name=Doomed&type=folder", "Delete Folder"},
		{"delete", "?id=n2&name=Board&type=notebook", "Delete Notebook"},
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

// #92 — handleIntent used to ignore LoadByUUID's error and fall through, so an
// unknown uuid wrote nothing and then got dereferenced by the tab loop. The
// crash needed the uuid to also match an open tab id; the silent no-op needed
// nothing at all. Both are the same missing check.
func TestSidebarIntent_UnknownUUIDIs404NotACrash(t *testing.T) {
	srv, sp := newItemServer(t)

	// Park the unknown uuid in the session as an open tab — the arrangement that
	// used to reach the nil dereference rather than merely doing nothing.
	ghost := "019ff000-0000-7000-8000-00000000dead"
	session := sp.State.LoadSession()
	session.Tabs = append(session.Tabs, domain.Tab{ID: ghost, DisplayName: "Ghost"})
	if err := sp.State.SaveSession(session); err != nil {
		t.Fatalf("SaveSession: %v", err)
	}

	status, body := do(t, http.MethodPost, srv.URL+"/api/sidebar/intent?id="+ghost+"&value=keep", "", "")
	if status != http.StatusNotFound {
		t.Errorf("status = %d, want 404 (body %q)", status, body)
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

// A block container opens in a tab of its own kind through the one open route,
// named for its block, mounted with its kind; its asset is served; and closing
// the tab removes it and nothing else — no flush, no filing job — while closing
// a buffer files it.
func TestContainerTab_OpensServesItsAssetAndClosesWithoutFiling(t *testing.T) {
	srv, sp, _, transitions := newItemServerCountingJobs(t)
	block.RegisterProcessor(processors.NewCodeBlockProcessor(block.BlockServices{}))
	c, err := sp.Containers.Create("code", map[string]interface{}{"title": "a snippet", "source": "x := 1"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	uuid := c.UUID()
	if _, err := sp.Containers.SaveAsset(c, "strokes.jsonl", []byte("12345")); err != nil {
		t.Fatalf("SaveAsset: %v", err)
	}

	status, body := do(t, http.MethodPost, srv.URL+"/api/container/open/"+uuid, "", "")
	if status != http.StatusOK {
		t.Fatalf("open: %d %s", status, body)
	}
	for _, want := range []string{`data-tab-kind="code"`, `data-ctx-type="tab"`, `data-ctx-name="a snippet"`, `data-uuid="` + uuid + `"`, `data-kind="code"`} {
		if !strings.Contains(body, want) {
			t.Errorf("open response lacks %s", want)
		}
	}
	tabs := sp.State.LoadSession().Tabs
	if len(tabs) != 1 || tabs[0].ID != uuid || tabs[0].Kind != "code" || tabs[0].IsDocument() {
		t.Fatalf("session tabs = %+v, want the container's tab, saved with its kind", tabs)
	}
	if _, body := do(t, http.MethodGet, srv.URL+"/ui/views/tabs", "", ""); !strings.Contains(body, `data-tab-kind="code"`) {
		t.Errorf("the tab strip refreshed the container's tab away: %s", body)
	}
	if status, body := do(t, http.MethodGet, srv.URL+"/ui/assets/"+uuid+"/strokes.jsonl", "", ""); status != http.StatusOK || body != "12345" {
		t.Errorf("asset = %d %q, want the container's bytes", status, body)
	}

	before := transitions.Load()
	if status, body := do(t, http.MethodPost, srv.URL+"/api/tabs/close", "application/json", `{"ids":["`+uuid+`"]}`); status != http.StatusOK {
		t.Fatalf("close: %d %s", status, body)
	}
	sp.Editor.WaitForJobs()
	if got := transitions.Load(); got != before {
		t.Errorf("closing a block container moved the job tracker %d time(s)", got-before)
	}
	if stored, err := sp.Containers.Load(uuid); err != nil || stored.Version() != c.Version() {
		t.Errorf("closing wrote the container: %v, %v", stored, err)
	}
	for _, tab := range sp.State.LoadSession().Tabs {
		if tab.ID == uuid {
			t.Fatalf("the container's tab survived its close")
		}
	}

	buffer := sp.State.LoadSession().Tabs[0].ID // the fresh buffer an emptied strip mints
	do(t, http.MethodPost, srv.URL+"/api/tabs/close", "application/json", `{"ids":["`+buffer+`"]}`)
	waitFor(t, func() bool { return transitions.Load() > before }, "closing a buffer files it")
}

// A session written before tabs carried a kind renders exactly as it did: a
// prompt id is a prompt, every other tab a document of its filed status.
func TestTabStrip_ASessionWithoutKindsRendersAsBefore(t *testing.T) {
	srv, sp, _, _ := newItemServerCountingJobs(t)
	buf, err := sp.Documents.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := sp.State.SaveSession(domain.Session{Tabs: []domain.Tab{
		{ID: buf.UUID(), Mode: "wysiwyg", Status: "unfiled"},
		{ID: "01a1adb4-6ba7-752e-888e-a38846df8200", Mode: "wysiwyg", Status: "filed"},
		{ID: "prompt:file", Mode: "markdown", Status: "filed"},
	}}); err != nil {
		t.Fatalf("SaveSession: %v", err)
	}
	_, body := do(t, http.MethodGet, srv.URL+"/ui/views/tabs", "", "")
	for _, want := range []string{
		`data-tab-id="` + buf.UUID() + `"
     data-tab-idx="0"
     data-tab-kind="buffer"`,
		`data-tab-kind="note"
     data-tab-viewed="0"
     data-ctx-id="01a1adb4-6ba7-752e-888e-a38846df8200"
     data-ctx-type="note"`,
		`data-tab-kind="prompt"
     data-tab-viewed="0"
     data-ctx-id="prompt:file"
     data-ctx-type="prompt"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("tab strip lacks %q", want)
		}
	}
}

// A tab is stamped as viewed when it becomes the active one — opened, opened again, made new, or
// made active by the close of the tab before it — and at no other time: a reorder, a strip
// rendered from the session and a close that leaves the active tab active stamp nothing. The
// stamp is saved in the session and rendered on the tab.
func TestTabStrip_ATabIsStampedViewedWhenItBecomesActive(t *testing.T) {
	srv, sp, _, _ := newItemServerCountingJobs(t)
	var docs []string
	for i := 0; i < 3; i++ {
		d, err := sp.Documents.New()
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		docs = append(docs, d.UUID())
	}
	viewed := func() map[string]int64 {
		out := map[string]int64{}
		for _, tab := range sp.State.LoadSession().Tabs {
			out[tab.ID] = tab.LastViewed
		}
		return out
	}
	post := func(path, contentType, body string) {
		t.Helper()
		if status, out := do(t, http.MethodPost, srv.URL+path, contentType, body); status != http.StatusOK {
			t.Fatalf("POST %s: %d %s", path, status, out)
		}
	}
	tick := func() { time.Sleep(2 * time.Millisecond) }

	for _, id := range docs {
		post("/api/container/open/"+id, "", "")
		tick()
	}
	first := viewed()
	if !(first[docs[0]] > 0 && first[docs[0]] < first[docs[1]] && first[docs[1]] < first[docs[2]]) {
		t.Fatalf("opening stamped %v", first)
	}
	post("/api/container/open/"+docs[0], "", "")
	tick()
	if again := viewed(); again[docs[0]] <= first[docs[2]] || again[docs[1]] != first[docs[1]] {
		t.Errorf("opening a tab again stamped %v", again)
	}

	before := viewed()
	post("/api/tabs/reorder", "application/x-www-form-urlencoded", "from=2&to=0")
	do(t, http.MethodGet, srv.URL+"/ui/views/tabs", "", "")
	post("/api/tabs/close", "application/json", `{"ids":["`+docs[1]+`"]}`)
	if after := viewed(); !reflect.DeepEqual(after, map[string]int64{docs[0]: before[docs[0]], docs[2]: before[docs[2]]}) {
		t.Errorf("a reorder, a render and a close of another tab stamped %v, want %v", after, before)
	}

	session := sp.State.LoadSession()
	if session.ActiveID() != docs[0] || session.Tabs[1].ID != docs[0] {
		t.Fatalf("the session is %+v", session)
	}
	tick()
	post("/api/tabs/close", "application/json", `{"ids":["`+docs[0]+`"]}`)
	if after := viewed(); sp.State.LoadSession().ActiveID() != docs[2] || after[docs[2]] <= before[docs[0]] {
		t.Errorf("the tab made active by a close is stamped %d, the closed one was %d", after[docs[2]], before[docs[0]])
	}

	tick()
	post("/api/note", "", "")
	session = sp.State.LoadSession()
	if fresh := session.Tabs[session.ActiveIdx]; fresh.LastViewed <= viewed()[docs[2]] {
		t.Errorf("a new note's tab is stamped %d", fresh.LastViewed)
	}
	_, body := do(t, http.MethodGet, srv.URL+"/ui/views/tabs", "", "")
	if want := fmt.Sprintf(`data-tab-viewed="%d"`, viewed()[docs[2]]); !strings.Contains(body, want) {
		t.Errorf("the strip lacks %s:\n%s", want, body)
	}
}

// A synced notebook's tab and the Live view's carry their own menus, and a notebook with no name
// and no title from its tablet reads as an untitled notebook, never as its kind.
func TestTabStrip_NotebookTabsCarryTheirOwnMenus(t *testing.T) {
	srv, sp, _, _ := newItemServerCountingJobs(t)
	block.RegisterProcessor(ink.NewDigitalNoteKind())
	c, err := sp.Containers.Create(ink.KindDigitalNote, map[string]interface{}{"title": ""})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	status, body := do(t, http.MethodPost, srv.URL+"/api/container/open/"+c.UUID(), "", "")
	if status != http.StatusOK {
		t.Fatalf("open: %d %s", status, body)
	}
	if tab := sp.State.LoadSession().Tabs[0]; tab.DisplayName != "Untitled notebook" {
		t.Errorf("an untitled notebook's tab reads %q", tab.DisplayName)
	}
	session := sp.State.LoadSession()
	session.Tabs = append(session.Tabs, domain.Tab{ID: "v-live", Kind: ink.KindLive, DisplayName: "Live"})
	if err := sp.State.SaveSession(session); err != nil {
		t.Fatal(err)
	}
	_, body = do(t, http.MethodGet, srv.URL+"/ui/views/tabs", "", "")
	for _, want := range []string{
		`data-ctx-id="` + c.UUID() + `"
     data-ctx-type="notebook"
     data-ctx-name="Untitled notebook"`,
		`data-ctx-id="v-live"
     data-ctx-type="inkLive"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("the strip lacks %q:\n%s", want, body)
		}
	}
	if strings.Contains(body, ">digital-note<") {
		t.Errorf("a tab reads its kind:\n%s", body)
	}
}
