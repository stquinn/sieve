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

func init() { block.RegisterProcessor(&ProseProcessor{}) }

// NewProseProcessor returns a ProseProcessor. The BlockServices argument is
// accepted for API consistency with other processor constructors — prose has
// no service dependencies.
func NewProseProcessor(_ block.BlockServices) *ProseProcessor { return &ProseProcessor{} }

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

// BuildContext: a prose block's AI context IS its content. If the block carries
// ==highlighted== words they become a "Specifically regarding" trailer Tag — NOT
// appended to the string here. The framework's collection merge unions that Tag
// across a multi-block target into ONE focus line (and renders it once via
// AIContext.String). This is the highlight-as-target feature the retired
// block-anchor provided, now a mergeable trailer instead of a per-block suffix.
func (p *ProseProcessor) BuildContext(blk block.SieveBlock, _ block.DocView, _ map[string]bool) block.AIContext {
	content := blk.Content()
	ctx := block.AIContext{NodeIDs: []string{blk.ID}, Content: content}
	if targets := extractTargets(content); len(targets) > 0 {
		ctx.Tags = []block.Tag{{Label: "Specifically regarding", Values: targets}}
	}
	return ctx
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
func (p *ProseProcessor) MarkdownRepresentation(blk block.SieveBlock, _ string) string {
	return blk.Content()
}

// InitAttrs seeds a prose block's payload from overrides (the content).
func (p *ProseProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	// Prose has no async work (DescribeJob is always nil), so it is born COMPLETE —
	// the complete-vs-pending predicate is unconditional, mirroring DescribeJob.
	attrs := map[string]interface{}{"id": id, "status": block.BlockStatusComplete}
	for k, v := range overrides {
		if k == "id" {
			continue
		}
		attrs[k] = v
	}
	return attrs
}

// IsSupportedContent claims any `sieve/<kind>` view — prose is the universal sink.
// A copied prose block (sieve/prose) round-trips on paste AND can be embedded via
// transform. Any other sieve block source offers only transform (structured kinds
// claim their own sieve view first; prose is registered LAST). Never a non-sieve
// mime: inline text paste is untouched. SieveAttrs() is used (not HasPrefix) so the
// "sieve/slice" JSON-array entry (which is not a block object) is never matched.
func (p *ProseProcessor) IsSupportedContent(entries []block.ContentEntry) block.SupportedActions {
	for _, e := range entries {
		if e.IsSieveType(p) {
			// A copied prose block round-trips on paste; embedding prose-in-prose is also a transform.
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionTransform}}
		}
		if _, attrs, ok := e.SieveAttrs(); ok {
			// Any other block source → embed it as prose (the universal sink).
			actions := []block.Action{block.ActionTransform}
			// Smart-pasted source with recoverable raw text → also offer "Undo Smart
			// Paste" (revert detection to the raw text). Detection-and-action are both
			// framework-side; the frontend never decides whether to offer it.
			if sp, _ := attrs["smartPaste"].(bool); sp && p.taggedSourceHasRawText(e) {
				actions = append(actions, block.ActionUndoSmartPaste)
			}
			return block.SupportedActions{Kind: p.Kind(), Actions: actions}
		}
	}
	return block.SupportedActions{Kind: p.Kind()}
}

// taggedSourceHasRawText reports whether the entry's sieve source kind can recover raw
// text (block.RawContenter with a non-empty result). Undo with nothing to revert to is
// not offered.
func (p *ProseProcessor) taggedSourceHasRawText(e block.ContentEntry) bool {
	kind, attrs, ok := e.SieveAttrs()
	if !ok {
		return false
	}
	proc := block.GetProcessor(kind)
	rc, isRaw := proc.(block.RawContenter)
	if proc == nil || !isRaw {
		return false
	}
	return strings.TrimSpace(rc.RawContent(block.NewSieveBlock(kind, "", attrs))) != ""
}

// Transform turns entries into a prose block's content. A `sieve/prose` view carries
// its markdown in attrs.content (the slice-paste path). A foreign sieve source is
// rebuilt and its MarkdownRepresentation is fetched via the registry — prose owns
// this lookup (the "prose is the universal sink" contract). As a final fallback the
// entries' raw content is joined (the extract seam — an AI block's table → prose).
func (p *ProseProcessor) Transform(entries []block.ContentEntry, uuid string, blockID string, action block.Action) map[string]interface{} {
	// An image source (a diagram rendered to SVG by prose's resolveEntries, or any
	// pasted/extracted image) embeds as served image markdown. The smart-image processor
	// owns image saving + the ![](url) form, so delegate BOTH to it via the registry —
	// prose stays service-free. Checked first so a rendered image wins over a co-present
	// source-text entry (e.g. the diagram's sieve view, which would otherwise embed as a
	// mermaid fence).
	if md, ok := p.embedImageMarkdown(entries, uuid, blockID, action); ok {
		return map[string]interface{}{"content": md}
	}
	for _, e := range entries {
		if e.IsSieveType(p) {
			return e.AsAttrsForNewBlock(p)
		}
		// A foreign sieve source. Two prose-targeted transforms share this entry:
		//   ActionUndoSmartPaste → the source's raw text as plain prose (escape hatch).
		//   ActionTransform      → faithful markdown ("Embed in Document").
		if kind, attrs, ok := e.SieveAttrs(); ok {
			proc := block.GetProcessor(kind)
			if action == block.ActionUndoSmartPaste {
				if rc, isRaw := proc.(block.RawContenter); isRaw {
					if raw := rc.RawContent(block.NewSieveBlock(kind, "", attrs)); strings.TrimSpace(raw) != "" {
						return map[string]interface{}{"content": p.sourceAsPlainText(raw)}
					}
				}
			}
			if proc != nil {
				src := block.NewSieveBlock(kind, "", attrs)
				// Markdown-bearing source (block.MarkdownContenter — e.g. a code
				// block whose language is markdown): the content already IS
				// document markdown, so embed the raw source directly instead of
				// a ```markdown fence. This is the escape hatch for markdown
				// captured as a code block.
				if mc, isMD := proc.(block.MarkdownContenter); isMD && mc.ContentIsMarkdown(src) {
					if rc, isRaw := proc.(block.RawContenter); isRaw {
						if raw := strings.TrimSpace(rc.RawContent(src)); raw != "" {
							return map[string]interface{}{"content": raw}
						}
					}
				}
				if md := proc.MarkdownRepresentation(src, uuid); strings.TrimSpace(md) != "" {
					return map[string]interface{}{"content": md}
				}
			}
		}
	}
	var parts []string
	for _, e := range entries {
		if s := strings.TrimSpace(e.Content); s != "" {
			parts = append(parts, s)
		}
	}
	return map[string]interface{}{"content": strings.Join(parts, "\n\n")}
}

// embedImageMarkdown turns an image entry into served image markdown by delegating to
// the smart-image processor: its Transform saves the bytes (saveSVG/saveBase64) and
// returns the asset src; its MarkdownRepresentation (uuid-aware) builds ![](/ui/assets/
// <uuid>/<file>). prose holds no AssetsPort — the registered smart-image instance does.
// ok is false when there is no image entry or smart-image is absent/declines.
func (p *ProseProcessor) embedImageMarkdown(entries []block.ContentEntry, uuid, blockID string, action block.Action) (string, bool) {
	hasImage := false
	for _, e := range entries {
		if strings.HasPrefix(e.MIMEType, "image/") {
			hasImage = true
			break
		}
	}
	if !hasImage {
		return "", false
	}
	si := block.GetProcessor("smart-image")
	if si == nil {
		return "", false
	}
	attrs := si.Transform(entries, uuid, blockID, action)
	if attrs == nil {
		return "", false
	}
	md := si.MarkdownRepresentation(block.NewSieveBlock("smart-image", "", attrs), uuid)
	if strings.TrimSpace(md) == "" {
		return "", false
	}
	return md, true
}

// sourceAsPlainText renders a structured block's raw source for embedding into prose
// as plain TEXT (the "Embed in Document" escape hatch when smart-detection grabbed
// text as code — brackets like {}<>[] trip a language match). Markdown can't carry
// code as text verbatim: a 4-space indent IS an indented code block (a stray fence)
// and a bare newline soft-joins lines (the split header/tail). So de-indent every
// line and join with markdown hard breaks, dropping blank lines (a blank line re-opens
// a code block before the next indented line). The result reads as the user's text,
// never a fence — indentation is intentionally dropped (it's text now, not code).
func (p *ProseProcessor) sourceAsPlainText(src string) string {
	var lines []string
	for _, line := range strings.Split(src, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			lines = append(lines, line)
		}
	}
	return strings.Join(lines, "  \n") // two-space suffix = markdown hard break
}

// DescribeJob is the rewrite/enrich seam — nil (no async work) until a prose job
// is wired, but the seam exists so prose can be a producer/consumer like any
// other block. Prose is created COMPLETE by InitAttrs, so it is never dispatched.
func (p *ProseProcessor) DescribeJob(_ block.JobContext) *block.ProcessorJob {
	return nil
}

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
// newProseBlock is the ONE constructor for a prose SieveBlock — the single place
// that knows prose keeps its body in Attrs["content"] (prose's schema, exactly as
// code's is "source"). Production parsing and tests both build prose blocks through
// here so that knowledge is never copy-pasted. An empty id mints one on parse.
func (ProseProcessor) newProseBlock(id, content string) block.SieveBlock {
	return block.NewSieveBlock(block.KindProse, id, map[string]interface{}{"content": content})
}

func (p ProseProcessor) scanProseRegion(region string) []block.SieveBlock {
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
			out = append(out, p.newProseBlock("", content))
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
				blk := p.newProseBlock(primary, strings.Join(lines[i+1:closeIdx], "\n"))
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
					out = append(out, p.newProseBlock(m[1], content))
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

func (p *ProseProcessor) Kind() string { return "prose" }

// Shape: prose regions are delimited by paired <!--s:ID--> / <!--/s:ID--> markers.
// Kind is "prose"; the markers are kind-blind so Head/Tail carry no id.
func (p *ProseProcessor) Shape() block.RegionShape {
	return block.RegionShape{Kind: block.KindProse, Head: "<!--s:", Tail: "<!--/s:"}
}

// Accepts always returns true: prose is the terminal mop-up. The codec sorts prose
// LAST (DocumentCodec.orderedProseLast), so this truthful "I accept anything" runs
// only after every structured recogniser has had first refusal and never shadows
// them. It claims its own <!--s:--> shape regions plus any gap text / unclaimed fence.
func (p *ProseProcessor) Accepts(region block.Region) bool { return true }

// Deserialize splits a raw prose run into prose blocks at its paired
// <!--s:ID--> / <!--/s:ID--> markers (delimited blocks keep their handle; an
// undelimited run mints one). The inverse of ProseProcessor.Serialize, which
// writes those markers. Owns both sides of prose's SerDes.
func (p *ProseProcessor) Deserialize(region block.Region) ([]block.SieveBlock, error) {
	return p.scanProseRegion(region.Raw), nil
}
