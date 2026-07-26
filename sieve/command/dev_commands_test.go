package command

import (
	"strings"
	"testing"

	"sieve/sieve/services"
	"sieve/store/filestore"
)

// docsWithBody builds a real DocumentService holding one saved document whose
// body is the given content, and returns the service plus the doc's UUID.
func docsWithBody(t *testing.T, body string) (*services.DocumentService, string) {
	t.Helper()
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
	doc.SetBody([]byte(body))
	if _, err := docs.Save(doc); err != nil {
		t.Fatal(err)
	}
	return docs, doc.UUID()
}

func TestDevContentResolver_Resolve(t *testing.T) {
	docs, uuid := docsWithBody(t, "document body content")
	emptyDocs, emptyUUID := docsWithBody(t, "   \n  ")

	cases := []struct {
		name        string
		resolver    devContentResolver
		text        string
		ctx         Context
		wantContent string
		wantScope   string
	}{
		{
			name:        "inline text wins over selection and document",
			resolver:    devContentResolver{docs: docs},
			text:        "  inline  ",
			ctx:         Context{SelectedText: "selection", DocUUID: uuid},
			wantContent: "  inline  ", // returned verbatim, not trimmed
			wantScope:   "Inline Text",
		},
		{
			name:        "selection wins over document when no inline",
			resolver:    devContentResolver{docs: docs},
			text:        "   ",
			ctx:         Context{SelectedText: "selected words", DocUUID: uuid},
			wantContent: "selected words",
			wantScope:   "Selected Text",
		},
		{
			name:        "document fallback when no inline or selection",
			resolver:    devContentResolver{docs: docs},
			text:        "",
			ctx:         Context{DocUUID: uuid},
			wantContent: "document body content",
			wantScope:   "Document",
		},
		{
			name:        "empty everything yields empty scope",
			resolver:    devContentResolver{docs: docs},
			text:        "  ",
			ctx:         Context{},
			wantContent: "",
			wantScope:   "",
		},
		{
			name:        "blank document body is not a fallback",
			resolver:    devContentResolver{docs: emptyDocs},
			text:        "",
			ctx:         Context{DocUUID: emptyUUID},
			wantContent: "",
			wantScope:   "",
		},
		{
			name:        "nil docs tolerated",
			resolver:    devContentResolver{docs: nil},
			text:        "",
			ctx:         Context{DocUUID: uuid},
			wantContent: "",
			wantScope:   "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			content, scope := tc.resolver.resolve(tc.text, tc.ctx)
			if content != tc.wantContent || scope != tc.wantScope {
				t.Fatalf("resolve() = (%q, %q), want (%q, %q)", content, scope, tc.wantContent, tc.wantScope)
			}
		})
	}
}

func TestJWTCommand_DecodeSegment(t *testing.T) {
	c := NewJWTCommand()

	cases := []struct {
		name     string
		seg      string
		wantErr  bool
		contains string // substring expected in the decoded output on success
	}{
		{
			// {"alg":"HS256"} — base64url length 20 → %4 == 0, no padding needed.
			name:     "no padding needed",
			seg:      "eyJhbGciOiJIUzI1NiJ9",
			contains: `"alg": "HS256"`,
		},
		{
			// {"a":1} → "eyJhIjoxfQ" (len 10, %4 == 2 → "==" restored).
			name:     "two-char padding restored",
			seg:      "eyJhIjoxfQ",
			contains: `"a": 1`,
		},
		{
			// {"ab":1} → "eyJhYiI6MX0" (len 11, %4 == 3 → "=" restored).
			name:     "one-char padding restored",
			seg:      "eyJhYiI6MX0",
			contains: `"ab": 1`,
		},
		{
			name:    "invalid base64url",
			seg:     "!!!not-base64!!!",
			wantErr: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out, err := c.decodeSegment(tc.seg)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("decodeSegment(%q) = %q, want error", tc.seg, out)
				}
				return
			}
			if err != nil {
				t.Fatalf("decodeSegment(%q) unexpected error: %v", tc.seg, err)
			}
			if !strings.Contains(out, tc.contains) {
				t.Fatalf("decodeSegment(%q) = %q, want to contain %q", tc.seg, out, tc.contains)
			}
		})
	}
}
