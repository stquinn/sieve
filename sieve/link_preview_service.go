package sieve

import (
	"crypto/tls"
	"net/http"
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
