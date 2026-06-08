package sieve

import (
	"crypto/tls"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/net/html"
)

// LinkPreviewService fetches metadata for URLs.
// Phase 2 will add FetchFull for Open Graph metadata and image download.
type LinkPreviewService struct{}

func NewLinkPreviewService() *LinkPreviewService {
	return &LinkPreviewService{}
}

// FetchTitle returns the HTML <title> of targetURL.
// Returns empty string on any error or non-200 response — callers fall back
// to using the URL itself as the display label.
func (s *LinkPreviewService) FetchTitle(targetURL string) string {
	client := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		},
		Timeout: 10 * time.Second,
	}
	req, err := http.NewRequest(http.MethodGet, targetURL, nil)
	if err != nil {
		return ""
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
	resp, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	doc, err := html.Parse(resp.Body)
	if err != nil {
		return ""
	}
	var title string
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if title != "" {
			return
		}
		if n.Type == html.ElementNode && n.Data == "title" && n.FirstChild != nil {
			title = n.FirstChild.Data
			return
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	return strings.TrimSpace(title)
}

// LinkPreviewResult holds Open Graph metadata fetched from a URL.
// OGImageURL is the raw OG image URL — callers are responsible for downloading
// and storing it via AssetService. Empty string means no image was found.
type LinkPreviewResult struct {
	Title       string
	Description string
	OGImageURL  string
	SiteName    string
}

// FetchFull returns Open Graph metadata for targetURL.
// Priority: og:* > twitter:* > <title>/<meta name="description"> > hostname fallback.
// Returns a zero-value result on any fetch or parse failure.
func (s *LinkPreviewService) FetchFull(targetURL string) LinkPreviewResult {
	client := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		},
		Timeout: 8 * time.Second,
	}
	req, err := http.NewRequest(http.MethodGet, targetURL, nil)
	if err != nil {
		return LinkPreviewResult{}
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
	resp, err := client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		return LinkPreviewResult{}
	}
	defer resp.Body.Close()

	doc, err := html.Parse(resp.Body)
	if err != nil {
		return LinkPreviewResult{}
	}

	var (
		ogTitle, ogDesc, ogImage, ogSite string
		twTitle, twDesc, twImage         string
		pageTitle, metaDesc              string
	)

	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			switch n.Data {
			case "title":
				if n.FirstChild != nil && pageTitle == "" {
					pageTitle = strings.TrimSpace(n.FirstChild.Data)
				}
			case "meta":
				prop, name, content := attrVal(n, "property"), attrVal(n, "name"), attrVal(n, "content")
				switch prop {
				case "og:title":
					ogTitle = content
				case "og:description":
					ogDesc = content
				case "og:image":
					ogImage = content
				case "og:site_name":
					ogSite = content
				}
				switch name {
				case "twitter:title":
					twTitle = content
				case "twitter:description":
					twDesc = content
				case "twitter:image":
					twImage = content
				case "description":
					metaDesc = content
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)

	result := LinkPreviewResult{}
	result.Title = first(ogTitle, twTitle, pageTitle, targetURL)
	result.Description = first(ogDesc, twDesc, metaDesc)
	result.SiteName = first(ogSite, hostOnly(targetURL))

	rawImage := first(ogImage, twImage)
	if rawImage != "" {
		result.OGImageURL = resolveURL(targetURL, rawImage)
	}

	return result
}

func attrVal(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
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
