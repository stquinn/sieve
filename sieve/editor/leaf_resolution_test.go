package editor

import (
	"errors"
	"strconv"
	"strings"
	"testing"

	"sieve/sieve/block"
	"sieve/sieve/block/processors"
	"sieve/sieve/domain"
	"sieve/sieve/services"
	"sieve/store/filestore"
)

// Leaf resolution answers for every address the grammar admits. These tests
// exercise it through NotesSource — the source that holds containers is the
// thing that reaches inside one, so there is no separate seam to poke.

// Two uuids differing only in case: the id lookup must fold them together while
// still preferring the spelling it was given.
const (
	testUpperBlockUUID = "0190A1B2-C3D4-7E5F-8A9B-0C1D2E3F4B01"
	testLowerBlockUUID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01"
	testOtherBlockUUID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b02"
)

// withCodeProcessor registers the code flavour on top of the prose terminal for
// the duration of a test. A fenced kind is what lets a test DECLARE block ids,
// aliases and attrs — parsed prose mints its own ids, which is the wrong end of
// the lookup to pin — and prose stays registered because it is what mops up the
// gaps between fences, exactly as in production.
func withCodeProcessor(t *testing.T) {
	t.Helper()
	resetRegistry()
	block.RegisterProcessor(processors.NewCodeBlockProcessor(block.BlockServices{}))
	t.Cleanup(resetRegistry)
}

// codeFence spells one code block's on-disk form. attrs are extra YAML lines.
func codeFence(id string, attrs ...string) string {
	lines := append([]string{"```code", "id: " + id}, attrs...)
	return strings.Join(append(lines, "```"), "\n")
}

// leafURI spells sieve://{container}/{leaf}.
func leafURI(container, leaf string) string {
	return domain.NewLeafAddress(container, leaf).String()
}

// seedNoteWithBlocks files a note whose body is the given fenced blocks.
func seedNoteWithBlocks(t *testing.T, ds *services.DocumentService, body string) domain.Document {
	t.Helper()
	return seedFiledNote(t, ds, "Retry Design", "design", nil, "How retries back off.", body)
}

// pngBytes is a one-pixel PNG — enough for the store to infer an encoding.
var pngBytes = []byte("\x89PNG\r\n\x1a\n" + strings.Repeat("\x00", 16))

// attachAsset writes an asset file into a note's directory and refreshes the
// store's view of it. The store caches a document's ownership graph at scan
// time, so a file dropped in afterwards is invisible until the directory is
// re-read — which is what Load does.
func attachAsset(t *testing.T, fs *filestore.FileStore, note domain.Document, key string) {
	t.Helper()
	if _, err := fs.CreateAsset(domain.LibraryCategory, note.UUID(), key, pngBytes); err != nil {
		t.Fatalf("CreateAsset %q: %v", key, err)
	}
	if _, err := fs.Load(domain.LibraryCategory, note.UUID()); err != nil {
		t.Fatalf("re-scan after attaching %q: %v", key, err)
	}
}

func TestNotesSource_ResolvesABlockLeafByID(t *testing.T) {
	withCodeProcessor(t)
	src, ds := newTestNotesSource(t)
	note := seedNoteWithBlocks(t, ds, codeFence(testLowerBlockUUID,
		"title: The retry loop",
		"summary: Exponential backoff, capped.",
		"language: go",
		"source: for i := 0; i < 3; i++ {}"))

	uri := leafURI(note.UUID(), testLowerBlockUUID)
	node, err := src.Resolve(mustAddress(t, uri))
	if err != nil {
		t.Fatalf("Resolve leaf: %v", err)
	}
	if node.URI != uri {
		t.Errorf("uri = %q, want %q", node.URI, uri)
	}
	if node.UUID != testLowerBlockUUID {
		t.Errorf("uuid = %q, want the block's id", node.UUID)
	}
	if node.Kind != "code" {
		t.Errorf("kind = %q, want the block's own kind", node.Kind)
	}
	if node.Title != "The retry loop" || node.Summary != "Exponential backoff, capped." {
		t.Errorf("node = %+v, want the block's own title and summary, not the container's", node)
	}
	// The descriptor carries what a model READS — the block's markdown
	// representation, never the fenced YAML it is stored as.
	if !strings.Contains(node.Body, "for i := 0; i < 3; i++ {}") {
		t.Errorf("body = %q, want the block's markdown", node.Body)
	}
	if strings.Contains(node.Body, "id: ") {
		t.Errorf("body = %q, want the markdown representation, not the on-disk form", node.Body)
	}
}

func TestNotesSource_ResolvesABlockLeafByAlias(t *testing.T) {
	withCodeProcessor(t)
	src, ds := newTestNotesSource(t)
	note := seedNoteWithBlocks(t, ds, codeFence(testLowerBlockUUID,
		"aliases:\n  - the-retry-loop",
		"source: backoff()"))

	node, err := src.Resolve(mustAddress(t, leafURI(note.UUID(), "the-retry-loop")))
	if err != nil {
		t.Fatalf("Resolve alias leaf: %v", err)
	}
	if node.UUID != testLowerBlockUUID {
		t.Errorf("uuid = %q, want the block the alias names", node.UUID)
	}
	// An alias is a NAME, not an identity: what comes back is the block's own
	// coordinate, so a consumer that round-trips it lands on the same block.
	if node.URI != leafURI(note.UUID(), testLowerBlockUUID) {
		t.Errorf("uri = %q, want the block's id-spelled coordinate", node.URI)
	}
}

// Case never distinguishes two Sieve coordinates: a hand-typed address in the
// wrong case names the same block, in both lookups.
func TestNotesSource_LeafLookupFoldsCase(t *testing.T) {
	withCodeProcessor(t)
	src, ds := newTestNotesSource(t)
	note := seedNoteWithBlocks(t, ds, codeFence(testLowerBlockUUID,
		"aliases:\n  - the-retry-loop",
		"source: backoff()"))

	for name, leaf := range map[string]string{
		"id":    testUpperBlockUUID,
		"alias": "The-Retry-Loop",
	} {
		t.Run(name, func(t *testing.T) {
			node, err := src.Resolve(mustAddress(t, leafURI(note.UUID(), leaf)))
			if err != nil {
				t.Fatalf("Resolve %q: %v", leaf, err)
			}
			if node.UUID != testLowerBlockUUID {
				t.Errorf("uuid = %q, want the block regardless of the caller's case", node.UUID)
			}
			// The CONTAINER's spelling comes back, never the caller's: a
			// case-forgiving address must not travel onward mis-spelled.
			if node.URI != leafURI(note.UUID(), testLowerBlockUUID) {
				t.Errorf("uri = %q, want the container's own spelling", node.URI)
			}
		})
	}
}

// Folding only ever rescues what would otherwise be a miss — a precise address
// still reaches the precise thing, in both lookups.
func TestNotesSource_ExactLeafMatchBeatsAFoldedOne(t *testing.T) {
	withCodeProcessor(t)

	t.Run("id", func(t *testing.T) {
		src, ds := newTestNotesSource(t)
		// The folded candidate is written FIRST, so a lookup that stopped at the
		// first case-insensitive hit would answer with it.
		note := seedNoteWithBlocks(t, ds,
			codeFence(testLowerBlockUUID, "source: folded")+"\n\n"+
				codeFence(testUpperBlockUUID, "source: exact"))

		node, err := src.Resolve(mustAddress(t, leafURI(note.UUID(), testUpperBlockUUID)))
		if err != nil {
			t.Fatalf("Resolve: %v", err)
		}
		if node.UUID != testUpperBlockUUID {
			t.Errorf("uuid = %q, want the exactly-spelled block", node.UUID)
		}
	})

	t.Run("alias", func(t *testing.T) {
		src, ds := newTestNotesSource(t)
		note := seedNoteWithBlocks(t, ds,
			codeFence(testOtherBlockUUID, "aliases:\n  - The-Retry-Loop", "source: folded")+"\n\n"+
				codeFence(testLowerBlockUUID, "aliases:\n  - the-retry-loop", "source: exact"))

		node, err := src.Resolve(mustAddress(t, leafURI(note.UUID(), "the-retry-loop")))
		if err != nil {
			t.Fatalf("Resolve: %v", err)
		}
		if node.UUID != testLowerBlockUUID {
			t.Errorf("uuid = %q, want the exactly-spelled alias's block", node.UUID)
		}
	})
}

// The lookups are ORDERED, not merged. An id is the primary handle and an
// alias is a name given on top of one, so the whole id lookup — folded matches
// included — runs before the alias lookup is consulted at all.
func TestNotesSource_TheIDLookupOutranksTheAliasLookup(t *testing.T) {
	withCodeProcessor(t)

	t.Run("exact id beats exact alias", func(t *testing.T) {
		src, ds := newTestNotesSource(t)
		note := seedNoteWithBlocks(t, ds,
			codeFence(testOtherBlockUUID, "aliases:\n  - "+testLowerBlockUUID, "source: by alias")+"\n\n"+
				codeFence(testLowerBlockUUID, "source: by id"))

		node, err := src.Resolve(mustAddress(t, leafURI(note.UUID(), testLowerBlockUUID)))
		if err != nil {
			t.Fatalf("Resolve: %v", err)
		}
		if node.UUID != testLowerBlockUUID {
			t.Errorf("uuid = %q, want the block whose ID it is", node.UUID)
		}
	})

	t.Run("folded id beats exact alias", func(t *testing.T) {
		src, ds := newTestNotesSource(t)
		note := seedNoteWithBlocks(t, ds,
			codeFence(testOtherBlockUUID, "aliases:\n  - "+testUpperBlockUUID, "source: by alias")+"\n\n"+
				codeFence(testLowerBlockUUID, "source: by id"))

		node, err := src.Resolve(mustAddress(t, leafURI(note.UUID(), testUpperBlockUUID)))
		if err != nil {
			t.Fatalf("Resolve: %v", err)
		}
		if node.UUID != testLowerBlockUUID {
			t.Errorf("uuid = %q, want the id lookup's answer — it runs to completion first", node.UUID)
		}
	})
}

// THE point of pinning a leaf: the block is read out of the snapshot the address
// names, not out of whatever the container says today.
func TestNotesSource_PinnedBlockLeafReadsTheSnapshot(t *testing.T) {
	withCodeProcessor(t)
	src, ds := newTestNotesSource(t)
	note := seedNoteWithBlocks(t, ds, codeFence(testLowerBlockUUID, "source: backoff()"))
	pinned := latestVersion(t, note)
	revised := reviseNote(t, ds, note, codeFence(testLowerBlockUUID, "source: backoffWithJitter()"))
	if latestVersion(t, revised) == pinned {
		t.Fatalf("precondition: the revision did not write a new version (still %d)", pinned)
	}

	uri := leafURI(note.UUID(), testLowerBlockUUID) + "?version=" + strconv.Itoa(pinned)
	node, err := src.Resolve(mustAddress(t, uri))
	if err != nil {
		t.Fatalf("Resolve pinned leaf: %v", err)
	}
	if !strings.Contains(node.Body, "backoff()") || strings.Contains(node.Body, "Jitter") {
		t.Errorf("body = %q, want the version-%d snapshot's block", node.Body, pinned)
	}
	// The pin rides on the coordinate that comes back, so the descriptor names
	// the frozen leaf it actually answered with.
	if node.URI != uri {
		t.Errorf("uri = %q, want the pinned coordinate %q", node.URI, uri)
	}

	live, err := src.Resolve(mustAddress(t, leafURI(note.UUID(), testLowerBlockUUID)))
	if err != nil {
		t.Fatalf("Resolve live leaf: %v", err)
	}
	if !strings.Contains(live.Body, "backoffWithJitter()") {
		t.Errorf("live body = %q, want the revision", live.Body)
	}
}

// A block that exists only in TODAY's container is not in the snapshot a pin
// names, so the pinned coordinate dangles — the pin is honoured for a block
// leaf, never quietly widened to "somewhere in this document's history".
func TestNotesSource_PinnedLeafDoesNotSeeLaterBlocks(t *testing.T) {
	withCodeProcessor(t)
	src, ds := newTestNotesSource(t)
	note := seedNoteWithBlocks(t, ds, codeFence(testOtherBlockUUID, "source: original()"))
	pinned := latestVersion(t, note)
	reviseNote(t, ds, note, codeFence(testOtherBlockUUID, "source: original()")+"\n\n"+
		codeFence(testLowerBlockUUID, "source: added later"))

	uri := leafURI(note.UUID(), testLowerBlockUUID) + "?version=" + strconv.Itoa(pinned)
	if _, err := src.Resolve(mustAddress(t, uri)); !errors.Is(err, domain.ErrNodeNotFound) {
		t.Fatalf("err = %v, want ErrNodeNotFound", err)
	}
}

// A pin names a CONTAINER version. One nobody wrote dangles whatever grain the
// address goes on to name — the leaf never gets a chance to be looked up,
// because there is no content to look it up in.
func TestNotesSource_LeafPinnedToAVersionNobodyWroteDangles(t *testing.T) {
	withCodeProcessor(t)
	src, ds := newTestNotesSource(t)
	note := seedNoteWithBlocks(t, ds, codeFence(testLowerBlockUUID, "source: backoff()"))

	uri := leafURI(note.UUID(), testLowerBlockUUID) + "?version=" + strconv.Itoa(latestVersion(t, note)+99)
	if _, err := src.Resolve(mustAddress(t, uri)); !errors.Is(err, domain.ErrNodeNotFound) {
		t.Fatalf("err = %v, want ErrNodeNotFound", err)
	}
}

// Every miss dangles, and dangling is NORMAL — a reference outliving the block
// it named is the ordinary way one goes stale, not a failure to report.
func TestNotesSource_LeafMissesDangle(t *testing.T) {
	withCodeProcessor(t)
	src, ds := newTestNotesSource(t)
	note := seedNoteWithBlocks(t, ds, codeFence(testLowerBlockUUID,
		"aliases:\n  - the-retry-loop", "source: backoff()"))

	misses := map[string]string{
		"no block by that id":      leafURI(note.UUID(), testOtherBlockUUID),
		"no block by that alias":   leafURI(note.UUID(), "the-timeout-loop"),
		"no asset by that key":     leafURI(note.UUID(), "diagram.png"),
		"a leaf in no container":   leafURI(testMissingUUID, testLowerBlockUUID),
		"a leaf inside a snapshot": leafURI(note.UUID(), "nothing-by-this-name") + "?version=1",
	}
	for name, uri := range misses {
		t.Run(name, func(t *testing.T) {
			if _, err := src.Resolve(mustAddress(t, uri)); !errors.Is(err, domain.ErrNodeNotFound) {
				t.Fatalf("err = %v, want ErrNodeNotFound", err)
			}
		})
	}
}

// The source invariant survives the new grain: this source answers for filed
// notes, so a leaf inside an unfiled buffer is refused exactly as the buffer
// itself is.
func TestNotesSource_RefusesALeafInsideABuffer(t *testing.T) {
	withCodeProcessor(t)
	src, ds := newTestNotesSource(t)
	buf, err := ds.New()
	if err != nil {
		t.Fatalf("New buffer: %v", err)
	}
	buf.SetBody([]byte(codeFence(testLowerBlockUUID, "source: backoff()")))
	if _, err := ds.Save(buf); err != nil {
		t.Fatalf("Save: %v", err)
	}

	uri := leafURI(buf.UUID(), testLowerBlockUUID)
	if _, err := src.Resolve(mustAddress(t, uri)); !errors.Is(err, domain.ErrNodeNotFound) {
		t.Fatalf("err = %v, want ErrNodeNotFound", err)
	}
}

// A block with nothing to render — an empty payload, a job that has not
// answered yet — still RESOLVES: the address names it, and identity is what a
// caller asked for. Only the body is empty.
func TestNotesSource_LeafWithNoMarkdownStillResolves(t *testing.T) {
	withCodeProcessor(t)
	src, ds := newTestNotesSource(t)
	note := seedNoteWithBlocks(t, ds, codeFence(testLowerBlockUUID, "title: Empty so far"))

	node, err := src.Resolve(mustAddress(t, leafURI(note.UUID(), testLowerBlockUUID)))
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if node.UUID != testLowerBlockUUID || node.Kind != "code" || node.Title != "Empty so far" {
		t.Errorf("node = %+v, want the block identified", node)
	}
	if node.Body != "" {
		t.Errorf("body = %q, want empty", node.Body)
	}
}

// ── The asset lookup ──────────────────────────────────────────────────────────
//
// The grammar admits sieve://{container}/{asset-key}, so the resolver answers
// for it: a caller can hold a coordinate opaquely and ask what it names without
// knowing in advance whether the leaf is a block or a file.

// newTestNotesSourceWithStore is newTestNotesSource plus the store behind it,
// which is what an asset has to be created through.
func newTestNotesSourceWithStore(t *testing.T) (*NotesSource, *services.DocumentService, *filestore.FileStore) {
	t.Helper()
	ds, fs := newTestDocumentService(t)
	return NewNotesSource(ds), ds, fs
}

func TestNotesSource_ResolvesAnAssetLeafByKey(t *testing.T) {
	withCodeProcessor(t)
	src, ds, fs := newTestNotesSourceWithStore(t)
	note := seedNoteWithBlocks(t, ds, codeFence(testLowerBlockUUID, "source: backoff()"))
	attachAsset(t, fs, note, "diagram.png")

	uri := leafURI(note.UUID(), "diagram.png")
	node, err := src.Resolve(mustAddress(t, uri))
	if err != nil {
		t.Fatalf("Resolve asset leaf: %v", err)
	}
	if node.URI != uri || node.UUID != "diagram.png" || node.Title != "diagram.png" {
		t.Errorf("node = %+v, want the asset's own key as identity and name", node)
	}
	// Kind is the CONSTANT noun, never a media type sniffed from the extension:
	// mime.TypeByExtension reads the host's mime files, so that would make one
	// address answer differently on two machines.
	if node.Kind != assetKind {
		t.Errorf("kind = %q, want %q", node.Kind, assetKind)
	}
	// A descriptor never streams bytes.
	if node.Body != "" {
		t.Errorf("body = %q, want empty — bytes are fetched by URL, not by descriptor", node.Body)
	}
}

// Every asset reports the SAME kind, whatever its extension. A kind that varied
// with the extension would have to ask the host what an extension means, and the
// host is exactly what must not be able to change an address's answer.
func TestNotesSource_EveryAssetReportsTheSameKind(t *testing.T) {
	withCodeProcessor(t)
	src, ds, fs := newTestNotesSourceWithStore(t)
	note := seedNoteWithBlocks(t, ds, codeFence(testLowerBlockUUID, "source: backoff()"))

	for _, key := range []string{"diagram.png", "clip.mp4", "capture.zzz", "notes.txt"} {
		attachAsset(t, fs, note, key)
		node, err := src.Resolve(mustAddress(t, leafURI(note.UUID(), key)))
		if err != nil {
			t.Fatalf("Resolve %q: %v", key, err)
		}
		if node.Kind != assetKind {
			t.Errorf("kind for %q = %q, want the host-independent %q", key, node.Kind, assetKind)
		}
	}
}

func TestNotesSource_AssetLookupFoldsCaseButPrefersTheExactKey(t *testing.T) {
	withCodeProcessor(t)
	src, ds, fs := newTestNotesSourceWithStore(t)
	note := seedNoteWithBlocks(t, ds, codeFence(testLowerBlockUUID, "source: backoff()"))
	attachAsset(t, fs, note, "diagram.png")
	attachAsset(t, fs, note, "Diagram.png")

	// Both keys exist and differ only in case, so each address must reach its
	// own file: folding rescues a miss, it never overrides a hit.
	for _, key := range []string{"diagram.png", "Diagram.png"} {
		node, err := src.Resolve(mustAddress(t, leafURI(note.UUID(), key)))
		if err != nil {
			t.Fatalf("Resolve %q: %v", key, err)
		}
		if node.UUID != key {
			t.Errorf("uuid = %q, want the exactly-spelled key %q", node.UUID, key)
		}
	}

	// A spelling neither file has folds to one of them, and what comes back is
	// the CONTAINER's spelling — a served asset URL built from the caller's
	// would 404 on a case-sensitive filesystem.
	node, err := src.Resolve(mustAddress(t, leafURI(note.UUID(), "DIAGRAM.PNG")))
	if err != nil {
		t.Fatalf("Resolve folded: %v", err)
	}
	if node.UUID != "diagram.png" && node.UUID != "Diagram.png" {
		t.Errorf("uuid = %q, want one of the keys the container holds", node.UUID)
	}
	if node.URI != leafURI(note.UUID(), node.UUID) {
		t.Errorf("uri = %q, want it rebuilt from the resolved key", node.URI)
	}
}

// The block index is consulted first: an asset keyed like a block's alias is
// reached only when no block answers to that name.
func TestNotesSource_TheBlockLookupsOutrankTheAssetLookup(t *testing.T) {
	withCodeProcessor(t)

	t.Run("exact alias beats exact asset key", func(t *testing.T) {
		src, ds, fs := newTestNotesSourceWithStore(t)
		note := seedNoteWithBlocks(t, ds, codeFence(testLowerBlockUUID,
			"aliases:\n  - diagram.png", "source: backoff()"))
		attachAsset(t, fs, note, "diagram.png")

		node, err := src.Resolve(mustAddress(t, leafURI(note.UUID(), "diagram.png")))
		if err != nil {
			t.Fatalf("Resolve: %v", err)
		}
		if node.UUID != testLowerBlockUUID {
			t.Errorf("uuid = %q, want the block whose alias it is", node.UUID)
		}
	})

	// Where the two settled rules actually pull against each other: the alias
	// matches only after folding, the asset key matches exactly. Lookup order still
	// wins, because folding is forgiveness for a mis-cased address and must never
	// re-rank the vocabularies — turning it on may only rescue a miss, never
	// change which THING an address names.
	t.Run("folded alias beats exact asset key", func(t *testing.T) {
		src, ds, fs := newTestNotesSourceWithStore(t)
		note := seedNoteWithBlocks(t, ds, codeFence(testLowerBlockUUID,
			"aliases:\n  - Diagram.PNG", "source: backoff()"))
		attachAsset(t, fs, note, "diagram.png")

		node, err := src.Resolve(mustAddress(t, leafURI(note.UUID(), "diagram.png")))
		if err != nil {
			t.Fatalf("Resolve: %v", err)
		}
		if node.UUID != testLowerBlockUUID {
			t.Errorf("uuid = %q, want the block — lookup order outranks an exact match in a weaker lookup", node.UUID)
		}
	})
}

// The pin is IGNORED at an asset leaf. Assets are immutable, so the only
// version-dependent fact about one is whether the container held it yet — and a
// historical asset list could say nothing a current one does not. Membership is
// judged against what the container owns now, so an asset added after the pinned
// version still resolves.
func TestNotesSource_PinnedAssetLeafIgnoresThePin(t *testing.T) {
	withCodeProcessor(t)
	src, ds, fs := newTestNotesSourceWithStore(t)
	note := seedNoteWithBlocks(t, ds, codeFence(testLowerBlockUUID, "source: backoff()"))
	pinned := latestVersion(t, note)
	revised := reviseNote(t, ds, note, codeFence(testLowerBlockUUID, "source: backoffWithJitter()"))
	if latestVersion(t, revised) == pinned {
		t.Fatalf("precondition: the revision did not write a new version (still %d)", pinned)
	}
	attachAsset(t, fs, note, "diagram.png")

	uri := leafURI(note.UUID(), "diagram.png") + "?version=" + strconv.Itoa(pinned)
	node, err := src.Resolve(mustAddress(t, uri))
	if err != nil {
		t.Fatalf("Resolve pinned asset leaf: %v", err)
	}
	if node.UUID != "diagram.png" {
		t.Errorf("node = %+v, want the asset, judged against current membership", node)
	}
}
