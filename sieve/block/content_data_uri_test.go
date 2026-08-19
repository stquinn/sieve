package block

import (
	"encoding/base64"
	"net/url"
	"testing"
)

func TestContentEntry_DecodeDataURI_base64AndPercentEncoded(t *testing.T) {
	svg := `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>`

	b64 := ContentEntry{Content: "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(svg))}
	if got, err := b64.DecodeDataURI(); err != nil || string(got) != svg {
		t.Errorf("DecodeDataURI(base64) = (%q, %v), want the svg source", got, err)
	}

	pct := ContentEntry{Content: "data:image/svg+xml," + url.PathEscape(svg)}
	if got, err := pct.DecodeDataURI(); err != nil || string(got) != svg {
		t.Errorf("DecodeDataURI(percent-encoded) = (%q, %v), want the svg source", got, err)
	}
}

// A drop reads a file as base64 with no wrapping, and a clipboard source may wrap
// the payload at column 76 — both must decode to the same bytes.
func TestContentEntry_DecodeDataURI_toleratesWrappedPayloads(t *testing.T) {
	body := []byte("openapi: 3.0.0\ninfo:\n  title: Payments\n")
	enc := base64.StdEncoding.EncodeToString(body)
	e := ContentEntry{Content: "data:text/yaml;base64," + enc[:8] + "\n" + enc[8:]}
	got, err := e.DecodeDataURI()
	if err != nil || string(got) != string(body) {
		t.Errorf("DecodeDataURI(wrapped) = (%q, %v), want the file bytes", got, err)
	}
}

func TestContentEntry_DecodeDataURI_rejectsAMalformedURI(t *testing.T) {
	if _, err := (ContentEntry{Content: "data:text/plain;base64"}).DecodeDataURI(); err == nil {
		t.Error("a data URI with no comma separator must be an error, not empty bytes")
	}
}

func TestContentEntry_IsDataURI(t *testing.T) {
	cases := []struct {
		content string
		want    bool
	}{
		{"data:text/yaml;base64,AAA=", true},
		{"  data:text/yaml;base64,AAA=", true},
		{"https://example.com/data:x", false},
		{"", false},
	}
	for _, tc := range cases {
		if got := (ContentEntry{Content: tc.content}).IsDataURI(); got != tc.want {
			t.Errorf("IsDataURI(%q) = %v, want %v", tc.content, got, tc.want)
		}
	}
}
