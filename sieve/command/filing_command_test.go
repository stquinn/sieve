package command

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"sieve/sieve/services"
	"sieve/store/filestore"
)

// recordingFiler records which filing verb ran, for which document.
type recordingFiler struct {
	calls chan string
}

func newRecordingFiler() *recordingFiler { return &recordingFiler{calls: make(chan string, 4)} }

func (f *recordingFiler) FileDocument(id string)   { f.calls <- "file:" + id }
func (f *recordingFiler) UpdateMetadata(id string) { f.calls <- "metadata:" + id }
func (f *recordingFiler) KeepAndFile(uuid string)  { f.calls <- "keep:" + uuid }

func (f *recordingFiler) awaited(t *testing.T) string {
	t.Helper()
	select {
	case call := <-f.calls:
		return call
	case <-time.After(2 * time.Second):
		t.Fatal("the filer was never asked to do anything")
		return ""
	}
}

// filingDocs builds a real document service over a temp store.
func filingDocs(t *testing.T) *services.DocumentService {
	t.Helper()
	fs, err := filestore.NewFileStore(t.TempDir(), "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	docs, err := services.NewDocumentService(fs)
	if err != nil {
		t.Fatalf("NewDocumentService: %v", err)
	}
	return docs
}

// keepAndFileWithoutInvalidator adapts /keep-and-file to the shape the other two
// verbs have. Filing is what this case is about; the invalidation has its own.
func keepAndFileWithoutInvalidator(filer DocumentFiler, docs *services.DocumentService) *FilingCommand {
	return NewKeepAndFileCommand(filer, docs, nil)
}

// recordingInvalidator records that the note tree was declared stale.
type recordingInvalidator struct{ calls chan struct{} }

func newRecordingInvalidator() *recordingInvalidator {
	return &recordingInvalidator{calls: make(chan struct{}, 4)}
}

func (r *recordingInvalidator) NotesChanged() { r.calls <- struct{}{} }

// contextFor builds the invocation context a lens authors for an open document.
func contextFor(uuid string) Context {
	raw, _ := json.Marshal(map[string]string{"docUuid": uuid})
	return NewContext(raw, nil, nil)
}

// Each filing verb dispatches to its own EditorService call, naming the
// document the invocation came from — the id the retired endpoints took in
// their path.
func TestFilingCommands_EachVerbAsksItsOwnFilingCall(t *testing.T) {
	docs := filingDocs(t)
	doc, err := docs.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	doc, _ = docs.Save(doc)

	for _, verb := range []struct {
		build func(DocumentFiler, *services.DocumentService) *FilingCommand
		want  string
	}{
		{NewFileCommand, "file:"},
		{NewMetadataCommand, "metadata:"},
		{keepAndFileWithoutInvalidator, "keep:"},
	} {
		filer := newRecordingFiler()
		cmd := verb.build(filer, docs)
		t.Run(cmd.Name(), func(t *testing.T) {
			r := testRegistry(t)
			r.Register(cmd)

			emit, ch := collector()
			r.Dispatch(cmd.Name(), FamilyAI, "", contextFor(doc.UUID()), "c-"+cmd.Name(), emit)

			if first := <-ch; first.Status != StatusPending {
				t.Fatalf("first outcome = %v, want PENDING", first)
			}
			if got := filer.awaited(t); got != verb.want+doc.UUID() {
				t.Errorf("filer call = %q, want %q", got, verb.want+doc.UUID())
			}
			// No result block: filing shows up as the moved document and the job,
			// never as something inserted where the user is reading.
			last := <-ch
			if last.Status != StatusComplete || last.Block != nil {
				t.Errorf("terminal outcome = %+v, want COMPLETE with no block", last)
			}
		})
	}
}

// /keep-and-file writes user_intent BEFORE it files: the intent is user-owned,
// and this command is the explicit user action that means "keep".
func TestKeepAndFile_WritesTheUserOwnedIntent(t *testing.T) {
	docs := filingDocs(t)
	doc, _ := docs.New()
	doc, _ = docs.Save(doc)

	filer := newRecordingFiler()
	r := testRegistry(t)
	r.Register(NewKeepAndFileCommand(filer, docs, nil))

	emit, ch := collector()
	r.Dispatch("keep-and-file", FamilyAI, "", contextFor(doc.UUID()), "c-keep", emit)
	<-ch // PENDING
	filer.awaited(t)
	<-ch // COMPLETE

	kept, err := docs.LoadByUUID(doc.UUID())
	if err != nil {
		t.Fatalf("LoadByUUID: %v", err)
	}
	intent := kept.Meta().UserIntent()
	if intent == nil || *intent != "keep" {
		t.Errorf("user_intent = %v, want keep", intent)
	}
}

// The intent write is synchronous and visible in the sidebar, so /keep-and-file
// declares the note tree stale at that moment rather than leaving it to the file
// watcher's debounce.
func TestKeepAndFile_InvalidatesTheNotesImmediately(t *testing.T) {
	docs := filingDocs(t)
	doc, _ := docs.New()
	doc, _ = docs.Save(doc)

	notes := newRecordingInvalidator()
	filer := newRecordingFiler()
	r := testRegistry(t)
	r.Register(NewKeepAndFileCommand(filer, docs, notes))

	emit, ch := collector()
	r.Dispatch("keep-and-file", FamilyAI, "", contextFor(doc.UUID()), "c-keep", emit)
	<-ch // PENDING
	filer.awaited(t)
	<-ch // COMPLETE

	select {
	case <-notes.calls:
	case <-time.After(2 * time.Second):
		t.Fatal("the note tree was never declared stale")
	}
}

// Build refuses what the retired endpoints refused with a 404: an invocation
// with no document, and one naming a document that is gone. The refusal is the
// command's own ERROR outcome — no job is ever submitted.
func TestFilingCommands_RefuseAnInvocationWithNoLivingDocument(t *testing.T) {
	docs := filingDocs(t)
	filer := newRecordingFiler()

	for _, refusal := range []struct {
		name string
		ctx  Context
		want string
	}{
		{"no document", NewContext(nil, nil, nil), "carried none"},
		{"unknown document", contextFor("not-a-uuid"), "not found"},
	} {
		t.Run(refusal.name, func(t *testing.T) {
			r := testRegistry(t)
			r.Register(NewFileCommand(filer, docs))

			emit, ch := collector()
			r.Dispatch("file", FamilyAI, "", refusal.ctx, "c-x", emit)

			out := <-ch
			if out.Status != StatusError || !strings.Contains(out.Err, refusal.want) {
				t.Fatalf("outcome = %+v, want ERROR mentioning %q", out, refusal.want)
			}
			select {
			case call := <-filer.calls:
				t.Errorf("a refused invocation still filed: %q", call)
			case <-time.After(200 * time.Millisecond):
			}
		})
	}
}
