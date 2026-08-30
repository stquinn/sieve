package ai

import (
	"strings"
	"testing"

	"sieve/ident"
	"sieve/sieve/command"
	"sieve/sieve/domain"
	"sieve/sieve/services"
	"sieve/store/filestore"
)

func TestBtwBuild_DetachedAiBlockShape(t *testing.T) {
	cap := &captureRunner{ret: "A"}
	aiSvc := newSmartTestService(t, cap)
	c := NewBtwCommand(aiSvc, nil)

	job, err := c.Build("what is SRP", command.NewContext(nil, nil, nil))
	if err != nil {
		t.Fatal(err)
	}
	if job.Pending == nil {
		t.Fatal("pending envelope is nil")
	}
	a := job.Pending.Attrs
	if job.Pending.Kind != "ai-block" || a["status"] != "PENDING" || a["type"] != "BTW" {
		t.Fatalf("pending envelope wrong: %+v", job.Pending)
	}
	// A question is a LIST OF BLOCKS, whether one line of text composed it or a
	// whole message did.
	q := popupQuestionOf(t, a)
	if len(q) != 1 || q[0].kind != "prose" || q[0].attrs["content"] != "what is SRP" {
		t.Fatalf("question = %+v, want the one prose element the text is", a["question"])
	}
	// The element minted from the text flavor is identified like every other
	// block: a uuid from ident.
	if id, _ := q[0].attrs["id"].(string); !ident.Valid(id) {
		t.Fatalf("minted element id = %q, want a uuid", id)
	}
	// Identity is stamped by the dispatcher (attrs.id == correlationID), not by
	// the command's Build — so Build leaves no "id" here.
	if _, ok := a["id"]; ok {
		t.Fatalf("Build must not mint a block id; dispatcher owns identity: %+v", a)
	}

	done, err := job.Work()
	if err != nil {
		t.Fatal(err)
	}
	if done.Attrs["status"] != "COMPLETE" || done.Attrs["completedAt"] == "" {
		t.Fatalf("final envelope wrong: %+v", done)
	}
	if got := popupAnswerOf(t, done.Attrs); got != "A" {
		t.Fatalf("answer = %q, want the CLI's reply", got)
	}
}

func TestBtwBuild_MetaOnlyContext(t *testing.T) {
	cap := &captureRunner{ret: "A"}
	aiSvc := newSmartTestService(t, cap)

	fs, err := filestore.NewFileStore(t.TempDir(), "testhost")
	if err != nil {
		t.Fatal(err)
	}
	docs, err := services.NewDocumentService(fs)
	if err != nil {
		t.Fatal(err)
	}
	doc, err := docs.New()
	if err != nil {
		t.Fatal(err)
	}
	doc, err = docs.UpdateAiMetadata(doc, &domain.FilingRecommendation{
		Title:   "Architecture Notes",
		Summary: "System design principles",
	}, "")
	if err != nil {
		t.Fatal(err)
	}

	c := NewBtwCommand(aiSvc, docs)
	ctx := command.NewContext([]byte(`{"docUuid":"`+doc.UUID()+`"}`), nil, nil)
	job, err := c.Build("question", ctx)
	if err != nil {
		t.Fatal(err)
	}

	_, err = job.Work()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(cap.prompt, "Architecture Notes") || !strings.Contains(cap.prompt, "System design principles") {
		t.Fatalf("prompt missing doc meta: %q", cap.prompt)
	}
}

func TestBtwBuild_MissingDocTolerated(t *testing.T) {
	cap := &captureRunner{ret: "A"}
	aiSvc := newSmartTestService(t, cap)

	fs, err := filestore.NewFileStore(t.TempDir(), "testhost")
	if err != nil {
		t.Fatal(err)
	}
	docs, err := services.NewDocumentService(fs)
	if err != nil {
		t.Fatal(err)
	}

	c := NewBtwCommand(aiSvc, docs)
	ctx := command.NewContext([]byte(`{"docUuid":"non-existent-uuid"}`), nil, nil)
	job, err := c.Build("question", ctx)
	if err != nil {
		t.Fatal(err)
	}

	done, err := job.Work()
	if err != nil {
		t.Fatalf("missing doc should be tolerated: %v", err)
	}
	if got := popupAnswerOf(t, done.Attrs); got != "A" {
		t.Fatalf("answer = %q, want the CLI's reply", got)
	}
}

func TestBtwBuild_TierDumbFailsFast(t *testing.T) {
	aiSvc := newSmartTestService(t, &captureRunner{})
	settings := domain.DefaultSettings()
	settings.CLI = "" // Dumb mode
	if err := aiSvc.state.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}

	c := NewBtwCommand(aiSvc, nil)
	_, err := c.Build("question", command.NewContext(nil, nil, nil))
	if err == nil || !strings.Contains(err.Error(), "unavailable") {
		t.Fatalf("expected fail fast error for dumb tier, got %v", err)
	}
}

func TestBtwLabel_Truncates(t *testing.T) {
	c := NewBtwCommand(nil, nil)
	lblShort := c.label("short question")
	if lblShort != "/btw short question" {
		t.Fatalf("lblShort = %q, want /btw short question", lblShort)
	}
	lblLong := c.label("this is a very long question that exceeds forty runes in length and should be truncated")
	if !strings.HasSuffix(lblLong, "…") || len([]rune(lblLong)) > 47 {
		t.Fatalf("lblLong = %q, expected truncation with ellipsis", lblLong)
	}
}

// questionElement is one entry of a stored question list, read THE WAY THE BLOCK
// MODEL READS IT — down the list, into the entry's attrs bag.
type questionElement struct {
	kind  string
	attrs map[string]interface{}
}

// popupQuestionOf returns the question a popup block carries, failing the test
// when the block does not carry an element list at all.
func popupQuestionOf(t *testing.T, attrs map[string]interface{}) []questionElement {
	t.Helper()
	list, ok := attrs["question"].([]interface{})
	if !ok {
		t.Fatalf("question is not an element list: %+v", attrs["question"])
	}
	out := make([]questionElement, 0, len(list))
	for i, entry := range list {
		e, ok := entry.(map[string]interface{})
		if !ok {
			t.Fatalf("question element %d is not a {kind, attrs} entry: %+v", i, entry)
		}
		kind, _ := e["kind"].(string)
		elAttrs, ok := e["attrs"].(map[string]interface{})
		if kind == "" || !ok {
			t.Fatalf("question element %d is malformed: %+v", i, entry)
		}
		out = append(out, questionElement{kind: kind, attrs: elAttrs})
	}
	return out
}

// The envelope's text and body are TWO PROJECTIONS of the one message, so a
// turn carrying both records the BLOCK form alone — storing the text too would
// say the message twice. Every element keeps the id it arrived with.
func TestBtwBuild_QuestionIsTheBodyAlone(t *testing.T) {
	cap := &captureRunner{ret: "A"}
	c := NewBtwCommand(newSmartTestService(t, cap), nil)

	ctx := command.NewContext(nil, nil, command.Blocks{
		{Kind: "prose", Attrs: map[string]interface{}{"id": "el-1", "content": "why does this fail?"}},
		{Kind: "code", Attrs: map[string]interface{}{"id": "el-2", "language": "go", "source": "x := 1"}},
	})
	job, err := c.Build("why does this fail?\nx := 1", ctx)
	if err != nil {
		t.Fatal(err)
	}

	q := popupQuestionOf(t, job.Pending.Attrs)
	if len(q) != 2 {
		t.Fatalf("question = %+v, want the composed blocks alone", q)
	}
	// An authored block's id travels — Build re-mints nothing it was handed.
	if q[0].attrs["id"] != "el-1" || q[1].attrs["id"] != "el-2" {
		t.Errorf("composed element ids were rewritten: %+v", q)
	}
	if q[1].kind != "code" || q[1].attrs["source"] != "x := 1" {
		t.Errorf("question[1] = %+v, want the code block verbatim", q[1])
	}
}

// The prompt reads the question through its Markdown flavor: prose as it
// stands, code fenced and tagged with its language — never the raw text
// projection, which would flatten a fence into bare lines.
func TestBtwBuild_PromptFlattensTheWholeQuestion(t *testing.T) {
	cap := &captureRunner{ret: "A"}
	c := NewBtwCommand(newSmartTestService(t, cap), nil)

	ctx := command.NewContext(nil, nil, command.Blocks{
		{Kind: "prose", Attrs: map[string]interface{}{"id": "el-1", "content": "why does this fail?"}},
		{Kind: "code", Attrs: map[string]interface{}{"id": "el-2", "language": "go", "source": "x := 1"}},
		{Kind: "reference", Attrs: map[string]interface{}{"uri": "sieve://9f2b", "rel": "attach"}},
	})
	job, err := c.Build("why does this fail?\nx := 1", ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := job.Work(); err != nil {
		t.Fatal(err)
	}

	if !strings.Contains(cap.prompt, "why does this fail?\n\n```go\nx := 1\n```") {
		t.Fatalf("prompt did not carry the flattened question:\n%s", cap.prompt)
	}
	// A reference reaches a prompt as an attachment, never as text of its own.
	if strings.Contains(cap.prompt, "sieve://9f2b") {
		t.Errorf("a reference element leaked into the prompt as text:\n%s", cap.prompt)
	}
}

// A turn can be all message and no verb-line text: the composer wrote it, so
// the precondition is satisfied.
func TestBtwBuild_ComposedBodyAloneIsAQuestion(t *testing.T) {
	cap := &captureRunner{ret: "A"}
	c := NewBtwCommand(newSmartTestService(t, cap), nil)

	ctx := command.NewContext(nil, nil, command.Blocks{
		{Kind: "prose", Attrs: map[string]interface{}{"id": "el-1", "content": "what does this do?"}},
	})
	job, err := c.Build("   ", ctx)
	if err != nil {
		t.Fatalf("a body-only turn was refused: %v", err)
	}

	q := popupQuestionOf(t, job.Pending.Attrs)
	if len(q) != 1 || q[0].attrs["id"] != "el-1" {
		t.Fatalf("question = %+v, want the composed block alone", q)
	}
	if lbl := job.Label; lbl != "/btw what does this do?" {
		t.Errorf("label = %q, want it named after the composed question", lbl)
	}
	if _, err := job.Work(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(cap.prompt, "what does this do?") {
		t.Errorf("the composed question never reached the prompt:\n%s", cap.prompt)
	}
}

// Neither half is a turn at all.
func TestBtwBuild_RefusesAnEmptyTurn(t *testing.T) {
	c := NewBtwCommand(newSmartTestService(t, &captureRunner{}), nil)
	_, err := c.Build("   ", command.NewContext(nil, nil, nil))
	if err == nil || !strings.Contains(err.Error(), "usage: /btw") {
		t.Fatalf("err = %v, want the usage refusal", err)
	}
}
