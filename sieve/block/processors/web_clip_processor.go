package processors

import (
	"fmt"
	"net/url"
	"sieve/sieve/block"
	"strings"
	"time"
)

// WebClipBlockProcessor handles the 'web-clip' Kind.
type WebClipBlockProcessor struct {
	svc                      block.BlockServices
	block.FencedSerializer   // one shared YAML serialization — free
	block.FencedDeserializer // its mirror — recognise+parse the fenced form
}

func NewWebClipBlockProcessor(svc block.BlockServices) *WebClipBlockProcessor {
	return &WebClipBlockProcessor{svc: svc, FencedDeserializer: block.FencedDeserializer{Kind: "web-clip"}}
}

func (p *WebClipBlockProcessor) Kind() string { return p.FencedDeserializer.Kind }

func (p *WebClipBlockProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":                id,
		"source":            "",
		"title":             "",
		"mode":              "fetch",
		"status":            block.BlockStatusPending,
		"model":             "",
		"createdAt":         time.Now().UTC().Format(time.RFC3339),
		"completedAt":       "",
		"content":           "",
		"error":             "",
		"supportsEmbedding": true,
	}
	for k, v := range overrides {
		if k == "id" {
			continue
		}
		attrs[k] = v
	}
	return attrs
}

// IsSupportedContent claims a copied clip (round-trip: paste + extract) and any
// view carrying an ordinary link — bare URL, markdown link, or rendered <a> — as a
// TRANSFORM only. A pasted URL is NOT claimed for paste: it stays an ordinary
// markdown link, and the clip is reached by an explicit Transform (#67).
func (p *WebClipBlockProcessor) IsSupportedContent(entries []block.ContentEntry) block.SupportedActions {
	for _, e := range entries {
		if e.IsSieveType(p) {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionExtract}}
		}
		if l := e.Link(); !l.IsZero() {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionTransform}}
		}
	}
	return block.SupportedActions{Kind: p.Kind()}
}

func (p *WebClipBlockProcessor) AllowSelfExtraction() bool {
	return true
}

func (p *WebClipBlockProcessor) Transform(entries []block.ContentEntry, uuid, blockID string, action block.Action) map[string]interface{} {
	for _, e := range entries {
		if e.IsSieveType(p) {
			return e.AsAttrsForNewBlock(p)
		}
		l := e.Link()
		if l.IsZero() {
			continue
		}
		mode := "fetch" // default
		if e.Context != nil {
			if m, ok := e.Context["mode"].(string); ok && m != "" {
				mode = m
			}
		}
		overrides := map[string]interface{}{
			"source": l.Href,
			"mode":   mode,
		}
		if l.Label != "" {
			// The link's own text is the best title we have until the clip lands.
			overrides["title"] = l.Label
		}
		return overrides
	}
	return nil
}

func (p *WebClipBlockProcessor) OnChange(_ *block.SieveBlock) {}

func (p *WebClipBlockProcessor) BuildContext(blk block.SieveBlock, _ block.DocView, seen map[string]bool) block.AIContext {
	source, _ := blk.Attrs["source"].(string)
	title, _ := blk.Attrs["title"].(string)
	content, _ := blk.Attrs["content"].(string)
	if source == "" && content == "" {
		return block.AIContext{}
	}
	var sb strings.Builder
	if content != "" {
		sb.WriteString("\n" + content)
	}
	ctx := block.AIContext{NodeIDs: []string{blk.ID}, Content: sb.String()}
	ctx.Tags = []block.Tag{
		{Label: "URL", Values: []string{source}},
		{Label: "Title", Values: []string{title}},
	}
	return ctx
}

// webClipLabel is the in-flight status label for a clip job (kind-qualified host).
func (p *WebClipBlockProcessor) webClipLabel(blk *block.SieveBlock) string {
	mode, _ := blk.Attrs["mode"].(string)
	source, _ := blk.Attrs["source"].(string)
	host := source
	if u, err := url.Parse(source); err == nil && u.Host != "" {
		host = u.Host
	}
	if mode == "summarise" {
		return "Summarising " + host
	}
	return "Fetching " + host
}

func (p *WebClipBlockProcessor) Mode() block.BlockMode {
	return block.BlockModeBlock
}

// DescribeJob declares the AI clip job. The document body is read synchronously
// here (before the AI call, mirroring the old RunJob), then captured by Work. A
// web-clip always has async work (born PENDING), so DescribeJob never returns nil.
// Apply writes the success attrs; the error path (status ERROR/TIMEOUT) is the
// framework's job in EditorService.finish, so Apply is success-only.
func (p *WebClipBlockProcessor) DescribeJob(jctx block.JobContext) *block.ProcessorJob {
	uuid, blk := jctx.UUID, jctx.Block
	id := blk.ID
	source, _ := blk.Attrs["source"].(string)
	mode, _ := blk.Attrs["mode"].(string)
	if mode == "" {
		mode = "fetch"
	}

	var docContent string
	if doc, err := p.svc.Documents.LoadByUUID(uuid); err == nil {
		docContent = string(doc.Body())
	}

	return &block.ProcessorJob{
		Category: block.CategoryAI,
		Label:    p.webClipLabel(blk),
		Work: func() (any, error) {
			if p.svc.AI == nil {
				return nil, fmt.Errorf("webclip job failed: AI service is unavailable")
			}
			title, content, cliErr := p.svc.AI.RunWebClip(uuid, id, source, mode, docContent)
			if cliErr != nil {
				return nil, cliErr
			}
			return []string{title, content}, nil
		},
		Apply: func(result any, b *block.SieveBlock) {
			tc := result.([]string)
			b.Attrs["status"] = block.BlockStatusComplete
			if tc[0] != "" {
				b.Attrs["title"] = tc[0] // else keep the link's own text
			}
			b.Attrs["content"] = tc[1]
			b.Attrs["completedAt"] = time.Now().UTC().Format(time.RFC3339)
			b.Attrs["model"] = p.svc.State.LoadSettings().Model
		},
	}
}

func (p *WebClipBlockProcessor) MarkdownRepresentation(blk block.SieveBlock, _ string) string {
	content, _ := blk.Attrs["content"].(string)
	content = strings.TrimSpace(content)
	if content == "" {
		return ""
	}
	title, _ := blk.Attrs["title"].(string)
	source, _ := blk.Attrs["source"].(string)
	var sb strings.Builder
	if title != "" && source != "" {
		sb.WriteString("### [" + title + "](" + source + ")\n\n")
	} else if title != "" {
		sb.WriteString("### " + title + "\n\n")
	}
	sb.WriteString(content)
	return sb.String()
}
