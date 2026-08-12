package filestore

import (
	"testing"
)

// TestNewUUID_IsVersion7 pins the minted form to UUIDv7 (time-ordered), which is
// what makes document keys sort chronologically.
func TestNewUUID_IsVersion7(t *testing.T) {
	id := newUUID()
	if len(id) != 36 || id[14] != '7' {
		t.Fatalf("newUUID() = %q, want canonical UUIDv7", id)
	}
}

// TestLooksLikeUUID_RejectsShortHandles guards the predicate that decides whether
// an id has already been migrated: a legacy block handle must answer no.
func TestLooksLikeUUID_RejectsShortHandles(t *testing.T) {
	if looksLikeUUID("pr-3f2a") {
		t.Fatal("looksLikeUUID accepted a legacy block handle")
	}
	if !looksLikeUUID(newUUID()) {
		t.Fatal("looksLikeUUID rejected a freshly minted id")
	}
}

// TestParseFrontmatterBasic verifies that parseFrontmatter correctly splits a
// YAML frontmatter seed body (used by createMeta and the migration tool).
func TestParseFrontmatterBasic(t *testing.T) {
	data := []byte("---\nuuid: abc123\nstatus: unfiled\n---\nhello world\n")
	meta, body, err := parseFrontmatter(data)
	if err != nil {
		t.Fatalf("parseFrontmatter: %v", err)
	}
	if meta["uuid"] != "abc123" {
		t.Errorf("uuid = %q, want abc123", meta["uuid"])
	}
	if meta["status"] != "unfiled" {
		t.Errorf("status = %q, want unfiled", meta["status"])
	}
	if string(body) != "hello world\n" {
		t.Errorf("body = %q, want 'hello world\\n'", body)
	}
}

func TestParseFrontmatterNoFrontmatter(t *testing.T) {
	data := []byte("plain body")
	meta, body, err := parseFrontmatter(data)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(meta) != 0 {
		t.Errorf("expected empty meta, got %v", meta)
	}
	if string(body) != "plain body" {
		t.Errorf("body = %q, want 'plain body'", body)
	}
}

func TestParseFrontmatterNullValue(t *testing.T) {
	data := []byte("---\nuser_intent: null\n---\n")
	meta, _, err := parseFrontmatter(data)
	if err != nil {
		t.Fatalf("parseFrontmatter: %v", err)
	}
	if meta["user_intent"] != "null" {
		t.Errorf("user_intent = %q, want null", meta["user_intent"])
	}
}

func TestParseFrontmatterTags(t *testing.T) {
	data := []byte("---\ntags: []\n---\n")
	meta, _, err := parseFrontmatter(data)
	if err != nil {
		t.Fatalf("parseFrontmatter: %v", err)
	}
	if meta["tags"] != "[]" {
		t.Errorf("tags = %q, want []", meta["tags"])
	}
}

// TestDocMetaRoundTrip verifies that docMetaToMap / mapToDocMeta round-trips
// all standard fields correctly.
func TestDocMetaRoundTrip(t *testing.T) {
	original := &docMeta{
		UUID:        "test-uuid",
		Type:        "document",
		Status:      "filed",
		Version:     5,
		FocusCount:  3,
		DisplayName: "My Note",
		Tags:        []string{"go", "testing"},
		Created:     "2026-01-01T00:00:00",
		Modified:    "2026-01-02T00:00:00",
	}

	m := docMetaToMap(original)
	if m["uuid"] != "test-uuid" {
		t.Errorf("uuid = %q, want test-uuid", m["uuid"])
	}
	if m["version"] != "5" {
		t.Errorf("version = %q, want 5", m["version"])
	}
	if m["tags"] != "[go, testing]" {
		t.Errorf("tags = %q, want [go, testing]", m["tags"])
	}

	restored := mapToDocMeta(m)
	if restored.UUID != original.UUID {
		t.Errorf("UUID mismatch: %q vs %q", restored.UUID, original.UUID)
	}
	if restored.Version != original.Version {
		t.Errorf("Version mismatch: %d vs %d", restored.Version, original.Version)
	}
	if restored.FocusCount != original.FocusCount {
		t.Errorf("FocusCount mismatch: %d vs %d", restored.FocusCount, original.FocusCount)
	}
}

// TestDocMetaExtraFieldsPreserved verifies that unknown fields round-trip via Extra.
func TestDocMetaExtraFieldsPreserved(t *testing.T) {
	m := map[string]string{
		"uuid":         "x",
		"version":      "1",
		"created":      "2026-01-01T00:00:00",
		"modified":     "2026-01-01T00:00:00",
		"custom_field": "hello",
	}
	dm := mapToDocMeta(m)
	if dm.Extra["custom_field"] != "hello" {
		t.Errorf("extra custom_field = %q, want hello", dm.Extra["custom_field"])
	}
	restored := docMetaToMap(dm)
	if restored["custom_field"] != "hello" {
		t.Errorf("custom_field not preserved in round-trip: %q", restored["custom_field"])
	}
}
