package services

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sieve/sieve/domain"
	"strings"
	"time"

	readability "codeberg.org/readeck/go-readability/v2"
	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

const (
	// maxHeadBytes caps how much of a response the head scan will ever read. The
	// scan normally stops itself at the <body> start tag; this is the backstop for
	// the page that never emits one — malformed, hostile, or an endless stream —
	// which would otherwise read until the caller's deadline expired.
	maxHeadBytes = 256 << 10 // 256 KiB

	// maxReadableBytes caps the response body read for full-page Readability
	// extraction so an unbounded stream cannot exhaust memory.
	maxReadableBytes = 8 << 20 // 8 MiB

	// maxLinkRedirects caps the redirect chain. Shortened and tracking links
	// (t.co, newsletter wrappers, doi.org) spend a full round-trip per hop and can
	// eat a whole paste budget without ever reaching a page; past three hops the
	// URL-as-label fallback is the better trade. Exceeding it is a failed fetch.
	maxLinkRedirects = 3

	// linkPreviewUserAgent is what we present to the sites we scrape. Some serve a
	// stripped page (or nothing) to an unrecognised agent, and the OG tags we want
	// are exactly what they withhold.
	linkPreviewUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

	// fullPreviewTimeout is FetchFull's deadline. Its caller is a background job,
	// so it can afford to wait out a slow site in a way a paste cannot.
	fullPreviewTimeout = 8 * time.Second
)

// LinkPreviewService fetches metadata and readable content for URLs.
type LinkPreviewService struct{}

func NewLinkPreviewService() *LinkPreviewService {
	return &LinkPreviewService{}
}

// FetchReadable retrieves targetURL within timeout and extracts its main article
// content via Readability, returned as a complete HTML document (see
// domain.ReadablePage). A page Readability strips to no text falls back to its
// <body>, less scripts and styles. Returns an error describing the failure
// reason on non-200 status, timeout, non-HTML content-type, binary content, or
// an empty/unreadable body.
func (s *LinkPreviewService) FetchReadable(targetURL string, timeout time.Duration) (domain.ReadablePage, error) {
	if timeout <= 0 {
		timeout = fullPreviewTimeout
	}
	parsedURL, err := url.ParseRequestURI(strings.TrimSpace(targetURL))
	if err != nil || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") {
		return domain.ReadablePage{}, fmt.Errorf("invalid URL %q", targetURL)
	}

	req, err := http.NewRequest(http.MethodGet, parsedURL.String(), nil)
	if err != nil {
		return domain.ReadablePage{}, fmt.Errorf("invalid request: %w", err)
	}
	req.Header.Set("User-Agent", linkPreviewUserAgent)

	resp, err := s.httpClient(timeout).Do(req)
	if err != nil {
		var netErr net.Error
		if (errors.As(err, &netErr) && netErr.Timeout()) || errors.Is(err, context.DeadlineExceeded) {
			return domain.ReadablePage{}, fmt.Errorf("timeout after %s", timeout)
		}
		return domain.ReadablePage{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return domain.ReadablePage{}, fmt.Errorf("status %d %s", resp.StatusCode, http.StatusText(resp.StatusCode))
	}

	ct := strings.ToLower(strings.TrimSpace(resp.Header.Get("Content-Type")))
	if ct != "" && !strings.Contains(ct, "text/html") && !strings.Contains(ct, "application/xhtml+xml") {
		return domain.ReadablePage{}, fmt.Errorf("non-HTML content-type %q", resp.Header.Get("Content-Type"))
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxReadableBytes))
	if err != nil {
		var netErr net.Error
		if (errors.As(err, &netErr) && netErr.Timeout()) || errors.Is(err, context.DeadlineExceeded) {
			return domain.ReadablePage{}, fmt.Errorf("timeout reading body")
		}
		return domain.ReadablePage{}, fmt.Errorf("read body: %w", err)
	}
	if bytes.Contains(body, []byte{0}) {
		return domain.ReadablePage{}, fmt.Errorf("non-HTML binary content")
	}
	if len(bytes.TrimSpace(body)) == 0 {
		return domain.ReadablePage{}, fmt.Errorf("empty body")
	}

	var hm headMeta
	hm.scan(bytes.NewReader(body))

	article, err := readability.FromReader(bytes.NewReader(body), parsedURL)
	if err != nil {
		return domain.ReadablePage{}, fmt.Errorf("empty or unreadable HTML: %w", err)
	}

	var text, content strings.Builder
	if article.RenderText(&text) != nil || strings.TrimSpace(text.String()) == "" ||
		article.RenderHTML(&content) != nil {
		content.Reset()
		content.WriteString(s.bodyHTML(body))
	}
	if content.Len() == 0 {
		return domain.ReadablePage{}, fmt.Errorf("empty body")
	}
	title := first(article.Title(), hm.bestTitle())
	return domain.ReadablePage{
		Title: title,
		HTML: `<!doctype html><html><head><meta charset="utf-8"><title>` + html.EscapeString(title) +
			`</title></head><body>` + content.String() + `</body></html>`,
	}, nil
}

// bodyHTML renders the children of page's <body> with script, style, noscript
// and template elements removed, or returns empty when that leaves no text.
func (s *LinkPreviewService) bodyHTML(page []byte) string {
	doc, err := html.Parse(bytes.NewReader(page))
	if err != nil {
		return ""
	}
	var body *html.Node
	var dropped []*html.Node
	for n := range doc.Descendants() {
		switch {
		case n.Type == html.ElementNode && n.DataAtom == atom.Body && body == nil:
			body = n
		case n.Type == html.ElementNode && (n.DataAtom == atom.Script || n.DataAtom == atom.Style ||
			n.DataAtom == atom.Noscript || n.DataAtom == atom.Template):
			dropped = append(dropped, n)
		}
	}
	if body == nil {
		return ""
	}
	for _, n := range dropped {
		if n.Parent != nil {
			n.Parent.RemoveChild(n)
		}
	}
	if strings.TrimSpace(s.textOf(body)) == "" {
		return ""
	}
	var b strings.Builder
	for c := range body.ChildNodes() {
		if err := html.Render(&b, c); err != nil {
			return ""
		}
	}
	return b.String()
}

// textOf concatenates the text nodes beneath n.
func (s *LinkPreviewService) textOf(n *html.Node) string {
	var b strings.Builder
	for d := range n.Descendants() {
		if d.Type == html.TextNode {
			b.WriteString(d.Data)
		}
	}
	return b.String()
}

// FetchTitle returns the best available title for targetURL, giving up after
// timeout. "Best" is the same priority the full preview uses — og:title, then
// twitter:title, then the raw <title> — because a publisher's og:title is the
// curated one and the <title> is routinely cluttered ("Article | Section | Site").
// The deadline is the caller's because the callers differ in kind: a background
// job may wait out a slow site, a paste blocking in front of the caret may not.
//
// Returns empty string on timeout, any error, a non-200, or a page with no title
// at all. Callers depend on empty to mean "no answer" and fall back to using the
// URL itself as the display label — so this deliberately does NOT inherit
// FetchFull's URL fallback.
func (s *LinkPreviewService) FetchTitle(targetURL string, timeout time.Duration) string {
	meta, ok := s.scanHead(targetURL, timeout)
	if !ok {
		return ""
	}
	return meta.bestTitle()
}

// FetchFull returns Open Graph metadata for targetURL.
// Priority: og:* > twitter:* > <title>/<meta name="description"> > hostname fallback.
// Returns a zero-value result on any fetch or parse failure.
func (s *LinkPreviewService) FetchFull(targetURL string) domain.LinkPreviewResult {
	meta, ok := s.scanHead(targetURL, fullPreviewTimeout)
	if !ok {
		return domain.LinkPreviewResult{}
	}

	result := domain.LinkPreviewResult{
		// Sharing bestTitle with FetchTitle is what keeps the paste label and the
		// smart-card headline agreeing on the same page by construction.
		Title:       first(meta.bestTitle(), targetURL),
		Description: first(meta.ogDesc, meta.twDesc, meta.metaDesc),
		SiteName:    first(meta.ogSite, hostOnly(targetURL)),
	}
	if rawImage := first(meta.ogImage, meta.twImage); rawImage != "" {
		result.OGImageURL = resolveURL(targetURL, rawImage)
	}
	return result
}

func (s *LinkPreviewService) httpClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		},
		Timeout: timeout,
		CheckRedirect: func(_ *http.Request, via []*http.Request) error {
			if len(via) > maxLinkRedirects {
				return fmt.Errorf("stopped after %d redirects", maxLinkRedirects)
			}
			return nil
		},
	}
}

// scanHead is the one fetch-and-parse path behind both public methods; FetchTitle
// and FetchFull are two views over its result, not two fetchers. It streams the
// response through a tokeniser and stops at <body>, so a title costs a few KiB
// rather than a whole page — which is what makes the fetch survivable inside a
// paste's three-second budget. Reports false for any failure to reach a readable
// 200; both callers degrade to their own fallback rather than surfacing an error.
func (s *LinkPreviewService) scanHead(targetURL string, timeout time.Duration) (headMeta, bool) {
	req, err := http.NewRequest(http.MethodGet, targetURL, nil)
	if err != nil {
		return headMeta{}, false
	}
	req.Header.Set("User-Agent", linkPreviewUserAgent)

	resp, err := s.httpClient(timeout).Do(req)
	if err != nil {
		// On a CheckRedirect refusal Do returns a response too, with its body
		// already closed — there is nothing here to release.
		return headMeta{}, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return headMeta{}, false
	}

	var meta headMeta
	meta.scan(io.LimitReader(resp.Body, maxHeadBytes))
	return meta, true
}

// headMeta is everything the two views need, collected in one pass over a page's
// <head>. Fields are raw as the page gave them; the priority between them is the
// readers' business.
type headMeta struct {
	ogTitle, ogDesc, ogImage, ogSite string
	twTitle, twDesc, twImage         string
	pageTitle, metaDesc              string
}

// scan fills m from an HTML stream, stopping at the <body> start tag.
//
// <body> is the stop rather than </title> because og:title routinely appears
// AFTER <title> in the head, and stopping at the latter would throw away the
// better answer. Everything we collect lives in the head, so the body's first
// tag is the definitive "nothing more worth reading" marker.
func (m *headMeta) scan(r io.Reader) {
	z := html.NewTokenizer(r)
	for {
		switch z.Next() {
		case html.ErrorToken:
			return // EOF, the byte cap, or a read error — we keep what we have
		case html.StartTagToken, html.SelfClosingTagToken:
			name, hasAttr := z.TagName()
			switch string(name) {
			case "body":
				return
			case "title":
				m.readTitle(z)
			case "meta":
				if hasAttr {
					m.readMeta(z)
				}
			}
		}
	}
}

// readTitle takes the text of a <title> the tokeniser has just opened. The first
// one wins: a later <title> (inside an inline SVG, say) is not the page's.
func (m *headMeta) readTitle(z *html.Tokenizer) {
	if z.Next() == html.TextToken && m.pageTitle == "" {
		m.pageTitle = strings.TrimSpace(string(z.Text()))
	}
}

// readMeta consumes the attributes of a <meta> the tokeniser has just opened and
// records the ones we care about. Later tags win, matching the whole-tree walk
// this replaced.
func (m *headMeta) readMeta(z *html.Tokenizer) {
	var property, name, content string
	for {
		key, val, more := z.TagAttr()
		switch string(key) { // TagAttr lower-cases keys and unescapes values
		case "property":
			property = string(val)
		case "name":
			name = string(val)
		case "content":
			content = string(val)
		}
		if !more {
			break
		}
	}

	switch property {
	case "og:title":
		m.ogTitle = content
	case "og:description":
		m.ogDesc = content
	case "og:image":
		m.ogImage = content
	case "og:site_name":
		m.ogSite = content
	}
	switch name {
	case "twitter:title":
		m.twTitle = content
	case "twitter:description":
		m.twDesc = content
	case "twitter:image":
		m.twImage = content
	case "description":
		m.metaDesc = content
	}
}

// bestTitle is the page's title under the documented priority, or empty when the
// page offered none. It has no URL fallback — that is a per-caller decision.
func (m headMeta) bestTitle() string {
	return first(m.ogTitle, m.twTitle, m.pageTitle)
}

func first(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func hostOnly(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" {
		return ""
	}
	return u.Hostname()
}

func resolveURL(base, ref string) string {
	b, err := url.Parse(base)
	if err != nil {
		return ref
	}
	r, err := url.Parse(ref)
	if err != nil {
		return ref
	}
	return b.ResolveReference(r).String()
}
