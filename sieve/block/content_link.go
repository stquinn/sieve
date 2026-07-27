package block

import (
	"html"
	"regexp"
	"strings"
)

// Link is a hyperlink recovered from ONE clipboard/selection view: the href plus
// the human label that travelled with it (a markdown link's text, an <a>'s inner
// text). Label is empty when the source carried only a bare URL, or when the label
// is just the URL again — so a caller can seed a title attr from it unconditionally.
type Link struct {
	Href  string
	Label string
}

// IsZero reports that the view carried no link.
func (l Link) IsZero() bool { return l.Href == "" }

var (
	// [label](https://…) — the form a WYSIWYG link serialises to in text/plain.
	markdownLinkRe = regexp.MustCompile(`\[([^\]]*)\]\((https?://[^\s)]+)\)`)
	// <https://…> — the markdown autolink form.
	autolinkRe = regexp.MustCompile(`^<(https?://[^\s>]+)>$`)
	// <a href="…">label</a> — the ONLY view that still carries the href when the
	// user selects a rendered link (text/plain is then just the label).
	htmlAnchorRe = regexp.MustCompile(`(?is)<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>(.*?)</a>`)
	htmlTagRe    = regexp.MustCompile(`(?s)<[^>]*>`)
)

// Link extracts the hyperlink this view carries, or the zero Link. It recognises,
// in order: an <a href> in a text/html view (the important one — selecting a
// rendered link yields plain text with no URL in it at all, the href survives only
// in the HTML view), a markdown link, a markdown autolink, and a bare URL.
//
// It is deliberately mechanical: it answers "what link is in here", not "is this
// link something my kind wants". Kind policy (e.g. smart-image owns image URLs, so
// card/clip decline them) stays with the processor.
func (e ContentEntry) Link() Link {
	if strings.HasPrefix(e.MIMEType, "sieve/") {
		return Link{} // typed block views are read via SieveAttrs, never text-scraped
	}
	if e.MIMEType == "text/html" {
		if l := e.htmlAnchorLink(); !l.IsZero() {
			return l
		}
	}
	return e.textLink()
}

// htmlAnchorLink reads the first <a href> out of an HTML view, using the anchor's
// inner text as the label.
func (e ContentEntry) htmlAnchorLink() Link {
	m := htmlAnchorRe.FindStringSubmatch(e.Content)
	if m == nil {
		return Link{}
	}
	href := m[1]
	if href == "" {
		href = m[2] // single-quoted form
	}
	href = html.UnescapeString(strings.TrimSpace(href))
	if !e.isHTTPURL(href) {
		return Link{}
	}
	return Link{Href: href, Label: e.plainText(m[3], href)}
}

// textLink reads a markdown link, autolink, or bare URL out of a plain-text view.
func (e ContentEntry) textLink() Link {
	trimmed := strings.TrimSpace(e.Content)
	if trimmed == "" {
		return Link{}
	}
	for _, m := range markdownLinkRe.FindAllStringSubmatchIndex(trimmed, -1) {
		if m[0] > 0 && trimmed[m[0]-1] == '!' {
			continue // ![alt](url) is an image, not a link
		}
		href := strings.TrimSpace(trimmed[m[4]:m[5]])
		if e.isHTTPURL(href) {
			return Link{Href: href, Label: e.plainText(trimmed[m[2]:m[3]], href)}
		}
	}
	if m := autolinkRe.FindStringSubmatch(trimmed); m != nil && e.isHTTPURL(m[1]) {
		return Link{Href: m[1]}
	}
	if e.isHTTPURL(trimmed) {
		return Link{Href: trimmed} // the whole view IS the URL
	}
	return Link{}
}

// isHTTPURL reports a single http(s) token — no embedded whitespace, so a
// paragraph that merely starts with a URL is not mistaken for one.
func (e ContentEntry) isHTTPURL(s string) bool {
	if strings.ContainsAny(s, " \t\n\r") {
		return false
	}
	return strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://")
}

// plainText renders a label fragment as flat text: tags stripped, entities
// unescaped, whitespace collapsed. Returns "" when the label is just the href
// again, so callers can seed a title attr from it without echoing the URL.
func (e ContentEntry) plainText(fragment, href string) string {
	label := html.UnescapeString(htmlTagRe.ReplaceAllString(fragment, ""))
	label = strings.Join(strings.Fields(label), " ") // trim + collapse
	if label == href {
		return ""
	}
	return label
}
