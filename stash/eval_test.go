package stash

import (
	"testing"
)

func newTestMeta(initial map[string]string) DocumentMeta {
	m := make(map[string]string)
	for k, v := range initial {
		m[k] = v
	}
	// documentMeta mutates m in-place; commit is a no-op in tests.
	return newDocumentMeta(m, func(map[string]string) {})
}

func strPtr(s string) *string { return &s }
func boolPtr(b bool) *bool    { return &b }

func TestApplyFilingRec_AllFieldsSet(t *testing.T) {
	meta := newTestMeta(map[string]string{
		"display_name":         "Old Title",
		"filename":             "old-file.md",
		"ai_folder_suggestion": "old-folder",
		"summary":              "old summary",
		"tags":                 "[old-tag]",
		"ai_justification":     "old reason",
		"density_signals":      "[old-signal]",
		"cli":                  "old-cli",
	})

	rec := &FilingRecommendation{
		Keep:            true,
		Title:           "New Title",
		Filename:        "new-file.md",
		Folder:          "new-folder",
		Summary:         "new summary",
		Tags:            []string{"new-tag-1", "new-tag-2"},
		AiJustification: "new reason",
		DensitySignals:  []string{"new-signal"},
	}

	ApplyFilingRec(meta, rec, "new-cli")

	if meta.AiEval() != "complete" {
		t.Errorf("AiEval = %q, want %q", meta.AiEval(), "complete")
	}
	if meta.AiLastEvaluated() == nil {
		t.Error("AiLastEvaluated should be set")
	}
	if meta.AiKeep() == nil || *meta.AiKeep() != true {
		t.Errorf("AiKeep = %v, want true", meta.AiKeep())
	}
	if meta.DisplayName() != "New Title" {
		t.Errorf("DisplayName = %q, want %q", meta.DisplayName(), "New Title")
	}
	if meta.Filename() == nil || *meta.Filename() != "new-file.md" {
		t.Errorf("Filename = %v, want %q", meta.Filename(), "new-file.md")
	}
	if meta.AiFolderSuggestion() == nil || *meta.AiFolderSuggestion() != "new-folder" {
		t.Errorf("AiFolderSuggestion = %v, want %q", meta.AiFolderSuggestion(), "new-folder")
	}
	if meta.Summary() == nil || *meta.Summary() != "new summary" {
		t.Errorf("Summary = %v, want %q", meta.Summary(), "new summary")
	}
	if tags := meta.Tags(); len(tags) != 2 || tags[0] != "new-tag-1" {
		t.Errorf("Tags = %v, want [new-tag-1 new-tag-2]", tags)
	}
	if meta.AiJustification() == nil || *meta.AiJustification() != "new reason" {
		t.Errorf("AiJustification = %v, want %q", meta.AiJustification(), "new reason")
	}
	if meta.CLI() == nil || *meta.CLI() != "new-cli" {
		t.Errorf("CLI = %v, want %q", meta.CLI(), "new-cli")
	}
}

func TestApplyFilingRec_EmptyRecPreservesExistingMeta(t *testing.T) {
	meta := newTestMeta(map[string]string{
		"display_name":         "Existing Title",
		"filename":             "existing.md",
		"ai_folder_suggestion": "existing-folder",
		"summary":              "existing summary",
		"tags":                 "[existing-tag]",
		"ai_justification":     "existing reason",
		"density_signals":      "[existing-signal]",
		"cli":                  "existing-cli",
	})

	rec := &FilingRecommendation{
		Keep: false,
		// All string/slice fields intentionally empty
	}

	ApplyFilingRec(meta, rec, "")

	if meta.DisplayName() != "Existing Title" {
		t.Errorf("DisplayName overwritten: got %q, want %q", meta.DisplayName(), "Existing Title")
	}
	if meta.Filename() == nil || *meta.Filename() != "existing.md" {
		t.Errorf("Filename overwritten: got %v", meta.Filename())
	}
	if meta.AiFolderSuggestion() == nil || *meta.AiFolderSuggestion() != "existing-folder" {
		t.Errorf("AiFolderSuggestion overwritten: got %v", meta.AiFolderSuggestion())
	}
	if meta.Summary() == nil || *meta.Summary() != "existing summary" {
		t.Errorf("Summary overwritten: got %v", meta.Summary())
	}
	if tags := meta.Tags(); len(tags) != 1 || tags[0] != "existing-tag" {
		t.Errorf("Tags overwritten: got %v", tags)
	}
	if meta.CLI() == nil || *meta.CLI() != "existing-cli" {
		t.Errorf("CLI overwritten: got %v", meta.CLI())
	}
}

func TestApplyFilingRec_AlwaysSetsEvalFields(t *testing.T) {
	meta := newTestMeta(map[string]string{
		"ai_eval":            "none",
		"ai_last_evaluated":  "null",
	})

	ApplyFilingRec(meta, &FilingRecommendation{Keep: true}, "")

	if meta.AiEval() != "complete" {
		t.Errorf("AiEval = %q, want %q", meta.AiEval(), "complete")
	}
	if meta.AiLastEvaluated() == nil {
		t.Error("AiLastEvaluated should be set even when rec fields are empty")
	}
	if meta.AiKeep() == nil || *meta.AiKeep() != true {
		t.Errorf("AiKeep = %v, want true", meta.AiKeep())
	}
}

func TestApplyFilingRec_KeepFalse(t *testing.T) {
	meta := newTestMeta(nil)
	ApplyFilingRec(meta, &FilingRecommendation{Keep: false}, "")
	if meta.AiKeep() == nil || *meta.AiKeep() != false {
		t.Errorf("AiKeep = %v, want false", meta.AiKeep())
	}
}

func TestApplyFilingRec_CLINotOverwrittenWhenEmpty(t *testing.T) {
	meta := newTestMeta(map[string]string{"cli": "my-cli"})
	ApplyFilingRec(meta, &FilingRecommendation{}, "")
	if meta.CLI() == nil || *meta.CLI() != "my-cli" {
		t.Errorf("CLI should not be overwritten when rec CLI is empty: got %v", meta.CLI())
	}
}

func TestApplyFilingRec_EmptyTagsPreserveExisting(t *testing.T) {
	meta := newTestMeta(map[string]string{"tags": "[go, testing]"})
	ApplyFilingRec(meta, &FilingRecommendation{Tags: []string{}}, "")
	tags := meta.Tags()
	if len(tags) != 2 {
		t.Errorf("Tags should be preserved when rec.Tags is empty: got %v", tags)
	}
}
