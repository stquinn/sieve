package filestore

import (
	"reflect"
	"testing"
)

func TestFrontmatterRoundTrip(t *testing.T) {
	tests := []struct {
		name string
		meta map[string]string
		body string
	}{
		{
			name: "Simple",
			meta: map[string]string{
				"uuid":   "123",
				"status": "filed",
			},
			body: "hello world\n",
		},
		{
			name: "Colon in value (The Bug)",
			meta: map[string]string{
				"summary": "Task: Complete this",
			},
			body: "body\n",
		},
		{
			name: "Tags (Arrays)",
			meta: map[string]string{
				"tags": "[leap, scheme]",
			},
			body: "body\n",
		},
		{
			name: "Dates",
			meta: map[string]string{
				"created": "2026-04-16T15:05:26",
			},
			body: "body\n",
		},
		{
			name: "Nulls",
			meta: map[string]string{
				"user_intent": "null",
			},
			body: "body\n",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Serialise
			out := serialiseFrontmatter(tt.meta, []byte(tt.body))

			// Parse back
			gotMeta, gotBody, err := parseFrontmatter(out)
			if err != nil {
				t.Fatalf("parseFrontmatter error: %v\nRaw output:\n%s", err, string(out))
			}

			if !reflect.DeepEqual(gotMeta, tt.meta) {
				t.Errorf("meta mismatch\ngot:  %+v\nwant: %+v\nRaw output:\n%s", gotMeta, tt.meta, string(out))
			}

			if string(gotBody) != tt.body {
				t.Errorf("body mismatch\ngot:  %q\nwant: %q", string(gotBody), tt.body)
			}
		})
	}
}

func TestRecoveryMode(t *testing.T) {
	// A corrupt YAML block that will cause a parsing error.
	corruptData := []byte("---\ninvalid: : yaml: error\n---\nraw body")

	// 1. Simulate buildStorable detecting the error.
	_, _, err := parseFrontmatter(corruptData)
	if err == nil {
		t.Fatal("expected parsing error for corrupt YAML")
	}

	// In graph.go, we would return a MetaStorable with status: error and the raw body.
	meta := map[string]string{
		"status": "error",
	}
	body := corruptData // We pass the WHOLE file as the body in error mode.

	// 2. Verify serialiseFrontmatter preserves the raw content for manual repair.
	out := serialiseFrontmatter(meta, body)
	if string(out) != string(corruptData) {
		t.Errorf("recovery serialisation failed\ngot:  %s\nwant: %s", string(out), string(corruptData))
	}
}
