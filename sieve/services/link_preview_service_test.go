package services

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFetchFull_OGTags(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(`<!DOCTYPE html><html><head>
<meta property="og:title" content="OG Title"/>
<meta property="og:description" content="OG Desc"/>
<meta property="og:image" content="https://example.com/img.jpg"/>
<meta property="og:site_name" content="Example Site"/>
<title>Page Title</title>
</head><body></body></html>`))
	}))
	defer srv.Close()

	s := NewLinkPreviewService()
	r := s.FetchFull(srv.URL)

	if r.Title != "OG Title" {
		t.Errorf("Title: got %q, want OG Title", r.Title)
	}
	if r.Description != "OG Desc" {
		t.Errorf("Description: got %q, want OG Desc", r.Description)
	}
	if r.OGImageURL != "https://example.com/img.jpg" {
		t.Errorf("OGImageURL: got %q, want https://example.com/img.jpg", r.OGImageURL)
	}
	if r.SiteName != "Example Site" {
		t.Errorf("SiteName: got %q, want Example Site", r.SiteName)
	}
}

func TestFetchFull_FallsBackToTitle(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(`<!DOCTYPE html><html><head>
<title>Fallback Title</title>
<meta name="description" content="Fallback Desc"/>
</head><body></body></html>`))
	}))
	defer srv.Close()

	s := NewLinkPreviewService()
	r := s.FetchFull(srv.URL)

	if r.Title != "Fallback Title" {
		t.Errorf("Title: got %q, want Fallback Title", r.Title)
	}
	if r.Description != "Fallback Desc" {
		t.Errorf("Description: got %q, want Fallback Desc", r.Description)
	}
	if r.OGImageURL != "" {
		t.Errorf("OGImageURL: got %q, want empty", r.OGImageURL)
	}
}

func TestFetchFull_TwitterFallback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(`<!DOCTYPE html><html><head>
<meta name="twitter:title" content="Twitter Title"/>
<meta name="twitter:description" content="Twitter Desc"/>
<meta name="twitter:image" content="https://example.com/tw.jpg"/>
</head><body></body></html>`))
	}))
	defer srv.Close()

	s := NewLinkPreviewService()
	r := s.FetchFull(srv.URL)

	if r.Title != "Twitter Title" {
		t.Errorf("Title: got %q, want Twitter Title", r.Title)
	}
	if r.OGImageURL != "https://example.com/tw.jpg" {
		t.Errorf("OGImageURL: got %q, want twitter image", r.OGImageURL)
	}
}

func TestFetchFull_RelativeImageResolved(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(`<!DOCTYPE html><html><head>
<meta property="og:image" content="/images/banner.jpg"/>
</head><body></body></html>`))
	}))
	defer srv.Close()

	s := NewLinkPreviewService()
	r := s.FetchFull(srv.URL)

	want := srv.URL + "/images/banner.jpg"
	if r.OGImageURL != want {
		t.Errorf("OGImageURL: got %q, want %q", r.OGImageURL, want)
	}
}

func TestFetchFull_HostnameFallbackForSiteName(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(`<!DOCTYPE html><html><head><title>T</title></head><body></body></html>`))
	}))
	defer srv.Close()

	s := NewLinkPreviewService()
	r := s.FetchFull(srv.URL)

	if r.SiteName == "" {
		t.Error("SiteName must fall back to hostname when og:site_name is absent")
	}
}

func TestFetchFull_GracefulOnNonOK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusForbidden)
	}))
	defer srv.Close()

	s := NewLinkPreviewService()
	r := s.FetchFull(srv.URL)

	// Must return zero-value result, not panic
	if r.Title != "" || r.Description != "" {
		t.Errorf("non-200 must return empty result; got title=%q desc=%q", r.Title, r.Description)
	}
}
