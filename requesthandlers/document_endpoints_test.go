package requesthandlers

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"sieve/sieve"
	"sieve/sieve/ai"
	"sieve/sieve/block"
	"sieve/sieve/editor"
	"sieve/sieve/services"
	"sieve/store/filestore"
)

// savedFact is one container-saved announcement, as the workspace would
// broadcast it.
type savedFact struct {
	uuid    string
	version int
}

// newDocumentEndpointServer boots the CHANNEL-LESS document pair over a real
// store, and returns a real note's uuid alongside it — the pair's contract is
// that a note is refused, so a test needs a genuine one to be refused with.
// saved receives every container-saved announcement the handler makes, so the
// prompt's brand-new saved-signal is observable without a socket.
func newDocumentEndpointServer(t *testing.T) (*httptest.Server, *sieve.ServiceProvider, string, chan savedFact) {
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
	prompts, err := ai.NewPromptService(fs)
	if err != nil {
		t.Fatalf("NewPromptService: %v", err)
	}
	es := editor.NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	sp := &sieve.ServiceProvider{Store: fs, Documents: ds, State: state, Prompts: prompts, Editor: es}

	saved := make(chan savedFact, 4)
	r := chi.NewRouter()
	(&EditorHandler{
		ServiceProvider:    sp,
		EmitContainerSaved: func(uuid string, version int) { saved <- savedFact{uuid, version} },
	}).RegisterPaths(r)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	t.Cleanup(es.CloseAll)

	doc, err := ds.New()
	if err != nil {
		t.Fatalf("New doc: %v", err)
	}
	doc, err = ds.Save(doc)
	if err != nil {
		t.Fatalf("Save doc: %v", err)
	}
	return srv, sp, doc.UUID(), saved
}

// A prompt loads over HTTP because it opens no document channel to load along.
// The answer is the SAME DocumentContent shape the load frame carries, so the
// two transports cannot drift.
func TestDocumentLoad_ServesAPromptsContent(t *testing.T) {
	srv, sp, _, _ := newDocumentEndpointServer(t)
	if err := sp.Prompts.SavePrompt("ask", "answer the question"); err != nil {
		t.Fatalf("SavePrompt: %v", err)
	}

	status, body := do(t, "GET", srv.URL+"/api/document/load?uuid=prompt:ask", "", "")
	if status != 200 {
		t.Fatalf("status = %d (%s), want 200", status, body)
	}
	var got struct {
		Body string `json:"body"`
		Mode string `json:"mode"`
		UUID string `json:"uuid"`
	}
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatalf("decode %q: %v", body, err)
	}
	if got.Body != "answer the question" {
		t.Errorf("body = %q, want the saved prompt", got.Body)
	}
	// A prompt is fixed markdown: it has no block tree to mount.
	if got.Mode != "markdown" {
		t.Errorf("mode = %q, want markdown", got.Mode)
	}
	if got.UUID != "prompt:ask" {
		t.Errorf("uuid = %q, want prompt:ask", got.UUID)
	}
}

// A NOTE is refused: its document channel is its one way in, and a second door
// would let the editor mount content the live shadow never saw.
func TestDocumentLoad_RefusesANote(t *testing.T) {
	srv, _, uuid, _ := newDocumentEndpointServer(t)

	status, body := do(t, "GET", srv.URL+"/api/document/load?uuid="+uuid, "", "")
	if status != 400 {
		t.Fatalf("status = %d (%s), want 400", status, body)
	}
	if !strings.Contains(body, "channel") {
		t.Errorf("refusal = %q, want it to name the channel that serves notes", body)
	}
}

// A prompt id nothing is stored under — and that no baked-in default answers —
// is a 404, not an empty document: the tab has nothing to show and should say so.
func TestDocumentLoad_UnknownPromptIsNotFound(t *testing.T) {
	srv, _, _, _ := newDocumentEndpointServer(t)

	status, body := do(t, "GET", srv.URL+"/api/document/load?uuid=prompt:no-such-prompt", "", "")
	if status != 404 {
		t.Fatalf("status = %d (%s), want 404", status, body)
	}
}

// The write half refuses a note for the sharper reason: the note's live shadow
// is the authority on its content, so this write would land behind the shadow's
// back and be reverted by its next flush. The bytes on disk must be untouched.
func TestDocumentSave_RefusesANoteAndLeavesItAlone(t *testing.T) {
	srv, sp, uuid, _ := newDocumentEndpointServer(t)

	doc, err := sp.Documents.LoadByUUID(uuid)
	if err != nil {
		t.Fatalf("LoadByUUID: %v", err)
	}
	doc.SetBody([]byte("what the shadow holds"))
	if _, err := sp.Documents.Save(doc); err != nil {
		t.Fatalf("Save: %v", err)
	}

	status, body := do(t, "POST", srv.URL+"/api/document/save?uuid="+uuid,
		"application/json", `{"body":"written behind the shadow's back","mode":"markdown"}`)
	if status != 400 {
		t.Fatalf("status = %d (%s), want 400", status, body)
	}

	after, err := sp.Documents.LoadByUUID(uuid)
	if err != nil {
		t.Fatalf("LoadByUUID after: %v", err)
	}
	if string(after.Body()) != "what the shadow holds" {
		t.Errorf("the refused save still reached disk: %q", string(after.Body()))
	}
}

// The pair round-trips: what save writes, load reads back.
func TestDocumentSave_WritesAPromptTheLoadHalfReadsBack(t *testing.T) {
	srv, _, _, _ := newDocumentEndpointServer(t)

	status, body := do(t, "POST", srv.URL+"/api/document/save?uuid=prompt:ask",
		"application/json", `{"body":"a new instruction","mode":"markdown"}`)
	if status != 200 {
		t.Fatalf("save status = %d (%s), want 200", status, body)
	}

	status, body = do(t, "GET", srv.URL+"/api/document/load?uuid=prompt:ask", "", "")
	if status != 200 {
		t.Fatalf("load status = %d (%s), want 200", status, body)
	}
	if !strings.Contains(body, "a new instruction") {
		t.Errorf("load did not read back the saved prompt: %q", body)
	}
}

// A PROMPT's save announces the same container-saved fact a note's does. It is
// the only write that does not funnel through EditorService's flush chokepoint
// (a prompt has no shadow), and before this the prompt editor had no
// saved-signal at all — it cleared its own dirty flag on faith.
func TestDocumentSave_AnnouncesAPromptSaveAsAContainerFact(t *testing.T) {
	srv, _, _, saved := newDocumentEndpointServer(t)

	status, body := do(t, "POST", srv.URL+"/api/document/save?uuid=prompt:ask",
		"application/json", `{"body":"a new instruction","mode":"markdown"}`)
	if status != 200 {
		t.Fatalf("save status = %d (%s), want 200", status, body)
	}

	select {
	case got := <-saved:
		if got.uuid != "prompt:ask" {
			t.Errorf("announced uuid = %q, want prompt:ask — the uuid the editor holds", got.uuid)
		}
		// A prompt override is a plain file with no metadata, so there is no
		// version to report and 0 is the honest answer. It is asserted rather than
		// ignored because 0 is what tells a waiting client this container cannot
		// order its saves — a fabricated number would silently claim it can.
		if got.version != 0 {
			t.Errorf("announced version = %d, want 0 — a prompt keeps no version history", got.version)
		}
	default:
		t.Fatal("a successful prompt save announced nothing")
	}
}

// A REFUSED save announces nothing, for the reason every failed write does: the
// document is not on disk, so the editor must stay dirty.
func TestDocumentSave_ARefusedNoteAnnouncesNothing(t *testing.T) {
	srv, _, uuid, saved := newDocumentEndpointServer(t)

	if status, _ := do(t, "POST", srv.URL+"/api/document/save?uuid="+uuid,
		"application/json", `{"body":"nope","mode":"markdown"}`); status == 200 {
		t.Fatalf("a note must not save here, got 200")
	}
	select {
	case got := <-saved:
		t.Fatalf("a refused save announced %q", got.uuid)
	default:
	}
}
