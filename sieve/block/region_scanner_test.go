package block

import (
	"strings"
	"testing"
)

func TestRegionScanner_TilesSourceExactly(t *testing.T) {
	md := "intro text\n\n```code\nid: co-1\nsource: x\n```\n\ntrailing\n"
	shapes := []RegionShape{{Kind: "code", Head: "```code", Tail: "```"}}
	regions := NewRegionScanner(shapes).Scan(md)

	var sum string
	for _, r := range regions {
		sum += r.Raw
	}
	if sum != md {
		t.Fatalf("regions must tile source exactly.\n got: %q\nwant: %q", sum, md)
	}
}

func TestRegionScanner_SplitsFenceAndText(t *testing.T) {
	md := "before\n\n```code\nid: co-1\n```\n\nafter\n"
	shapes := []RegionShape{{Kind: "code", Head: "```code", Tail: "```"}}
	regions := NewRegionScanner(shapes).Scan(md)
	if len(regions) != 3 {
		t.Fatalf("want 3 regions (text, fence, text), got %d: %#v", len(regions), regions)
	}
	if regions[1].Kind != "code" {
		t.Errorf("fence region Kind = %q, want code", regions[1].Kind)
	}
	// In the shape-driven scanner, Body == Raw for shape regions (verbatim span).
	wantRaw := "```code\nid: co-1\n```\n"
	if regions[1].Raw != wantRaw {
		t.Errorf("fence region Raw = %q, want %q", regions[1].Raw, wantRaw)
	}
	if regions[1].Body != regions[1].Raw {
		t.Errorf("fence region Body must equal Raw: Body=%q Raw=%q", regions[1].Body, regions[1].Raw)
	}
	if regions[0].Kind != "" || regions[2].Kind != "" {
		t.Errorf("text regions must have empty Kind: %q %q", regions[0].Kind, regions[2].Kind)
	}
}

func TestRegionScanner_PlainLanguageFenceIsAFenceRegion(t *testing.T) {
	// A registered fence shape is emitted as a fence region.
	// Dispatch — not the scanner — decides nobody claims it.
	md := "```python\nprint(1)\n```\n"
	shapes := []RegionShape{{Kind: "python", Head: "```python", Tail: "```"}}
	regions := NewRegionScanner(shapes).Scan(md)
	if len(regions) != 1 || regions[0].Kind != "python" {
		t.Fatalf("want one python fence region, got %#v", regions)
	}
}

func TestRegionScanner_UnregisteredFenceStaysInText(t *testing.T) {
	// A fence whose kind is NOT in the shapes slice is never emitted as a
	// shape region — it surfaces as gap text for prose mop-up. This is the
	// primary mechanism that lets "```python" survive verbatim inside prose.
	md := "```java\nclass X {}\n```\n"
	shapes := []RegionShape{{Kind: "code", Head: "```code", Tail: "```"}}
	regions := NewRegionScanner(shapes).Scan(md)
	for _, r := range regions {
		if r.Kind != "" {
			t.Fatalf("unregistered fence must not be a shape region, got Kind=%q", r.Kind)
		}
	}
}

func TestRegionScanner_EmptyBodyFenceMidDocument(t *testing.T) {
	// An empty-body fence followed by content must tile gaplessly and be
	// emitted as a shape region. The shape parser absorbs the fence head,
	// body (none), closing delimiter, and the trailing blank separator —
	// goldmark's Continue lifecycle sees the blank line as the last consumed
	// byte of the span. The important invariant is gapless tiling and Kind.
	md := "before\n\n```code\n```\n\nafter\n"
	shapes := []RegionShape{{Kind: "code", Head: "```code", Tail: "```"}}
	regions := NewRegionScanner(shapes).Scan(md)

	// (a) tiling: concatenating Raw must reproduce the source exactly.
	var sum string
	for _, r := range regions {
		sum += r.Raw
	}
	if sum != md {
		t.Fatalf("empty-body fence destroyed tiling.\n got: %q\nwant: %q", sum, md)
	}

	// (b) structure: text | fence-code | text
	if len(regions) != 3 {
		t.Fatalf("want 3 regions (text, fence, text), got %d: %#v", len(regions), regions)
	}
	if regions[0].Kind != "" {
		t.Errorf("region[0] should be text, got Kind=%q", regions[0].Kind)
	}
	if regions[1].Kind != "code" {
		t.Errorf("region[1] should be fence Kind=code, got Kind=%q", regions[1].Kind)
	}
	// In the shape-driven scanner, Body == Raw for shape regions.
	if regions[1].Body != regions[1].Raw {
		t.Errorf("region[1] Body must equal Raw for shape regions: Body=%q Raw=%q", regions[1].Body, regions[1].Raw)
	}
	if regions[2].Kind != "" {
		t.Errorf("region[2] should be text, got Kind=%q", regions[2].Kind)
	}
}

func TestRegionScanner_EmptyBodyFenceAtEndOfDocument(t *testing.T) {
	// Empty-body fence as the last node in the document.
	md := "before\n\n```code\n```\n"
	shapes := []RegionShape{{Kind: "code", Head: "```code", Tail: "```"}}
	regions := NewRegionScanner(shapes).Scan(md)

	var sum string
	for _, r := range regions {
		sum += r.Raw
	}
	if sum != md {
		t.Fatalf("empty-body fence at EOF destroyed tiling.\n got: %q\nwant: %q", sum, md)
	}

	if len(regions) != 2 {
		t.Fatalf("want 2 regions (text, fence), got %d: %#v", len(regions), regions)
	}
	if regions[1].Kind != "code" {
		t.Errorf("region[1] should be fence Kind=code, got Kind=%q", regions[1].Kind)
	}
	if regions[1].Raw != "```code\n```\n" {
		t.Errorf("region[1] Raw = %q, want %q", regions[1].Raw, "```code\n```\n")
	}
	// In the shape-driven scanner, Body == Raw for shape regions.
	if regions[1].Body != regions[1].Raw {
		t.Errorf("region[1] Body must equal Raw for shape regions: Body=%q Raw=%q", regions[1].Body, regions[1].Raw)
	}
}

func TestRegionScanner_TextRegionBodyEqualsRaw(t *testing.T) {
	// Text regions must have Body == Raw (doc comment guarantee).
	md := "before\n\n```code\nid: co-1\n```\n\nafter\n"
	shapes := []RegionShape{{Kind: "code", Head: "```code", Tail: "```"}}
	regions := NewRegionScanner(shapes).Scan(md)
	for _, r := range regions {
		if r.Kind == "" && r.Body != r.Raw {
			t.Errorf("text region Body != Raw:\n Body=%q\n Raw=%q", r.Body, r.Raw)
		}
	}
}

func TestScan_proseMarkerSpanWithInnerFence_isOneRegion(t *testing.T) {
	shapes := []RegionShape{
		{Kind: "diagram", Head: "```diagram", Tail: "```"},
		{Kind: KindProse, Head: "<!--s:", Tail: "<!--/s:"},
	}
	src := "intro\n\n<!--s:pr-1-->\na\n\n```mermaid\nx\n```\n\nb\n<!--/s:pr-1-->\n\nend\n"
	regions := NewRegionScanner(shapes).Scan(src)

	// Expect: [text "intro"][prose span][text "end"].
	if len(regions) != 3 {
		t.Fatalf("want 3 regions, got %d: %#v", len(regions), regions)
	}
	if regions[0].Kind != "" || !strings.Contains(regions[0].Raw, "intro") {
		t.Fatalf("region0: %#v", regions[0])
	}
	if regions[1].Kind != KindProse || !strings.Contains(regions[1].Raw, "```mermaid") {
		t.Fatalf("region1 must be the whole prose span incl inner fence: %#v", regions[1])
	}
	if regions[2].Kind != "" || !strings.Contains(regions[2].Raw, "end") {
		t.Fatalf("region2: %#v", regions[2])
	}
	// Gapless tiling: concatenating Raw reproduces the source.
	if regions[0].Raw+regions[1].Raw+regions[2].Raw != src {
		t.Fatalf("regions are not gapless")
	}
}
