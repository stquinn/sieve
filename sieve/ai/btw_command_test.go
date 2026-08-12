package ai

import (
	"strings"
	"testing"

	"sieve/sieve/command"
	"sieve/sieve/domain"
	"sieve/sieve/services"
	"sieve/store/filestore"
)

func TestBtwBuild_DetachedAiBlockShape(t *testing.T) {
	cap := &captureRunner{ret: "A"}
	aiSvc := newSmartTestService(t, cap)
	c := NewBtwCommand(aiSvc, nil)

	job, err := c.Build("what is SRP", command.NewContext(nil, nil))
	if err != nil {
		t.Fatal(err)
	}
	if job.Pending == nil {
		t.Fatal("pending envelope is nil")
	}
	a := job.Pending.Attrs
	if job.Pending.Kind != "ai-block" || a["status"] != "PENDING" || a["question"] != "what is SRP" || a["type"] != "BTW" {
		t.Fatalf("pending envelope wrong: %+v", job.Pending)
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
	if done.Attrs["status"] != "COMPLETE" || done.Attrs["response"] != "A" || done.Attrs["completedAt"] == "" {
		t.Fatalf("final envelope wrong: %+v", done)
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
	ctx := command.NewContext([]byte(`{"docUuid":"`+doc.UUID()+`"}`), nil)
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
	ctx := command.NewContext([]byte(`{"docUuid":"non-existent-uuid"}`), nil)
	job, err := c.Build("question", ctx)
	if err != nil {
		t.Fatal(err)
	}

	done, err := job.Work()
	if err != nil || done.Attrs["response"] != "A" {
		t.Fatalf("missing doc should be tolerated: %v, %+v", err, done)
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
	_, err := c.Build("question", command.NewContext(nil, nil))
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
