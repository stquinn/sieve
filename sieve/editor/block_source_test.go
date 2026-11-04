package editor

import (
	"errors"
	"strings"
	"testing"

	"sieve/sieve/domain"
)

func TestBlockSource_Resolve(t *testing.T) {
	containers, ds, _ := newTestContainers(t)
	source := NewBlockSource(containers)

	c, err := containers.Create(containerKind, map[string]interface{}{
		"title": "old", "summary": "the summary", "source": "old source", "aliases": []string{"sticky-name"},
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	uuid := c.UUID()
	if _, err := containers.SaveAsset(c, "strokes.jsonl", []byte("12345")); err != nil {
		t.Fatalf("SaveAsset: %v", err)
	}
	c.Merge(map[string]interface{}{"mark": "kept"})
	c, err = containers.Save(c)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	pinned := c.Versions()[0].ID
	c.Merge(map[string]interface{}{"title": "new", "source": "new source"})
	if _, err := containers.Save(c); err != nil {
		t.Fatalf("Save: %v", err)
	}

	for _, tc := range []struct {
		name, uri, wantID, wantKind, wantTitle, wantBody string
		wantAttrs                                        bool
	}{
		{"container", "sieve://" + uuid, uuid, containerKind, "new", "new source", true},
		{"pinned container", "sieve://" + uuid + "?version=" + pinned, uuid, containerKind, "old", "old source", true},
		{"block leaf", "sieve://" + uuid + "/" + uuid, uuid, containerKind, "new", "new source", true},
		{"alias leaf", "sieve://" + uuid + "/sticky-name", uuid, containerKind, "new", "new source", true},
		{"asset leaf", "sieve://" + uuid + "/strokes.jsonl", "strokes.jsonl", assetKind, "strokes.jsonl", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			node, err := source.Resolve(mustAddress(t, tc.uri))
			if err != nil {
				t.Fatalf("Resolve: %v", err)
			}
			if node.ID != tc.wantID || node.Kind != tc.wantKind || node.Title != tc.wantTitle || !strings.Contains(node.Body, tc.wantBody) {
				t.Errorf("node = %+v", node)
			}
			if tc.wantAttrs != (node.Attrs != nil) {
				t.Errorf("Attrs = %v, want present=%v", node.Attrs, tc.wantAttrs)
			}
			if tc.wantAttrs && (node.Attrs["mark"] != "kept" || node.Summary != "the summary") {
				t.Errorf("descriptor lost the map: %+v", node)
			}
		})
	}

	doc, err := ds.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	for name, uri := range map[string]string{
		"a document":        "sieve://" + doc.UUID(),
		"nothing":           "sieve://" + testMissingUUID,
		"unwritten version": "sieve://" + uuid + "?version=99",
		"unknown leaf":      "sieve://" + uuid + "/no-such-leaf",
	} {
		if _, err := source.Resolve(mustAddress(t, uri)); !errors.Is(err, domain.ErrNodeNotFound) {
			t.Errorf("%s: err = %v, want ErrNodeNotFound", name, err)
		}
	}
}
