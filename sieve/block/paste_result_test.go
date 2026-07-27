package block

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// The JSON below IS the contract the frontend switches on: the handler encodes this
// value with no shape of its own. Absent keys matter as much as present ones — a
// content result carries no block identity and vice versa.
func TestPasteResult_JSONPerOutcome(t *testing.T) {
	tests := []struct {
		name   string
		result PasteResult
		want   map[string]string
	}{
		{
			name:   "block created",
			result: PasteBlock("code", "co-1a2b", "id: co-1a2b\nlanguage: go\n"),
			want: map[string]string{
				"outcome": "block",
				"kind":    "code",
				"id":      "co-1a2b",
				"rawYaml": "id: co-1a2b\nlanguage: go\n",
			},
		},
		{
			name:   "content to insert",
			result: PasteContent(`<a href="https://example.com">Example Domain</a>`),
			want: map[string]string{
				"outcome": "content",
				"html":    `<a href="https://example.com">Example Domain</a>`,
			},
		},
		{
			name:   "nothing happened",
			result: PasteNothing(),
			want:   map[string]string{"outcome": "none"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw, err := json.Marshal(tt.result)
			if err != nil {
				t.Fatalf("Marshal: %v", err)
			}
			var got map[string]string
			if err := json.Unmarshal(raw, &got); err != nil {
				t.Fatalf("Unmarshal: %v — raw=%s", err, raw)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("JSON fields:\n got %#v\nwant %#v\n(raw %s)", got, tt.want, raw)
			}
		})
	}
}

// encoding/json escapes HTML on the wire, so the fragment never travels as literal
// markup; JSON.parse restores it verbatim on the other side.
func TestPasteResult_ContentIsHTMLEscapedOnTheWire(t *testing.T) {
	raw, err := json.Marshal(PasteContent(`<a href="https://example.com">x</a>`))
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if strings.ContainsAny(string(raw), "<>") {
		t.Errorf("expected HTML-escaped transport, got %s", raw)
	}
}

// Only a block outcome carries a block identity — the discriminator, not the
// presence of a field, is what callers branch on.
func TestPasteResult_IsBlock(t *testing.T) {
	if !PasteBlock("code", "co-1", "").IsBlock() {
		t.Error("block outcome must report IsBlock")
	}
	if PasteContent(`<a href="https://x.test">x</a>`).IsBlock() {
		t.Error("content outcome must not report IsBlock")
	}
	if PasteNothing().IsBlock() {
		t.Error("nothing outcome must not report IsBlock")
	}
}
