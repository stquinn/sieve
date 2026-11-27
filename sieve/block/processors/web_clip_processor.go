package processors

import (
	"fmt"
	"net/url"
	"sieve/sieve/block"
	"sieve/sieve/domain"
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

// AnswerCard offers a web clip to a model writing an answer (block.AnswerKind):
// it lands PENDING and its own job has an AI run fetch the page and summarise it,
// or bring it in whole.
func (p *WebClipBlockProcessor) AnswerCard() domain.AnswerCard {
	return domain.AnswerCard{
		Use: "a web page clipped into the answer: its content fetched and summarised for the reader to read here " +
			"(a link card only previews a page the reader should visit)",
		Attrs: map[string]string{
			"source": "the page's absolute http or https URL",
			"mode":   "optional: summarise (the default), a summary aimed at this note, or fetch, the page's whole content",
		},
		Example:     map[string]any{"source": "https://go.dev/blog/go1.22"},
		Waits:       "every web clip, whose page is fetched and summarised",
		WaitsAlways: true,
	}
}

// AnswerSource takes a web clip's URL, which must be an absolute http or
// https URL, and its mode (block.AnswerKind).
func (p *WebClipBlockProcessor) AnswerSource(attrs block.AnswerAttrs) (block.AnswerSource, error) {
	s, err := attrs.StringsWith([]string{"source"}, "mode")
	if err != nil {
		return block.AnswerSource{}, err
	}
	source := strings.TrimSpace(s["source"])
	u, err := url.Parse(source)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return block.AnswerSource{}, fmt.Errorf("source must be an absolute http or https URL")
	}
	mode := strings.ToLower(strings.TrimSpace(s["mode"]))
	switch mode {
	case "":
		mode = "summarise"
	case "summarise", "fetch":
	default:
		return block.AnswerSource{}, fmt.Errorf("mode must be summarise or fetch, not %q", s["mode"])
	}
	return block.AnswerSource{Overrides: map[string]any{"source": source, "mode": mode}}, nil
}

func (p *WebClipBlockProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":                id,
		"source":            "",
		"page":              "",
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
	if !block.ContentEntries(entries).Convertible() {
		return block.SupportedActions{Kind: p.Kind()}
	}
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

func (p *WebClipBlockProcessor) OnChange(_ *domain.SieveBlock) {}

func (p *WebClipBlockProcessor) BuildContext(blk domain.SieveBlock, doc block.DocView, seen map[string]bool) block.AIContext {
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
	ctx := doc.NodeContext(blk.ID, sb.String())
	ctx.Tags = []block.Tag{
		{Label: "URL", Values: []string{source}},
		{Label: "Title", Values: []string{title}},
	}
	return ctx
}

// webClipLabel is the in-flight status label for a clip job (kind-qualified host).
func (p *WebClipBlockProcessor) webClipLabel(blk *domain.SieveBlock) string {
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
// here, before the AI call, then captured by Work. A web-clip always has async
// work (born PENDING), so DescribeJob never returns nil.
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
	if p.svc.Documents != nil {
		if doc, err := p.svc.Documents.LoadByUUID(uuid); err == nil {
			docContent = string(doc.Body())
		}
	}

	type webClipResult struct {
		title   string
		content string
		page    string
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
			return webClipResult{
				title:   title,
				content: content,
				page:    p.svc.Documents.PageAssetAddress(uuid, source),
			}, nil
		},
		Apply: func(result any, b *domain.SieveBlock) {
			res := result.(webClipResult)
			b.Attrs["status"] = block.BlockStatusComplete
			if res.title != "" {
				b.Attrs["title"] = res.title // else keep the link's own text
			}
			if res.page != "" {
				b.Attrs["page"] = res.page
			}
			b.Attrs["content"] = res.content
			b.Attrs["completedAt"] = time.Now().UTC().Format(time.RFC3339)
			b.Attrs["model"] = p.svc.State.LoadSettings().Model
		},
	}
}

func (p *WebClipBlockProcessor) MarkdownRepresentation(blk domain.SieveBlock, _ string) string {
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
