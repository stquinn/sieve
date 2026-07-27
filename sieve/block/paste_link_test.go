package block

import (
	"strings"
	"testing"
	"time"

	"sieve/sieve/domain"
)

// stubPreview stands in for the network. Committed tests never make a real request:
// the port IS the seam, and a fetch that yields "" is exactly what the service
// returns on a timeout or any other failure.
type stubPreview struct {
	title      string
	calls      int
	gotURL     string
	gotTimeout time.Duration
}

func (s *stubPreview) FetchTitle(targetURL string, timeout time.Duration) string {
	s.calls++
	s.gotURL, s.gotTimeout = targetURL, timeout
	return s.title
}

func (s *stubPreview) FetchFull(string) domain.LinkPreviewResult { return domain.LinkPreviewResult{} }

func TestLinkPaste_Result(t *testing.T) {
	const url = "https://example.com/a"

	tests := []struct {
		name      string
		title     string // what the (stubbed) fetch returns; "" == timeout/failure/no title
		entries   []ContentEntry
		want      string // "" == the nothing outcome
		wantCalls int
	}{
		{
			name:      "bare URL, title fetched",
			title:     "Example Domain",
			entries:   []ContentEntry{{MIMEType: "text/plain", Content: url}},
			want:      `<a href="https://example.com/a">Example Domain</a>`,
			wantCalls: 1,
		},
		{
			name:      "bare URL, fetch times out or yields nothing: the URL labels itself",
			title:     "",
			entries:   []ContentEntry{{MIMEType: "text/plain", Content: url}},
			want:      `<a href="https://example.com/a">https://example.com/a</a>`,
			wantCalls: 1,
		},
		{
			name:      "bare URL with surrounding whitespace",
			title:     "Example Domain",
			entries:   []ContentEntry{{MIMEType: "text/plain", Content: "  " + url + "\n"}},
			want:      `<a href="https://example.com/a">Example Domain</a>`,
			wantCalls: 1,
		},
		{
			name:      "markdown autolink",
			title:     "Example Domain",
			entries:   []ContentEntry{{MIMEType: "text/plain", Content: "<" + url + ">"}},
			want:      `<a href="https://example.com/a">Example Domain</a>`,
			wantCalls: 1,
		},
		{
			name:      "markdown link: the clipboard's own label wins, no fetch",
			title:     "Ignored Remote Title",
			entries:   []ContentEntry{{MIMEType: "text/plain", Content: "[Hand-written label](" + url + ")"}},
			want:      `<a href="https://example.com/a">Hand-written label</a>`,
			wantCalls: 0,
		},
		{
			name:  "rendered anchor: href survives only in the HTML view",
			title: "Ignored Remote Title",
			entries: []ContentEntry{
				{MIMEType: "text/plain", Content: "Anchor Text"},
				{MIMEType: "text/html", Content: `<meta charset="utf-8"><a href="` + url + `">Anchor Text</a>`},
			},
			want:      `<a href="https://example.com/a">Anchor Text</a>`,
			wantCalls: 0,
		},
		{
			name:  "rendered anchor labelled with its own URL: title still fetched",
			title: "Example Domain",
			entries: []ContentEntry{
				{MIMEType: "text/html", Content: `<a href="` + url + `">` + url + `</a>`},
			},
			want:      `<a href="https://example.com/a">Example Domain</a>`,
			wantCalls: 1,
		},
		{
			name:      "prose that merely CONTAINS a link stays prose",
			title:     "Example Domain",
			entries:   []ContentEntry{{MIMEType: "text/plain", Content: "see [the docs](" + url + ") for more"}},
			want:      "",
			wantCalls: 0,
		},
		{
			name:      "non-http scheme is refused",
			title:     "Example Domain",
			entries:   []ContentEntry{{MIMEType: "text/plain", Content: "[click me](javascript:alert(1))"}},
			want:      "",
			wantCalls: 0,
		},
		{
			name:      "javascript href in an anchor is refused",
			title:     "Example Domain",
			entries:   []ContentEntry{{MIMEType: "text/html", Content: `<a href="javascript:alert(1)">click me</a>`}},
			want:      "",
			wantCalls: 0,
		},
		{
			name:      "ordinary text is not a link paste",
			title:     "Example Domain",
			entries:   []ContentEntry{{MIMEType: "text/plain", Content: "just plain text"}},
			want:      "",
			wantCalls: 0,
		},
		{
			name:      "no entries at all",
			title:     "Example Domain",
			entries:   nil,
			want:      "",
			wantCalls: 0,
		},
		{
			name:  "views carrying different links are not a single link",
			title: "Example Domain",
			entries: []ContentEntry{
				{MIMEType: "text/plain", Content: url},
				{MIMEType: "text/html", Content: `<a href="https://elsewhere.test/">other</a>`},
			},
			want:      "",
			wantCalls: 0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			stub := &stubPreview{title: tt.title}
			got := NewLinkPaste(stub).Result(tt.entries)

			if tt.want == "" {
				if got.Outcome != OutcomeNothing {
					t.Fatalf("expected the nothing outcome, got %+v", got)
				}
			} else {
				if got.Outcome != OutcomeContent {
					t.Fatalf("expected the content outcome, got %+v", got)
				}
				if got.HTML != tt.want {
					t.Errorf("HTML:\n got %s\nwant %s", got.HTML, tt.want)
				}
			}
			if stub.calls != tt.wantCalls {
				t.Errorf("fetch calls: got %d, want %d", stub.calls, tt.wantCalls)
			}
		})
	}
}

// The paste's patience is bounded at the composer, not inside the service: a
// background job may wait out a slow site, a paste in front of the caret may not.
func TestLinkPaste_BoundsTheFetch(t *testing.T) {
	stub := &stubPreview{title: "Example Domain"}
	NewLinkPaste(stub).Result([]ContentEntry{{MIMEType: "text/plain", Content: "https://example.com"}})

	if stub.gotTimeout != 3*time.Second {
		t.Errorf("fetch deadline: got %v, want 3s", stub.gotTimeout)
	}
	if stub.gotURL != "https://example.com" {
		t.Errorf("fetched %q, want the pasted URL", stub.gotURL)
	}
}

// A page <title> is untrusted remote input and this fragment is inserted into the
// user's document: nothing in it may break out of the anchor.
func TestLinkPaste_EscapesUntrustedTitle(t *testing.T) {
	hostile := `</a><script>alert("xss")</script> & <b>bold</b> "quoted"`
	stub := &stubPreview{title: hostile}

	got := NewLinkPaste(stub).Result([]ContentEntry{{MIMEType: "text/plain", Content: "https://example.com"}})

	if got.Outcome != OutcomeContent {
		t.Fatalf("expected the content outcome, got %+v", got)
	}
	for _, forbidden := range []string{"<script", "</a><", "<b>", `"quoted"`} {
		if strings.Contains(got.HTML, forbidden) {
			t.Errorf("escaped fragment must not contain %q; got %s", forbidden, got.HTML)
		}
	}
	want := `<a href="https://example.com">&lt;/a&gt;&lt;script&gt;alert(&#34;xss&#34;)&lt;/script&gt; &amp; &lt;b&gt;bold&lt;/b&gt; &#34;quoted&#34;</a>`
	if got.HTML != want {
		t.Errorf("HTML:\n got %s\nwant %s", got.HTML, want)
	}
	// Exactly one anchor: the payload cannot have opened a second element.
	if n := strings.Count(got.HTML, "<"); n != 2 {
		t.Errorf("expected exactly two tags (the anchor), found %d '<' in %s", n, got.HTML)
	}
}

// An href is remote input too — a quote in it must not escape the attribute.
func TestLinkPaste_EscapesHref(t *testing.T) {
	hostile := `https://example.com/?a=1&b="onmouseover="alert(1)`
	stub := &stubPreview{title: "T"}

	got := NewLinkPaste(stub).Result([]ContentEntry{{MIMEType: "text/plain", Content: hostile}})

	if got.Outcome != OutcomeContent {
		t.Fatalf("expected the content outcome, got %+v", got)
	}
	want := `<a href="https://example.com/?a=1&amp;b=&#34;onmouseover=&#34;alert(1)">T</a>`
	if got.HTML != want {
		t.Errorf("HTML:\n got %s\nwant %s", got.HTML, want)
	}
}

// A missing port must degrade, never panic: the URL labels itself.
func TestLinkPaste_NilPortFallsBackToTheURL(t *testing.T) {
	got := NewLinkPaste(nil).Result([]ContentEntry{{MIMEType: "text/plain", Content: "https://example.com"}})

	if got.Outcome != OutcomeContent {
		t.Fatalf("expected the content outcome, got %+v", got)
	}
	if want := `<a href="https://example.com">https://example.com</a>`; got.HTML != want {
		t.Errorf("HTML:\n got %s\nwant %s", got.HTML, want)
	}
}
