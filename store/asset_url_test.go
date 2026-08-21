package store_test

import (
	"strings"
	"testing"

	"sieve/store"
)

// A real minted-shape uuid: RewriteLegacyAssetURLs only rewrites a route whose
// segment passes ident.Valid, so every fixture route must carry one.
const testAssetUUID = "0197b1f4-2c3d-7a8b-9c0d-1e2f3a4b5c6d"

func TestAssetURL_BuildsTheServedRoute(t *testing.T) {
	if got, want := store.AssetURL(testAssetUUID, "im-1.png"), "/ui/assets/"+testAssetUUID+"/im-1.png"; got != want {
		t.Errorf("AssetURL = %q, want %q", got, want)
	}
}

func TestContainsAssetURL_RecognisesCurrentAndLegacyRoutes(t *testing.T) {
	cases := []struct {
		name string
		s    string
		want bool
	}{
		{"current route", "/ui/assets/" + testAssetUUID + "/im.png", true},
		{"legacy route", "/sieve/" + testAssetUUID + "/im.png", true},
		{"neither", "https://example.com/im.png", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := store.ContainsAssetURL(c.s); got != c.want {
				t.Errorf("ContainsAssetURL(%q) = %v, want %v", c.s, got, c.want)
			}
		})
	}
}

func TestRewriteLegacyAssetURLs_RewritesRoute(t *testing.T) {
	in := "/sieve/" + testAssetUUID + "/im-1.png"
	want := "/ui/assets/" + testAssetUUID + "/im-1.png"
	if got := store.RewriteLegacyAssetURLs(in); got != want {
		t.Errorf("RewriteLegacyAssetURLs(%q) = %q, want %q", in, got, want)
	}
}

func TestRewriteLegacyAssetURLs_CurrentRouteIsUnchanged(t *testing.T) {
	in := "/ui/assets/" + testAssetUUID + "/im-1.png"
	if got := store.RewriteLegacyAssetURLs(in); got != in {
		t.Errorf("RewriteLegacyAssetURLs(%q) = %q, want unchanged", in, got)
	}
}

// A Go import path contains "/sieve/" — this project's own packages are
// literally sieve/sieve/…. Rewriting it would corrupt the user's source, and
// the migrator flushes synchronously, so the corruption reaches disk.
func TestRewriteLegacyAssetURLs_LeavesGoImportPathsAlone(t *testing.T) {
	src := "package x\n\nimport (\n\t\"sieve/sieve/block\"\n\t\"sieve/sieve/editor\"\n)\n"
	if got := store.RewriteLegacyAssetURLs(src); got != src {
		t.Errorf("import paths rewritten:\n got %q\nwant %q", got, src)
	}
}

// Prose quoting a repo URL: ".../stephen/sieve/issues/19" carries the legacy
// prefix but is not a route.
func TestRewriteLegacyAssetURLs_LeavesRepoURLsAlone(t *testing.T) {
	content := "tracked at https://git.stephenquinn.ie/stephen/sieve/issues/19 — see the thread"
	if got := store.RewriteLegacyAssetURLs(content); got != content {
		t.Errorf("content rewritten:\n got %q\nwant %q", got, content)
	}
}

// A filesystem path pasted into prose or a code block: any absolute path under
// the checkout contains the legacy prefix twice over.
func TestRewriteLegacyAssetURLs_LeavesFilesystemPathsAlone(t *testing.T) {
	content := "open /home/stephen/Development/projects/sieve/sieve/editor/x.go"
	if got := store.RewriteLegacyAssetURLs(content); got != content {
		t.Errorf("content rewritten:\n got %q\nwant %q", got, content)
	}
}

// The positive case in the same shape as the negatives: a true route embedded
// in a paragraph that ALSO carries a non-route "/sieve/" is rewritten, and only
// the route moves.
func TestRewriteLegacyAssetURLs_RewritesOnlyTheRouteInMixedProse(t *testing.T) {
	content := "from sieve/sieve/block, see ![shot](/sieve/" + testAssetUUID +
		"/img.png) and https://git.stephenquinn.ie/stephen/sieve/issues/19"
	got := store.RewriteLegacyAssetURLs(content)
	if !strings.Contains(got, "![shot](/ui/assets/"+testAssetUUID+"/img.png)") {
		t.Errorf("route not rewritten: %q", got)
	}
	if !strings.Contains(got, "from sieve/sieve/block, ") {
		t.Errorf("import path disturbed: %q", got)
	}
	if !strings.Contains(got, "https://git.stephenquinn.ie/stephen/sieve/issues/19") {
		t.Errorf("repo URL disturbed: %q", got)
	}
}
