package block

import (
	"fmt"
	"testing"
)

// testRefDocUUID is the document a reference block lives in for these fixtures —
// distinct from testAssetUUID, which plays the CONTAINER a legacy address
// points at.
const testRefDocUUID = "0197b1f4-9999-7aaa-8bbb-ccccddddeeee"

func referenceBlock(id string, attrs map[string]interface{}) SieveBlock {
	full := map[string]interface{}{"id": id}
	for k, v := range attrs {
		full[k] = v
	}
	return SieveBlock{ID: id, Kind: "reference", Attrs: full}
}

func TestReferenceMigrator_ContainerMapping(t *testing.T) {
	in := []SieveBlock{referenceBlock("rf-1", map[string]interface{}{"uri": "container:" + testAssetUUID})}
	out, changed := ReferenceMigrator{}.Migrate(in, testRefDocUUID)
	if !changed {
		t.Fatal("changed = false")
	}
	if got, want := out[0].Attrs["uri"], "sieve://"+testAssetUUID; got != want {
		t.Errorf("uri = %v, want %q", got, want)
	}
}

func TestReferenceMigrator_PinnedContainerMapping(t *testing.T) {
	in := []SieveBlock{referenceBlock("rf-1", map[string]interface{}{"uri": "container:" + testAssetUUID + "@v3"})}
	out, changed := ReferenceMigrator{}.Migrate(in, testRefDocUUID)
	if !changed {
		t.Fatal("changed = false")
	}
	if got, want := out[0].Attrs["uri"], "sieve://"+testAssetUUID+"?version=3"; got != want {
		t.Errorf("uri = %v, want %q", got, want)
	}
}

func TestReferenceMigrator_BlockLeafMapping(t *testing.T) {
	in := []SieveBlock{referenceBlock("rf-1", map[string]interface{}{"uri": "block:" + testAssetUUID + "/my-handle"})}
	out, changed := ReferenceMigrator{}.Migrate(in, testRefDocUUID)
	if !changed {
		t.Fatal("changed = false")
	}
	if got, want := out[0].Attrs["uri"], "sieve://"+testAssetUUID+"/my-handle"; got != want {
		t.Errorf("uri = %v, want %q", got, want)
	}
}

func TestReferenceMigrator_PinnedBlockLeafMapping(t *testing.T) {
	in := []SieveBlock{referenceBlock("rf-1", map[string]interface{}{"uri": "block:" + testAssetUUID + "@v7/my-handle"})}
	out, changed := ReferenceMigrator{}.Migrate(in, testRefDocUUID)
	if !changed {
		t.Fatal("changed = false")
	}
	if got, want := out[0].Attrs["uri"], "sieve://"+testAssetUUID+"/my-handle?version=7"; got != want {
		t.Errorf("uri = %v, want %q", got, want)
	}
}

// A bare block:{uuid} — no handle — has no sieve:// spelling, so it is left
// untouched rather than guessed at, and goes on resolving dangling.
func TestReferenceMigrator_BareBlockUUIDLeftUntouched(t *testing.T) {
	legacy := "block:" + testAssetUUID
	in := []SieveBlock{referenceBlock("rf-1", map[string]interface{}{"uri": legacy})}
	out, changed := ReferenceMigrator{}.Migrate(in, testRefDocUUID)
	if changed {
		t.Fatal("changed = true for a bare block:{uuid}, which has no sieve:// spelling")
	}
	if got := out[0].Attrs["uri"]; got != legacy {
		t.Errorf("uri = %v, want untouched %q", got, legacy)
	}
}

func TestReferenceMigrator_SrcFold(t *testing.T) {
	in := []SieveBlock{referenceBlock("rf-1", map[string]interface{}{"src": "notes.txt"})}
	out, changed := ReferenceMigrator{}.Migrate(in, testRefDocUUID)
	if !changed {
		t.Fatal("changed = false")
	}
	if got, want := out[0].Attrs["uri"], "sieve://"+testRefDocUUID+"/notes.txt"; got != want {
		t.Errorf("uri = %v, want %q", got, want)
	}
	if _, ok := out[0].Attrs["src"]; ok {
		t.Error("src survived the fold")
	}
}

func TestReferenceMigrator_RelativeURIAbsolutised(t *testing.T) {
	in := []SieveBlock{referenceBlock("rf-1", map[string]interface{}{"uri": "/notes.txt"})}
	out, changed := ReferenceMigrator{}.Migrate(in, testRefDocUUID)
	if !changed {
		t.Fatal("changed = false")
	}
	if got, want := out[0].Attrs["uri"], "sieve://"+testRefDocUUID+"/notes.txt"; got != want {
		t.Errorf("uri = %v, want %q", got, want)
	}
}

func TestReferenceMigrator_BothSetURIWins(t *testing.T) {
	held := "sieve://" + testAssetUUID + "/held.txt"
	in := []SieveBlock{referenceBlock("rf-1", map[string]interface{}{"uri": held, "src": "stale.txt"})}
	out, changed := ReferenceMigrator{}.Migrate(in, testRefDocUUID)
	if !changed {
		t.Fatal("changed = false")
	}
	if got := out[0].Attrs["uri"]; got != held {
		t.Errorf("uri = %v, want unchanged %q", got, held)
	}
	if _, ok := out[0].Attrs["src"]; ok {
		t.Error("src survived when both were set")
	}
}

// smart-image also carries a `src` attr, with an unrelated meaning (its own held
// asset route). The kind gate must keep this migrator off it.
func TestReferenceMigrator_IgnoresNonReferenceKinds(t *testing.T) {
	in := []SieveBlock{
		{ID: "im-1", Kind: "smart-image", Attrs: map[string]interface{}{"id": "im-1", "src": "im-1.png"}},
	}
	out, changed := ReferenceMigrator{}.Migrate(in, testRefDocUUID)
	if changed {
		t.Fatal("changed = true for a non-reference block")
	}
	if got := out[0].Attrs["src"]; got != "im-1.png" {
		t.Errorf("src disturbed on a non-reference kind: %v", got)
	}
	if _, ok := out[0].Attrs["uri"]; ok {
		t.Error("a uri attr was minted on a non-reference kind")
	}
}

func TestReferenceMigrator_CleanTreeAllocatesNothing(t *testing.T) {
	in := []SieveBlock{referenceBlock("rf-1", map[string]interface{}{"uri": "sieve://" + testAssetUUID + "/leaf"})}
	out, changed := ReferenceMigrator{}.Migrate(in, testRefDocUUID)
	if changed {
		t.Fatal("changed = true for an already-migrated tree")
	}
	// out shares its Attrs map with in — this is what "no allocation" means:
	// migrateAttrs returns the SAME map back rather than cloning it.
	got, want := fmt.Sprintf("%p", out[0].Attrs), fmt.Sprintf("%p", in[0].Attrs)
	if got != want {
		t.Errorf("Attrs map was cloned for a clean block: out=%s in=%s", got, want)
	}
}

func TestReferenceMigrator_DoesNotMutateInput(t *testing.T) {
	in := []SieveBlock{referenceBlock("rf-1", map[string]interface{}{"src": "notes.txt"})}
	ReferenceMigrator{}.Migrate(in, testRefDocUUID)
	if _, ok := in[0].Attrs["uri"]; ok {
		t.Fatal("Migrate mutated its input's Attrs map — undo and the caller's snapshot depend on it not doing that")
	}
	if got := in[0].Attrs["src"]; got != "notes.txt" {
		t.Fatalf("Migrate mutated its input's src: %v", got)
	}
}

func TestReferenceMigrator_EmptyAndNil(t *testing.T) {
	m := ReferenceMigrator{}
	if out, changed := m.Migrate(nil, testRefDocUUID); out != nil || changed {
		t.Fatalf("nil input: got %v, %v", out, changed)
	}
	if out, changed := m.Migrate([]SieveBlock{}, testRefDocUUID); len(out) != 0 || changed {
		t.Fatalf("empty input: got %v, %v", out, changed)
	}
}

// ── the face fold: legacy root face attrs move under `cache` ─────────────────

func TestReferenceMigrator_FoldsLegacyFace(t *testing.T) {
	in := []SieveBlock{referenceBlock("rf-1", map[string]interface{}{
		"uri": "sieve://" + testAssetUUID,
		"title": "Auth Design", "mime": "sieve/note",
		"summary": "Token rotation", "bytes": "42",
	})}
	out, changed := ReferenceMigrator{}.Migrate(in, testRefDocUUID)
	if !changed {
		t.Fatal("a legacy root face must report the tree changed")
	}
	face, _ := out[0].Attrs["cache"].(map[string]interface{})
	if face == nil {
		t.Fatalf("no cache map: %#v", out[0].Attrs)
	}
	if face["title"] != "Auth Design" || face["mime"] != "sieve/note" ||
		face["summary"] != "Token rotation" || face["bytes"] != "42" {
		t.Errorf("face = %#v", face)
	}
	for _, key := range []string{"title", "mime", "summary", "bytes"} {
		if _, ok := out[0].Attrs[key]; ok {
			t.Errorf("folded attr %q must leave the root", key)
		}
	}
	// A fold mints nothing: legacy values have no known date.
	if _, ok := face["cachedAt"]; ok {
		t.Error("the fold must not invent a cachedAt")
	}
	// The input tree is never mutated.
	if _, ok := in[0].Attrs["cache"]; ok {
		t.Error("Migrate mutated its input")
	}
}

func TestReferenceMigrator_CacheWinsOverLegacyRoot(t *testing.T) {
	in := []SieveBlock{referenceBlock("rf-1", map[string]interface{}{
		"uri":   "sieve://" + testAssetUUID,
		"title": "Stale Root",
		"cache": map[string]interface{}{"title": "Fresh Cache"},
	})}
	out, changed := ReferenceMigrator{}.Migrate(in, testRefDocUUID)
	if !changed {
		t.Fatal("a stray root attr beside a cache must still report changed")
	}
	face, _ := out[0].Attrs["cache"].(map[string]interface{})
	if face["title"] != "Fresh Cache" {
		t.Errorf("cache.title must win over a stray root title; got %v", face["title"])
	}
	if _, ok := out[0].Attrs["title"]; ok {
		t.Error("the losing root attr must still leave the root")
	}
}

// Old InitAttrs seeded every face key as "", so most legacy blocks carry empty
// strings: those leave the root WITHOUT minting a cache — an empty face stays an
// absent attr.
func TestReferenceMigrator_EmptyLegacyFaceDropsWithoutACache(t *testing.T) {
	in := []SieveBlock{referenceBlock("rf-1", map[string]interface{}{
		"uri": "sieve://" + testAssetUUID, "title": "", "mime": "", "summary": "", "bytes": "",
	})}
	out, changed := ReferenceMigrator{}.Migrate(in, testRefDocUUID)
	if !changed {
		t.Fatal("dropping empty legacy keys is still a rewrite")
	}
	if _, ok := out[0].Attrs["cache"]; ok {
		t.Errorf("empty legacy values must not mint a cache; got %#v", out[0].Attrs["cache"])
	}
	for _, key := range []string{"title", "mime", "summary", "bytes"} {
		if _, ok := out[0].Attrs[key]; ok {
			t.Errorf("legacy key %q must leave the root", key)
		}
	}
}

// The src fold and the face fold are one pass: the full pre-rename attachment
// shape — src plus a root face — comes out with a sieve:// uri and a cache.
func TestReferenceMigrator_SrcAndFaceFoldTogether(t *testing.T) {
	in := []SieveBlock{referenceBlock("rf-1", map[string]interface{}{
		"src": "rf-1.yml", "title": "swagger.yml", "mime": "text/yaml",
	})}
	out, changed := ReferenceMigrator{}.Migrate(in, testRefDocUUID)
	if !changed {
		t.Fatal("changed = false")
	}
	if got, want := out[0].Attrs["uri"], "sieve://"+testRefDocUUID+"/rf-1.yml"; got != want {
		t.Errorf("uri = %v, want %q", got, want)
	}
	face, _ := out[0].Attrs["cache"].(map[string]interface{})
	if face["title"] != "swagger.yml" || face["mime"] != "text/yaml" {
		t.Errorf("face = %#v", face)
	}
}

func TestReferenceMigrator_FoldedShapeIsAlreadyClean(t *testing.T) {
	in := []SieveBlock{referenceBlock("rf-1", map[string]interface{}{
		"uri":   "sieve://" + testAssetUUID,
		"cache": map[string]interface{}{"title": "Auth Design", "mime": "sieve/note"},
	})}
	if _, changed := (ReferenceMigrator{}).Migrate(in, testRefDocUUID); changed {
		t.Error("a cache-shaped block must not report a change")
	}
}

// ── ai-block attachments: the same legacy spellings, one attr deeper ─────────

func aiBlockWithAttachments(entries ...map[string]interface{}) SieveBlock {
	list := make([]interface{}, 0, len(entries))
	for _, e := range entries {
		list = append(list, e)
	}
	return SieveBlock{ID: "ai-1", Kind: "ai-block", Attrs: map[string]interface{}{
		"id": "ai-1", "question": "why?", "attachments": list,
	}}
}

func attachmentURIs(t *testing.T, b SieveBlock) []string {
	t.Helper()
	list, _ := b.Attrs["attachments"].([]interface{})
	uris := make([]string, 0, len(list))
	for _, e := range list {
		m, _ := e.(map[string]interface{})
		uri, _ := m["uri"].(string)
		uris = append(uris, uri)
	}
	return uris
}

func TestReferenceMigrator_AiBlockAttachmentContainerMapping(t *testing.T) {
	in := []SieveBlock{aiBlockWithAttachments(
		map[string]interface{}{"uri": "container:" + testAssetUUID, "title": "Godot Notes"},
	)}
	out, changed := ReferenceMigrator{}.Migrate(in, testRefDocUUID)
	if !changed {
		t.Fatal("a legacy attachment uri must report the tree changed")
	}
	if got := attachmentURIs(t, out[0]); len(got) != 1 || got[0] != "sieve://"+testAssetUUID {
		t.Errorf("uris = %v, want [sieve://%s]", got, testAssetUUID)
	}
	// The title the turn recorded survives the rewrite.
	list, _ := out[0].Attrs["attachments"].([]interface{})
	if m, _ := list[0].(map[string]interface{}); m["title"] != "Godot Notes" {
		t.Errorf("title = %v, want Godot Notes", m["title"])
	}
	// The input tree is never mutated.
	if got := attachmentURIs(t, in[0]); got[0] != "container:"+testAssetUUID {
		t.Error("Migrate mutated its input")
	}
}

func TestReferenceMigrator_AiBlockAttachmentPinnedMapping(t *testing.T) {
	in := []SieveBlock{aiBlockWithAttachments(
		map[string]interface{}{"uri": "container:" + testAssetUUID + "@v3"},
	)}
	out, changed := ReferenceMigrator{}.Migrate(in, testRefDocUUID)
	if !changed {
		t.Fatal("changed = false")
	}
	if got := attachmentURIs(t, out[0]); got[0] != "sieve://"+testAssetUUID+"?version=3" {
		t.Errorf("uris = %v", got)
	}
}

// A mixed list rewrites only the legacy entry; a fully current list reports no
// change at all (and an unrecognised spelling stays verbatim — it dangles, as it
// always did).
func TestReferenceMigrator_AiBlockAttachmentsCurrentAndUnrecognisedUntouched(t *testing.T) {
	current := "sieve://" + testAssetUUID
	in := []SieveBlock{aiBlockWithAttachments(
		map[string]interface{}{"uri": current, "title": "Fine"},
		map[string]interface{}{"uri": "container:not-a-uuid"},
	)}
	out, changed := ReferenceMigrator{}.Migrate(in, testRefDocUUID)
	if changed {
		t.Errorf("nothing rewritable must report no change; got %v", attachmentURIs(t, out[0]))
	}

	clean := []SieveBlock{aiBlockWithAttachments(map[string]interface{}{"uri": current})}
	if _, changed := (ReferenceMigrator{}).Migrate(clean, testRefDocUUID); changed {
		t.Error("a current attachment list must not report a change")
	}
}

func TestReferenceMigrator_AiBlockWithoutAttachmentsUntouched(t *testing.T) {
	in := []SieveBlock{{ID: "ai-1", Kind: "ai-block", Attrs: map[string]interface{}{"id": "ai-1", "question": "why?"}}}
	if _, changed := (ReferenceMigrator{}).Migrate(in, testRefDocUUID); changed {
		t.Error("an attachment-less ai-block must not report a change")
	}
}
