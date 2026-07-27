package block

import (
	"html"
	"strings"
	"time"
)

// linkTitleDeadline bounds the ONE blocking network call a paste is allowed to make.
// A paste is a synchronous round-trip in front of the user's caret, so this is a
// trade between stalling the caret and the smart firing at all: at one second the
// URL-as-label fallback was the COMMON path (TLS handshake plus first byte routinely
// exceeds it, and shortened/tracking links spend a whole round-trip per redirect),
// which is complexity that rarely pays. Three seconds is still well under the point
// where a paste reads as the editor having hung, and clears a normal site with room
// to spare. Tuning the paste's patience is this one line.
const linkTitleDeadline = 3 * time.Second

// LinkPaste is the paste flavour for views that no block kind claims but which are,
// in themselves, exactly one hyperlink. It composes an ordinary anchor for the
// frontend to insert at the caret.
//
// This is #67's decision made concrete: a link keeps its one genuinely useful smart
// — the title — without being a Sieve block. The richer forms (smart-card, web-clip)
// are reached by an explicit Transform, never by paste.
type LinkPaste struct {
	preview LinkPreviewPort // nil is legal: no title fetch, the URL labels itself
}

// NewLinkPaste builds the flavour over a link-preview port. A nil port is accepted
// and degrades to the URL-as-label path rather than failing the paste.
func NewLinkPaste(preview LinkPreviewPort) LinkPaste { return LinkPaste{preview: preview} }

// Result returns the content outcome when these views are one link, else nothing.
func (p LinkPaste) Result(entries []ContentEntry) PasteResult {
	l := p.soleLink(entries)
	if l.IsZero() || !p.isHTTP(l.Href) {
		return PasteNothing()
	}
	return PasteContent(p.anchor(l.Href, p.label(l)))
}

// soleLink returns the link these views carry when the paste is *nothing but* that
// link, or the zero Link. The whole-view test is the point: a paragraph that merely
// CONTAINS a link is ordinary prose and must replay verbatim at the caret rather
// than collapse into an anchor.
func (p LinkPaste) soleLink(entries []ContentEntry) Link {
	var found Link
	for _, e := range entries {
		l := e.Link()
		if l.IsZero() {
			continue // this view carries no link (a bare label, a typed view) — ignore it
		}
		if !p.isWholeView(e, l) {
			return Link{} // the link is embedded in other content: not a link paste
		}
		switch {
		case found.IsZero():
			found = l
		case found.Href != l.Href:
			return Link{} // the views disagree: more than one link is in play
		case found.Label == "":
			found = l // a later view carried the label an earlier one lacked
		}
	}
	return found
}

// isWholeView reports that the view is the link and nothing else. Comparison is
// against flattened text because an HTML view arrives wrapped in browser scaffolding
// (<meta>, <!--StartFragment-->) that carries no content of its own.
func (p LinkPaste) isWholeView(e ContentEntry, l Link) bool {
	text := p.flatten(e)
	switch text {
	case l.Href, // bare URL
		"<" + l.Href + ">",                  // autolink
		"[" + l.Label + "](" + l.Href + ")", // markdown link (Label is "" when it echoed the href)
		"[" + l.Href + "](" + l.Href + ")":  // markdown link whose text IS the URL
		return true
	}
	return l.Label != "" && text == l.Label // a rendered anchor: the HTML view flattens to its text
}

// flatten renders a view as comparable text: tags stripped and entities unescaped
// for an HTML view (a plain-text view is left alone — <https://…> is an autolink,
// not markup), whitespace collapsed either way.
func (p LinkPaste) flatten(e ContentEntry) string {
	s := e.Content
	if e.MIMEType == "text/html" {
		s = html.UnescapeString(htmlTagRe.ReplaceAllString(s, ""))
	}
	return strings.Join(strings.Fields(s), " ")
}

// label picks the anchor's text: the label the clipboard already carried (the user
// copied that text — no reason to go to the network for it), else the page <title>
// fetched under linkTitleDeadline, else the URL itself. Never empty — a paste must
// never produce an unlabelled link.
func (p LinkPaste) label(l Link) string {
	if l.Label != "" {
		return l.Label
	}
	if p.preview != nil {
		if title := strings.TrimSpace(p.preview.FetchTitle(l.Href, linkTitleDeadline)); title != "" {
			return title
		}
	}
	return l.Href
}

// anchor composes the fragment. Both parts are escaped: a page <title> is untrusted
// remote input and this HTML is inserted into the user's document.
func (p LinkPaste) anchor(href, label string) string {
	return `<a href="` + html.EscapeString(href) + `">` + html.EscapeString(label) + `</a>`
}

// isHTTP gates the composer to the two schemes a document link may carry. Link()
// already refuses the rest; this is the second lock on the door that writes an
// href into the document.
func (p LinkPaste) isHTTP(href string) bool {
	return strings.HasPrefix(href, "http://") || strings.HasPrefix(href, "https://")
}
