package block

import "testing"

func TestRegionScanner_TilesSourceExactly(t *testing.T) {
	md := "intro text\n\n```code\nid: co-1\nsource: x\n```\n\ntrailing\n"
	regions := NewRegionScanner().Scan(md)

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
	regions := NewRegionScanner().Scan(md)
	if len(regions) != 3 {
		t.Fatalf("want 3 regions (text, fence, text), got %d: %#v", len(regions), regions)
	}
	if regions[1].Kind != "code" {
		t.Errorf("fence region Kind = %q, want code", regions[1].Kind)
	}
	if regions[1].Body != "id: co-1\n" {
		t.Errorf("fence region Body = %q, want %q", regions[1].Body, "id: co-1\n")
	}
	if regions[0].Kind != "" || regions[2].Kind != "" {
		t.Errorf("text regions must have empty Kind: %q %q", regions[0].Kind, regions[2].Kind)
	}
}

func TestRegionScanner_PlainLanguageFenceIsAFenceRegion(t *testing.T) {
	// A non-sieve language fence is still emitted as a fence region (Kind="python").
	// Dispatch — not the scanner — decides nobody claims it.
	md := "```python\nprint(1)\n```\n"
	regions := NewRegionScanner().Scan(md)
	if len(regions) != 1 || regions[0].Kind != "python" {
		t.Fatalf("want one python fence region, got %#v", regions)
	}
}

func TestRegionScanner_NestedFenceStaysInText(t *testing.T) {
	// A fence inside a blockquote is NOT top-level → it stays in a text region.
	md := "> ```code\n> id: co-1\n> ```\n"
	regions := NewRegionScanner().Scan(md)
	for _, r := range regions {
		if r.Kind != "" {
			t.Fatalf("nested fence must not be a fence region, got Kind=%q", r.Kind)
		}
	}
}

func TestRegionScanner_EmptyBodyFenceMidDocument(t *testing.T) {
	// An empty-body fence (zero content lines) must tile correctly and be
	// emitted as its own fence region, not swallow the whole document.
	md := "before\n\n```code\n```\n\nafter\n"
	regions := NewRegionScanner().Scan(md)

	// (a) tiling: concatenating Raw must reproduce the source exactly.
	var sum string
	for _, r := range regions {
		sum += r.Raw
	}
	if sum != md {
		t.Fatalf("empty-body fence destroyed tiling.\n got: %q\nwant: %q", sum, md)
	}

	// (b) structure: text | fence | text
	if len(regions) != 3 {
		t.Fatalf("want 3 regions (text, fence, text), got %d: %#v", len(regions), regions)
	}
	if regions[0].Kind != "" {
		t.Errorf("region[0] should be text, got Kind=%q", regions[0].Kind)
	}
	if regions[1].Kind != "code" {
		t.Errorf("region[1] should be fence Kind=code, got Kind=%q", regions[1].Kind)
	}
	if regions[1].Body != "" {
		t.Errorf("region[1] Body should be empty for empty fence, got %q", regions[1].Body)
	}
	if regions[1].Raw != "```code\n```\n" {
		t.Errorf("region[1] Raw = %q, want %q", regions[1].Raw, "```code\n```\n")
	}
	if regions[2].Kind != "" {
		t.Errorf("region[2] should be text, got Kind=%q", regions[2].Kind)
	}
}

func TestRegionScanner_EmptyBodyFenceAtEndOfDocument(t *testing.T) {
	// Empty-body fence as the last node in the document.
	md := "before\n\n```code\n```\n"
	regions := NewRegionScanner().Scan(md)

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
}

func TestRegionScanner_TextRegionBodyEqualsRaw(t *testing.T) {
	// Text regions must have Body == Raw (doc comment guarantee).
	md := "before\n\n```code\nid: co-1\n```\n\nafter\n"
	regions := NewRegionScanner().Scan(md)
	for _, r := range regions {
		if r.Kind == "" && r.Body != r.Raw {
			t.Errorf("text region Body != Raw:\n Body=%q\n Raw=%q", r.Body, r.Raw)
		}
	}
}
