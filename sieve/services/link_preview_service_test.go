package services

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sieve/sieve/domain"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// FetchTitle's deadline is the caller's: a paste blocking in front of the caret
// passes ~1s, a background job can be more patient. Every case here runs against a
// loopback httptest server — nothing reaches the network.
func TestFetchTitle(t *testing.T) {
	tests := []struct {
		name    string
		handler http.HandlerFunc
		timeout time.Duration
		want    string
	}{
		{
			name: "title element",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.Write([]byte(`<html><head><title>  Example Domain  </title></head><body/></html>`))
			},
			timeout: 2 * time.Second,
			want:    "Example Domain",
		},
		{
			name: "no title element",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.Write([]byte(`<html><head></head><body>no title here</body></html>`))
			},
			timeout: 2 * time.Second,
			want:    "",
		},
		{
			// The whole point of unifying on one scan: the paste label now gets
			// the publisher's curated title rather than the cluttered <title>.
			name: "og:title beats the raw title element",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.Write([]byte(`<html><head><title>Article | Section | Publisher</title>` +
					`<meta property="og:title" content="Article"></head><body/></html>`))
			},
			timeout: 2 * time.Second,
			want:    "Article",
		},
		{
			name: "twitter:title when there is no og:title",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.Write([]byte(`<html><head><title>Raw</title>` +
					`<meta name="twitter:title" content="Twitter"></head><body/></html>`))
			},
			timeout: 2 * time.Second,
			want:    "Twitter",
		},
		{
			// Malformed: head never closes, no <body>, stream just stops.
			name: "truncated document",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.Write([]byte(`<html><head><title>Truncated`))
			},
			timeout: 2 * time.Second,
			want:    "Truncated",
		},
		{
			name: "not html at all",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.Write([]byte("\x00\x01\x02 not markup >>> <<< &&&"))
			},
			timeout: 2 * time.Second,
			want:    "",
		},
		{
			name: "non-200",
			handler: func(w http.ResponseWriter, r *http.Request) {
				http.Error(w, "nope", http.StatusForbidden)
			},
			timeout: 2 * time.Second,
			want:    "",
		},
		{
			name: "slower than the deadline",
			handler: func(w http.ResponseWriter, r *http.Request) {
				time.Sleep(300 * time.Millisecond)
				w.Write([]byte(`<html><head><title>Too Late</title></head></html>`))
			},
			timeout: 20 * time.Millisecond,
			want:    "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := httptest.NewServer(tt.handler)
			defer srv.Close()

			start := time.Now()
			got := NewLinkPreviewService().FetchTitle(srv.URL, tt.timeout)

			if got != tt.want {
				t.Errorf("FetchTitle: got %q, want %q", got, tt.want)
			}
			if elapsed := time.Since(start); elapsed > tt.timeout+2*time.Second {
				t.Errorf("FetchTitle took %v — the caller's deadline was %v", elapsed, tt.timeout)
			}
		})
	}
}

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

// FetchTitle and FetchFull are two views over ONE scan, so they must never
// disagree about what a page's title is.
func TestFetchTitle_AndFetchFull_AgreeOnTitle(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		// og:title deliberately AFTER <title>: stopping the scan at </title>
		// would discard the better answer, which is why <body> is the stop.
		w.Write([]byte(`<!DOCTYPE html><html><head>
<title>Article | Section | Publisher</title>
<meta property="og:title" content="Article"/>
</head><body></body></html>`))
	}))
	defer srv.Close()

	s := NewLinkPreviewService()
	title := s.FetchTitle(srv.URL, 5*time.Second)
	full := s.FetchFull(srv.URL)

	if title != "Article" {
		t.Errorf("FetchTitle: got %q, want %q", title, "Article")
	}
	if full.Title != title {
		t.Errorf("the two views disagree: FetchFull %q vs FetchTitle %q", full.Title, title)
	}
}

// A page with no og:/twitter: metadata at all must still yield its <title>.
func TestFetchTitle_PlainTitleOnlyPage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`<!DOCTYPE html><html><head><title>Just A Title</title></head><body>x</body></html>`))
	}))
	defer srv.Close()

	s := NewLinkPreviewService()
	if got := s.FetchTitle(srv.URL, 5*time.Second); got != "Just A Title" {
		t.Errorf("FetchTitle: got %q, want %q", got, "Just A Title")
	}
	if got := s.FetchFull(srv.URL).Title; got != "Just A Title" {
		t.Errorf("FetchFull.Title: got %q, want %q", got, "Just A Title")
	}
}

// The scan must stop at the <body> start tag. The handler here emits the head and
// then stops writing entirely, holding the response open: a scan that waited for
// EOF (or even for the byte cap) would block until the deadline and return "".
// Returning promptly with the right title, having consumed exactly the bytes the
// handler produced, is only possible if <body> ended the read.
func TestFetchTitle_StopsAtBodyStartTag(t *testing.T) {
	const head = `<!DOCTYPE html><html><head>` +
		`<title>Raw Title</title>` +
		`<meta property="og:title" content="Head Title"/>` +
		`</head><body>`

	var written int64
	release := make(chan struct{})

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		n, _ := w.Write([]byte(head))
		atomic.AddInt64(&written, int64(n))
		w.(http.Flusher).Flush()
		<-release // the body never arrives
	}))
	defer srv.Close()    // runs second
	defer close(release) // runs first, so the handler can finish

	start := time.Now()
	got := NewLinkPreviewService().FetchTitle(srv.URL, 30*time.Second)
	elapsed := time.Since(start)
	sawBytes := atomic.LoadInt64(&written)

	if got != "Head Title" {
		t.Errorf("FetchTitle: got %q, want %q", got, "Head Title")
	}
	if elapsed > 5*time.Second {
		t.Errorf("scan did not stop at <body>: took %v with a 30s deadline and an unfinished body", elapsed)
	}
	if sawBytes != int64(len(head)) {
		t.Errorf("handler produced %d bytes, head is %d — the scan read past the head", sawBytes, len(head))
	}
}

// Same stop, measured the other way: an enormous body must not be pulled down to
// read a title that was already in hand.
func TestFetchTitle_DoesNotReadEnormousBody(t *testing.T) {
	const (
		head      = `<!DOCTYPE html><html><head><title>Cheap Title</title></head><body>`
		chunkSize = 64 << 10
		chunks    = 128 // 8 MiB of body
	)

	var written int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		n, _ := w.Write([]byte(head))
		atomic.AddInt64(&written, int64(n))
		w.(http.Flusher).Flush()

		chunk := bytes.Repeat([]byte("x"), chunkSize)
		for i := 0; i < chunks; i++ {
			select {
			case <-r.Context().Done():
				return
			default:
			}
			n, err := w.Write(chunk)
			atomic.AddInt64(&written, int64(n))
			if err != nil {
				return
			}
		}
	}))

	got := NewLinkPreviewService().FetchTitle(srv.URL, 30*time.Second)
	srv.Close() // blocks until the handler returns, so `written` is final

	if got != "Cheap Title" {
		t.Errorf("FetchTitle: got %q, want %q", got, "Cheap Title")
	}
	// Generous ceiling: socket and bufio buffers absorb some of the body after the
	// client stops reading. The point is that 8 MiB did not get pulled down.
	if limit := int64(2 << 20); atomic.LoadInt64(&written) > limit {
		t.Errorf("handler drained %d bytes (ceiling %d) — the body was being read", written, limit)
	}
}

// A page that never emits <body> and never ends must still terminate, on the byte
// cap. The handler writes past the cap and then holds the response open forever:
// only maxHeadBytes can end this read.
func TestFetchTitle_ByteCapTerminatesEndlessHead(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte(`<html><head><title>Capped</title>`))
		padding := strings.Repeat("<span></span>", (maxHeadBytes+(8<<10))/len("<span></span>"))
		w.Write([]byte(padding))
		w.(http.Flusher).Flush()
		<-release
	}))
	defer srv.Close()
	defer close(release)

	start := time.Now()
	got := NewLinkPreviewService().FetchTitle(srv.URL, 30*time.Second)
	elapsed := time.Since(start)

	if got != "Capped" {
		t.Errorf("FetchTitle: got %q, want %q", got, "Capped")
	}
	if elapsed > 5*time.Second {
		t.Errorf("byte cap did not bound the read: took %v on a never-ending head", elapsed)
	}
}

// newRedirectServer serves /hop/N as a chain of N redirects ending at /page.
func newRedirectServer() *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/page" {
			w.Write([]byte(`<html><head><title>Arrived</title></head><body></body></html>`))
			return
		}
		hops, err := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/hop/"))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		if hops <= 1 {
			http.Redirect(w, r, "/page", http.StatusFound)
			return
		}
		http.Redirect(w, r, fmt.Sprintf("/hop/%d", hops-1), http.StatusFound)
	}))
}

// Shortened and tracking links spend a round-trip per hop. Up to the cap we
// follow; past it the fetch fails and the callers use their own fallback.
func TestFetch_RedirectCap(t *testing.T) {
	srv := newRedirectServer()
	defer srv.Close()

	s := NewLinkPreviewService()

	t.Run("chain within the cap succeeds", func(t *testing.T) {
		url := fmt.Sprintf("%s/hop/%d", srv.URL, maxLinkRedirects)
		if got := s.FetchTitle(url, 10*time.Second); got != "Arrived" {
			t.Errorf("FetchTitle: got %q, want %q", got, "Arrived")
		}
		if got := s.FetchFull(url).Title; got != "Arrived" {
			t.Errorf("FetchFull.Title: got %q, want %q", got, "Arrived")
		}
	})

	t.Run("chain past the cap fails", func(t *testing.T) {
		url := fmt.Sprintf("%s/hop/%d", srv.URL, maxLinkRedirects+1)
		if got := s.FetchTitle(url, 10*time.Second); got != "" {
			t.Errorf("FetchTitle must give up past %d redirects; got %q", maxLinkRedirects, got)
		}
		if got := s.FetchFull(url); got != (domain.LinkPreviewResult{}) {
			t.Errorf("FetchFull must return a zero result past %d redirects; got %+v", maxLinkRedirects, got)
		}
	})
}
