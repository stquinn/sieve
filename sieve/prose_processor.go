package sieve

import "strings"

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

func init() { RegisterProcessor(KindProse, &ProseProcessor{}) }

// IDPrefix mints "pr-…" handles for prose.
func (p *ProseProcessor) IDPrefix() string { return "pr" }

// Mode marks prose as its own serialization shape (content + markers), distinct
// from fenced YAML / inline.
func (p *ProseProcessor) Mode() BlockMode { return BlockModeProse }

// Serialize is the CUSTOM, non-standard serialization the block model put on the
// processor: a prose block carrying an ID is wrapped in paired comment-tag handle
// markers; the open marker lists the full handle-set, the close the primary id.
// Handle-less prose (not yet minted) emits bare content. This is the only thing
// that makes prose's on-disk form a flavour concern instead of a spine if-branch.
func (p *ProseProcessor) Serialize(block SieveBlock) (string, error) {
	if block.ID == "" {
		return block.Content(), nil
	}
	handles := append([]string{block.ID}, block.Aliases...)
	open := "<!--s:" + strings.Join(handles, " ") + "-->"
	closeTag := "<!--/s:" + block.ID + "-->"
	return open + "\n" + block.Content() + "\n" + closeTag, nil
}

// BuildContext: a prose block's AI context IS its content (the uniform dispatch in
// BuildContextForID now routes here by kind — no hardcoded prose branch).
func (p *ProseProcessor) BuildContext(block SieveBlock, _ DocView, _ map[string]bool) string {
	return block.Content()
}

// MarkdownRepresentation: prose's markdown is its content verbatim.
func (p *ProseProcessor) MarkdownRepresentation(block SieveBlock) string { return block.Content() }

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
func (p *ProseProcessor) IsBlock(_ []ContentEntry) bool { return false }

// Transform is the EXTRACT seam: turn clipboard/extraction entries into a prose
// block by collecting their content as the block's markdown body. This is how an
// AI block's table (or any rich payload) becomes a prose block in the document.
func (p *ProseProcessor) Transform(entries []ContentEntry, _ string, _ string) map[string]interface{} {
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
func (p *ProseProcessor) RunJob(_ JobContext) error { return nil }

// JobLabel: no prose job yet.
func (p *ProseProcessor) JobLabel(_ *SieveBlock) string { return "" }

// OnChange: prose has no synchronous reaction.
func (p *ProseProcessor) OnChange(_ *SieveBlock) {}
