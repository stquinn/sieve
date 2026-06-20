package processors

import (
	"regexp"
	"sieve/sieve/block"
	"strings"
)

// ProseProcessor makes prose a FIRST-CLASS block flavour — not a special case the
// spine hardcodes. Prose is a SieveBlock whose payload is Attrs["content"]; this
// processor owns everything a flavour owns: how prose serializes (content wrapped
// in <!--s:ID--> handle markers), how it builds AI context, and the seams for the
// operations the block model exists for — extract (Transform: turn entries into a
// prose block), and a RunJob hook ready for rewrite/enrich. The async job is a
// no-op TODAY, which is "no job registered yet", not "barred from having one".
//
// Registered in init() so prose is ALWAYS a flavour (svc-free), even in pure
// serialization tests — the spine can ask any block, including prose, to serialize.
type ProseProcessor struct{}

func init() { block.RegisterProcessor(block.KindProse, &ProseProcessor{}) }

// IDPrefix mints "pr-…" handles for prose.
func (p *ProseProcessor) IDPrefix() string { return "pr" }

// Mode marks prose as its own serialization shape (content + markers), distinct
// from fenced YAML / inline.
func (p *ProseProcessor) Mode() block.BlockMode { return block.BlockModeProse }

// Serialize is the CUSTOM, non-standard serialization the block model put on the
// processor: a prose block carrying an ID is wrapped in paired comment-tag handle
// markers; the open marker lists the full handle-set, the close the primary id.
// Handle-less prose (not yet minted) emits bare content. This is the only thing
// that makes prose's on-disk form a flavour concern instead of a spine if-branch.
func (p *ProseProcessor) Serialize(blk block.SieveBlock) (string, error) {
	if blk.ID == "" {
		return blk.Content(), nil
	}
	handles := append([]string{blk.ID}, blk.Aliases...)
	open := "<!--s:" + strings.Join(handles, " ") + "-->"
	closeTag := "<!--/s:" + blk.ID + "-->"
	return open + "\n" + blk.Content() + "\n" + closeTag, nil
}

// BuildContext: a prose block's AI context IS its content (the uniform dispatch in
// BuildContextForID now routes here by kind — no hardcoded prose branch). If the
// block carries ==highlighted== words, they are appended as explicit AI targets —
// the "Specifically regarding" hint the retired block-anchor used to provide,
// now derived from the highlights that live in the prose content (the source of
// truth). So the highlight-as-target feature survives the anchor's removal.
func (p *ProseProcessor) BuildContext(blk block.SieveBlock, _ block.DocView, _ map[string]bool) string {
	content := blk.Content()
	targets := extractTargets(content)
	if len(targets) == 0 {
		return content
	}
	quoted := make([]string, len(targets))
	for i, t := range targets {
		quoted[i] = `"` + t + `"`
	}
	return content + "\n\nSpecifically regarding: " + strings.Join(quoted, ", ")
}

// targetHighlightRe matches a ==highlighted== span; the capture is its interior.
var targetHighlightRe = regexp.MustCompile(`==([^=]+)==`)

// extractTargets pulls the ==highlighted== words/phrases out of prose content,
// trimmed and in document order. These are the AI "targets" the user marked —
// the successor to the retired block-anchor's Targets, sourced from the highlight
// markers that round-trip in the content itself.
func extractTargets(content string) []string {
	var targets []string
	for _, m := range targetHighlightRe.FindAllStringSubmatch(content, -1) {
		if t := strings.TrimSpace(m[1]); t != "" {
			targets = append(targets, t)
		}
	}
	return targets
}

// MarkdownRepresentation: prose's markdown is its content verbatim.
func (p *ProseProcessor) MarkdownRepresentation(blk block.SieveBlock) string { return blk.Content() }

// InitAttrs seeds a prose block's payload from overrides (the content).
func (p *ProseProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{"id": id}
	for k, v := range overrides {
		if k == "id" {
			continue
		}
		attrs[k] = v
	}
	return attrs
}

// IsBlock is false: prose is never auto-detected on paste (it is the thing you get
// when you type, or the explicit target of an extract) — so it never hijacks the
// paste-matcher chain.
func (p *ProseProcessor) IsBlock(_ []block.ContentEntry) bool { return false }

// Transform is the EXTRACT seam: turn clipboard/extraction entries into a prose
// block by collecting their content as the block's markdown body. This is how an
// AI block's table (or any rich payload) becomes a prose block in the document.
func (p *ProseProcessor) Transform(entries []block.ContentEntry, _ string, _ string) map[string]interface{} {
	var parts []string
	for _, e := range entries {
		if s := strings.TrimSpace(e.Content); s != "" {
			parts = append(parts, s)
		}
	}
	return map[string]interface{}{"content": strings.Join(parts, "\n\n")}
}

// RunJob is the rewrite/enrich seam — a no-op until a prose job is wired, but the
// seam exists so prose can be a producer/consumer like any other block.
func (p *ProseProcessor) RunJob(_ block.JobContext) error { return nil }

// JobLabel: no prose job yet.
func (p *ProseProcessor) JobLabel(_ *block.SieveBlock) string { return "" }

// OnChange: prose has no synchronous reaction.
func (p *ProseProcessor) OnChange(_ *block.SieveBlock) {}

// markerOpenRe / markerCloseRe match the paired comment-tag delimiters that
// bound every block (spec §"Storage format: a comment-tag block tree"). The open
// marker's capture is a SPACE-SEPARATED handle list: the first token is the
// block's primary ID, any remaining tokens are aliases it also answers to
// (post-merge handle-set, spec §7). The close marker carries the primary ID
// only. The `s:` sentinel namespace distinguishes these from user HTML comments.
var (
	markerOpenRe  = regexp.MustCompile(`^\s*<!--s:([\w-]+(?:\s+[\w-]+)*)\s*-->\s*$`)
	markerCloseRe = regexp.MustCompile(`^\s*<!--/s:([\w-]+)\s*-->\s*$`)
)

// Retired block-anchor delimiters ([!block] id="X" … [!block-end]). Recognised
// ONLY so old documents upgrade silently to id-bearing prose — see
// scanProseRegion. New saves never emit these; promote-to-prose now writes the
// canonical <!--s:ID--> markers above. Delete once no library carries anchors.
var (
	legacyAnchorOpenRe  = regexp.MustCompile(`^\s*\[!block\]\s+id="([^"]+)"\s*$`)
	legacyAnchorCloseRe = regexp.MustCompile(`^\s*\[!block-end\]\s*$`)
)

// scanProseRegion splits a non-fenced region into prose blocks using paired
// comment-tag delimiters. A matched `<!--s:ID …-->` / `<!--/s:ID-->` pair is one
// prose block whose interior is taken verbatim (opaque — never re-scanned for
// nested markers; nesting is container-only, Stage E). An open with no matching
// close is unbalanced → literal text. Any maximal run of undelimited lines is a
// SINGLE prose block (never blank-line split); whitespace-only runs are dropped.
func scanProseRegion(region string) []block.SieveBlock {
	lines := strings.Split(region, "\n")
	var out []block.SieveBlock
	var pending []string

	flushPending := func() {
		if len(pending) == 0 {
			return
		}
		content := strings.Trim(strings.Join(pending, "\n"), "\n")
		pending = pending[:0]
		if strings.TrimSpace(content) != "" {
			// Undelimited (marker-less) prose: no id on disk → the factory mints
			// one now (hydration on parse), so the block exists with an id from
			// the moment it is constructed — never swept in afterward.
			out = append(out, block.NewSieveBlock(block.KindProse, "", content, nil))
		}
	}

	for i := 0; i < len(lines); {
		if m := markerOpenRe.FindStringSubmatch(lines[i]); m != nil {
			handles := strings.Fields(m[1])
			primary := handles[0]
			if closeIdx := findClose(lines, i+1, primary); closeIdx != -1 {
				flushPending()
				// Delimited prose: the marker carries the primary handle, so the
				// factory keeps it (no mint).
				blk := block.NewSieveBlock(block.KindProse, primary, strings.Join(lines[i+1:closeIdx], "\n"), nil)
				if len(handles) > 1 {
					blk.Aliases = append([]string(nil), handles[1:]...)
				}
				out = append(out, blk)
				i = closeIdx + 1
				continue
			}
			// unbalanced open → fall through; the marker line is literal content
		}
		// Retired [!block] id="X" … [!block-end] anchors silently upgrade to
		// id-bearing prose (D-r.7 made prose carry its own id, so the wrapper is
		// redundant). A paired anchor becomes one prose block CARRYING X, so AI ref
		// chains that pointed at X still resolve. An orphaned delimiter — the anchor
		// wrapped a fenced block, which split the open/close into separate regions —
		// is stripped, never leaked as literal prose text.
		if m := legacyAnchorOpenRe.FindStringSubmatch(lines[i]); m != nil {
			if closeIdx := findLegacyClose(lines, i+1); closeIdx != -1 {
				flushPending()
				content := strings.Trim(strings.Join(lines[i+1:closeIdx], "\n"), "\n")
				if content != "" {
					out = append(out, block.NewSieveBlock(block.KindProse, m[1], content, nil))
				}
				i = closeIdx + 1
				continue
			}
			i++ // orphaned open → strip
			continue
		}
		if legacyAnchorCloseRe.MatchString(lines[i]) {
			i++ // orphaned close → strip
			continue
		}
		pending = append(pending, lines[i])
		i++
	}
	flushPending()
	return out
}

// findClose returns the index of the first close marker at or after start whose
// primary id matches, or -1 if none (the open is then unbalanced → literal text).
func findClose(lines []string, start int, primary string) int {
	for k := start; k < len(lines); k++ {
		if cm := markerCloseRe.FindStringSubmatch(lines[k]); cm != nil && cm[1] == primary {
			return k
		}
	}
	return -1
}

// findLegacyClose returns the index of the first retired [!block-end] line at or
// after start, or -1. The legacy close carries no id, so it pairs with the
// nearest preceding [!block] open (anchors were never nested).
func findLegacyClose(lines []string, start int) int {
	for k := start; k < len(lines); k++ {
		if legacyAnchorCloseRe.MatchString(lines[k]) {
			return k
		}
	}
	return -1
}

// Shape: prose regions are delimited by paired <!--s:ID--> / <!--/s:ID--> markers.
// Kind is "prose"; the markers are kind-blind so Head/Tail carry no id.
func (p *ProseProcessor) Shape() block.RegionShape {
	return block.RegionShape{Kind: block.KindProse, Head: "<!--s:", Tail: "<!--/s:"}
}

// Accepts always returns true: prose is the terminal mop-up. The codec EXCLUDES
// prose from its Accepts loop (it skips Mode()==BlockModeProse) and invokes
// Deserialize explicitly on the coalesced run of unclaimed regions — so this
// truthful "I accept anything" never shadows a structured recogniser.
func (p *ProseProcessor) Accepts(region block.Region) bool { return true }

// Deserialize splits a raw prose run into prose blocks at its paired
// <!--s:ID--> / <!--/s:ID--> markers (delimited blocks keep their handle; an
// undelimited run mints one). The inverse of ProseProcessor.Serialize, which
// writes those markers. Owns both sides of prose's SerDes.
func (p *ProseProcessor) Deserialize(region block.Region) ([]block.SieveBlock, error) {
	return scanProseRegion(region.Raw), nil
}
