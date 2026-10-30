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

	readability "github.com/go-shiori/go-readability"
	"golang.org/x/net/html"
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

// FetchReadable retrieves targetURL within timeout, extracts its main article
// content via Readability, and renders that content as Markdown. Returns an
// error describing the failure reason on non-200 status, timeout, non-HTML
// content-type, or an empty/unreadable body.
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

	title := first(hm.bestTitle(), article.Title)
	renderer := markdownRenderer{baseURL: parsedURL}
	md := renderer.render(article.Node)
	if md == "" {
		md = strings.TrimSpace(article.TextContent)
	}
	if md == "" {
		return domain.ReadablePage{}, fmt.Errorf("empty body")
	}
	if title != "" && !strings.HasPrefix(md, "# ") {
		md = "# " + title + "\n\n" + md
	}
	return domain.ReadablePage{
		Title:    title,
		Markdown: md,
	}, nil
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

// markdownRenderer converts a Readability-extracted HTML subtree into clean
// Markdown, resolving relative links and images against baseURL and dropping
// non-content tags.
type markdownRenderer struct {
	baseURL *url.URL
}

func (r markdownRenderer) render(root *html.Node) string {
	if root == nil {
		return ""
	}
	var b strings.Builder
	r.writeNode(&b, root)
	return r.normalize(b.String())
}

func (r markdownRenderer) writeNode(b *strings.Builder, n *html.Node) {
	if n == nil {
		return
	}
	switch n.Type {
	case html.TextNode:
		b.WriteString(r.collapseInlineSpace(n.Data))
	case html.DocumentNode:
		r.writeChildren(b, n)
	case html.ElementNode:
		tag := strings.ToLower(n.Data)
		switch tag {
		case "script", "style", "noscript", "nav", "footer", "aside", "svg", "form", "button", "iframe":
			return
		case "h1", "h2", "h3", "h4", "h5", "h6":
			level := int(tag[1] - '0')
			if text := strings.TrimSpace(r.renderChildren(n)); text != "" {
				b.WriteString("\n\n")
				b.WriteString(strings.Repeat("#", level))
				b.WriteByte(' ')
				b.WriteString(text)
				b.WriteString("\n\n")
			}
		case "p":
			if text := strings.TrimSpace(r.renderChildren(n)); text != "" {
				b.WriteString("\n\n")
				b.WriteString(text)
				b.WriteString("\n\n")
			}
		case "br":
			b.WriteByte('\n')
		case "hr":
			b.WriteString("\n\n---\n\n")
		case "pre":
			if raw := strings.Trim(r.rawText(n), "\n"); raw != "" {
				b.WriteString("\n\n```\n")
				b.WriteString(raw)
				b.WriteString("\n```\n\n")
			}
		case "code":
			if text := strings.TrimSpace(r.rawText(n)); text != "" {
				b.WriteByte('`')
				b.WriteString(text)
				b.WriteByte('`')
			}
		case "strong", "b":
			if text := strings.TrimSpace(r.renderChildren(n)); text != "" {
				b.WriteString("**")
				b.WriteString(text)
				b.WriteString("**")
			}
		case "em", "i":
			if text := strings.TrimSpace(r.renderChildren(n)); text != "" {
				b.WriteByte('*')
				b.WriteString(text)
				b.WriteByte('*')
			}
		case "a":
			text := strings.TrimSpace(r.renderChildren(n))
			href := strings.TrimSpace(r.attr(n, "href"))
			if href != "" && !strings.HasPrefix(strings.ToLower(href), "javascript:") {
				if r.baseURL != nil {
					href = resolveURL(r.baseURL.String(), href)
				}
				if text == "" {
					text = href
				}
				b.WriteByte('[')
				b.WriteString(text)
				b.WriteString("](")
				b.WriteString(href)
				b.WriteByte(')')
			} else if text != "" {
				b.WriteString(text)
			}
		case "img":
			src := strings.TrimSpace(r.attr(n, "src"))
			if src != "" && !strings.HasPrefix(strings.ToLower(src), "data:") {
				if r.baseURL != nil {
					src = resolveURL(r.baseURL.String(), src)
				}
				alt := strings.TrimSpace(r.attr(n, "alt"))
				b.WriteString("![")
				b.WriteString(alt)
				b.WriteString("](")
				b.WriteString(src)
				b.WriteByte(')')
			}
		case "ul", "ol":
			b.WriteString("\n\n")
			idx := 1
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				if c.Type == html.ElementNode && strings.EqualFold(c.Data, "li") {
					item := strings.TrimSpace(r.renderChildren(c))
					if item != "" {
						if tag == "ol" {
							fmt.Fprintf(b, "%d. %s\n", idx, item)
							idx++
						} else {
							b.WriteString("- ")
							b.WriteString(item)
							b.WriteByte('\n')
						}
					}
				}
			}
			b.WriteByte('\n')
		case "blockquote":
			inner := r.normalize(r.renderChildren(n))
			if inner != "" {
				b.WriteString("\n\n")
				for _, line := range strings.Split(inner, "\n") {
					if strings.TrimSpace(line) == "" {
						b.WriteString(">\n")
					} else {
						b.WriteString("> ")
						b.WriteString(line)
						b.WriteByte('\n')
					}
				}
				b.WriteByte('\n')
			}
		default:
			r.writeChildren(b, n)
		}
	}
}

func (r markdownRenderer) writeChildren(b *strings.Builder, n *html.Node) {
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		r.writeNode(b, c)
	}
}

func (r markdownRenderer) renderChildren(n *html.Node) string {
	var b strings.Builder
	r.writeChildren(&b, n)
	return b.String()
}

func (r markdownRenderer) rawText(n *html.Node) string {
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(cur *html.Node) {
		if cur == nil {
			return
		}
		if cur.Type == html.TextNode {
			b.WriteString(cur.Data)
		}
		for c := cur.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return b.String()
}

func (r markdownRenderer) attr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if strings.EqualFold(a.Key, key) {
			return a.Val
		}
	}
	return ""
}

func (r markdownRenderer) collapseInlineSpace(s string) string {
	var b strings.Builder
	inSpace := false
	for _, ch := range s {
		if ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' {
			if !inSpace {
				b.WriteByte(' ')
				inSpace = true
			}
			continue
		}
		inSpace = false
		b.WriteRune(ch)
	}
	return b.String()
}

func (r markdownRenderer) normalize(s string) string {
	lines := strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n")
	var out []string
	blankCount := 0
	for _, line := range lines {
		trimmed := strings.TrimRight(line, " \t")
		if strings.TrimSpace(trimmed) == "" {
			blankCount++
			if blankCount <= 1 && len(out) > 0 {
				out = append(out, "")
			}
			continue
		}
		blankCount = 0
		out = append(out, trimmed)
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}

