package services

import (
	"testing"

	"sieve/sieve/domain"
)

// TestRefreshTabStatus_reflectsFiledPromotion proves the Bug 1 fix: a tab whose
// stored Status is the startup "unfiled" snapshot is re-derived to "filed" once
// its buffer has been promoted to a Note. The UUID is stable across File, so the
// same tab id resolves to the live (now filed) document.
func TestRefreshTabStatus_reflectsFiledPromotion(t *testing.T) {
	ds, _ := newTestDocumentService(t)

	buf, err := ds.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	buf.SetBody([]byte("content worth filing"))
	if _, err = ds.Save(buf); err != nil {
		t.Fatalf("Save: %v", err)
	}
	id := buf.UUID()

	// The stored tab snapshot from when the buffer was opened (still "unfiled").
	tabs := []domain.Tab{{ID: id, Status: "unfiled", DisplayName: "Untitled"}}

	// Before filing: still unfiled.
	if got := ds.RefreshTabStatus(tabs)[0].Status; got != "unfiled" {
		t.Fatalf("pre-file status = %q, want unfiled", got)
	}

	// Promote to the Library (buffer -> note).
	if _, err = ds.File(buf); err != nil {
		t.Fatalf("File: %v", err)
	}

	refreshed := ds.RefreshTabStatus(tabs)
	if got := refreshed[0].Status; got != "filed" {
		t.Fatalf("post-file status = %q, want filed", got)
	}
	// Input slice must not be mutated in place.
	if tabs[0].Status != "unfiled" {
		t.Fatalf("RefreshTabStatus mutated the input slice: %q", tabs[0].Status)
	}
}

// TestRefreshTabStatus_leavesPromptAndUnknownTabs proves prompt tabs and
// tabs whose document does not load keep their stored values untouched.
func TestRefreshTabStatus_leavesPromptAndUnknownTabs(t *testing.T) {
	ds, _ := newTestDocumentService(t)

	tabs := []domain.Tab{
		{ID: "prompt:explain", Status: "filed", DisplayName: "explain Prompt"},
		{ID: "nonexistent-uuid", Status: "unfiled", DisplayName: "Ghost"},
	}
	out := ds.RefreshTabStatus(tabs)

	if out[0].Status != "filed" || out[0].DisplayName != "explain Prompt" {
		t.Fatalf("prompt tab altered: %+v", out[0])
	}
	if out[1].Status != "unfiled" || out[1].DisplayName != "Ghost" {
		t.Fatalf("unknown tab altered: %+v", out[1])
	}
}
