package block

import "testing"

// Link extraction is mechanical: it answers "what link is in this view".
// Kind policy (smart-image owns image URLs) is asserted at the processor level.
func TestContentEntry_Link(t *testing.T) {
	cases := []struct {
		name      string
		entry     ContentEntry
		wantHref  string
		wantLabel string
	}{
		{
			name:     "bare url",
			entry:    ContentEntry{MIMEType: "text/plain", Content: "https://example.com/a"},
			wantHref: "https://example.com/a",
		},
		{
			name:     "bare url with surrounding whitespace",
			entry:    ContentEntry{MIMEType: "text/plain", Content: "  https://example.com/a\n"},
			wantHref: "https://example.com/a",
		},
		{
			name:      "markdown link",
			entry:     ContentEntry{MIMEType: "text/plain", Content: "[Example Title](https://example.com/a)"},
			wantHref:  "https://example.com/a",
			wantLabel: "Example Title",
		},
		{
			name:      "markdown link inside a sentence",
			entry:     ContentEntry{MIMEType: "text/plain", Content: "see [Example Title](https://example.com/a) for more"},
			wantHref:  "https://example.com/a",
			wantLabel: "Example Title",
		},
		{
			name:     "markdown autolink",
			entry:    ContentEntry{MIMEType: "text/plain", Content: "<https://example.com/a>"},
			wantHref: "https://example.com/a",
		},
		{
			name:      "html anchor",
			entry:     ContentEntry{MIMEType: "text/html", Content: `<a href="https://example.com/a">Example Title</a>`},
			wantHref:  "https://example.com/a",
			wantLabel: "Example Title",
		},
		{
			name:      "html anchor with surrounding markup",
			entry:     ContentEntry{MIMEType: "text/html", Content: "<meta charset=\"utf-8\"><p class=\"x\">see <a class=\"lnk\" data-id='7' href='https://example.com/a?x=1&amp;y=2' target=\"_blank\"><b>Example</b> Title</a> for more</p>"},
			wantHref:  "https://example.com/a?x=1&y=2",
			wantLabel: "Example Title",
		},
		{
			name:     "html anchor labelled with its own url",
			entry:    ContentEntry{MIMEType: "text/html", Content: `<a href="https://example.com/a">https://example.com/a</a>`},
			wantHref: "https://example.com/a",
		},
		{
			name:  "html anchor with a non-http scheme",
			entry: ContentEntry{MIMEType: "text/html", Content: `<a href="mailto:someone@example.com">Mail</a>`},
		},
		{
			name:  "markdown image is not a link",
			entry: ContentEntry{MIMEType: "text/plain", Content: "![alt](https://example.com/pic.png)"},
		},
		{
			name:      "markdown image followed by a real link",
			entry:     ContentEntry{MIMEType: "text/plain", Content: "![alt](https://example.com/pic.png) [Example](https://example.com/a)"},
			wantHref:  "https://example.com/a",
			wantLabel: "Example",
		},
		{
			name:  "no link",
			entry: ContentEntry{MIMEType: "text/plain", Content: "just some prose about example.com"},
		},
		{
			name:  "prose that merely starts with a url",
			entry: ContentEntry{MIMEType: "text/plain", Content: "https://example.com/a is a good site"},
		},
		{
			name:  "empty",
			entry: ContentEntry{MIMEType: "text/plain", Content: "   "},
		},
		{
			name:     "image url is extracted; excluding it is the processor's call",
			entry:    ContentEntry{MIMEType: "text/plain", Content: "https://example.com/pic.png"},
			wantHref: "https://example.com/pic.png",
		},
		{
			name:  "typed sieve view is never text-scraped",
			entry: ContentEntry{MIMEType: "sieve/web-clip", Content: `{"source":"https://example.com/a","content":"[T](https://other.example/b)"}`},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.entry.Link()
			if got.Href != tc.wantHref {
				t.Errorf("href: got %q, want %q", got.Href, tc.wantHref)
			}
			if got.Label != tc.wantLabel {
				t.Errorf("label: got %q, want %q", got.Label, tc.wantLabel)
			}
			if got.IsZero() != (tc.wantHref == "") {
				t.Errorf("IsZero: got %v for href %q", got.IsZero(), got.Href)
			}
		})
	}
}

// The html view is the one that matters for a selected rendered link: the plain
// text view carries the label only, so href recovery must come from the anchor.
func TestContentEntry_Link_prefersHTMLAnchorOverLabelOnlyText(t *testing.T) {
	entries := []ContentEntry{
		{MIMEType: "text/plain", Content: "Example Title"},
		{MIMEType: "text/html", Content: `<a href="https://example.com/a">Example Title</a>`},
	}
	if l := entries[0].Link(); !l.IsZero() {
		t.Errorf("label-only text view must yield no link, got %+v", l)
	}
	l := entries[1].Link()
	if l.Href != "https://example.com/a" || l.Label != "Example Title" {
		t.Errorf("html view: got %+v", l)
	}
}
