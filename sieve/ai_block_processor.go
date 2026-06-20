package sieve

import (
	"sieve/sieve/block"
	"strings"
	"time"
)

// AIBlockProcessor implements BlockProcessor for the "ai-block" kind.
type AIBlockProcessor struct {
	svc                      block.BlockServices
	block.FencedSerializer   // one shared YAML serialization — free
	block.FencedDeserializer // its mirror — recognise+parse the fenced form
}

func NewAIBlockProcessor(svc block.BlockServices) *AIBlockProcessor {
	return &AIBlockProcessor{svc: svc, FencedDeserializer: block.FencedDeserializer{Kind: "ai-block"}}
}

func (p *AIBlockProcessor) IDPrefix() string { return "ai" }

func (p *AIBlockProcessor) Mode() block.BlockMode { return block.BlockModeBlock }

func (p *AIBlockProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":                id,
		"status":            block.BlockStatusPending,
		"createdAt":         time.Now().UTC().Format(time.RFC3339),
		"ref":               "doc",
		"question":          "",
		"response":          "",
		"type":              "ASK",
		"model":             "",
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

func (p *AIBlockProcessor) IsBlock(entries []block.ContentEntry) bool { return false }
func (p *AIBlockProcessor) Transform(entries []block.ContentEntry, uuid, blockID string) map[string]interface{} {
	return nil
}

func (p *AIBlockProcessor) OnChange(blk *block.SieveBlock) {}

func (p *AIBlockProcessor) JobLabel(blk *block.SieveBlock) string {
	if t, _ := blk.Attrs["type"].(string); t == "EXPLAIN" {
		return "Explaining…"
	}
	return "Asking AI…"
}

// BuildContext returns a Q&A summary for when this block appears in another block's ref chain.
func (p *AIBlockProcessor) BuildContext(blk block.SieveBlock, doc block.DocView, seen map[string]bool) string {
	q, _ := blk.Attrs["question"].(string)
	r, _ := blk.Attrs["response"].(string)
	t, _ := blk.Attrs["type"].(string)

	var sb strings.Builder
	sb.WriteString("NODE ID: ")
	sb.WriteString(blk.ID)
	sb.WriteString("\n")

	if t == "EXPLAIN" {
		sb.WriteString("EXPLAIN NODE: ")
		ref, _ := blk.Attrs["ref"].(string)
		// The last segment of the comma-separated ref is the specific node being
		// explained; earlier segments are the broader context chain.
		if lastComma := strings.LastIndex(ref, ","); lastComma != -1 {
			sb.WriteString(strings.TrimSpace(ref[lastComma+1:]))
		} else {
			sb.WriteString(strings.TrimSpace(ref))
		}
		if r != "" {
			sb.WriteString("\n**ANSWER:** ")
			sb.WriteString(strings.TrimSpace(r))
		}
	} else {
		sb.WriteString("QUESTION ABOUT: ")
		ref, _ := blk.Attrs["ref"].(string)
		if lastComma := strings.LastIndex(ref, ","); lastComma != -1 {
			sb.WriteString(strings.TrimSpace(ref[lastComma+1:]))
		} else {
			sb.WriteString(strings.TrimSpace(ref))
		}
		if q != "" {
			sb.WriteString("\n")
			sb.WriteString(strings.TrimSpace(q))
		}
		if r != "" {
			sb.WriteString("\n\n**ANSWER:** ")
			sb.WriteString(strings.TrimSpace(r))
		}
	}

	return sb.String()
}

// expandAIBlockRefs replaces any ai-block ID in refs with its own ref chain
// followed by itself. This lets the caller pass a single ai-block ID and still
// receive the original source content as primary context and the prior Q&A as
// history — without the frontend needing to pre-build the chain.
func expandAIBlockRefs(refs []string, doc block.DocView) []string {
	var result []string
	for _, id := range refs {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if blk, ok := doc.GetBlock(id); ok && blk.Kind == "ai-block" {
			if aiRef, _ := blk.Attrs["ref"].(string); aiRef != "" && aiRef != "doc" {
				for _, part := range strings.Split(aiRef, ",") {
					if part = strings.TrimSpace(part); part != "" {
						result = append(result, part)
					}
				}
			}
		}
		result = append(result, id)
	}
	return result
}

// RunJob resolves each ID in the ref chain via BuildContextForID.
// Dispatch is by block kind: img-1234 → SmartImageProcessor,
// blk-1234 → BlockAnchorProvider, a prior AI block → AIBlockProcessor.BuildContext.
// Image block IDs are derived from the seen map after context resolution —
// the frontend sends nothing about images.
func (p *AIBlockProcessor) RunJob(jctx block.JobContext) error {
	blk := jctx.Block
	ref, _ := blk.Attrs["ref"].(string)
	blockType, _ := blk.Attrs["type"].(string)

	// Seed seen with this block's own ID to prevent self-reference.
	seen := map[string]bool{blk.ID: true}
	var content string
	var historyParts []string
	// Expand any ai-block refs so the original source is primary content
	// and the prior Q&A becomes history — no chain-building needed in the frontend.
	refs := expandAIBlockRefs(strings.Split(ref, ","), jctx.Doc)

	var validCtxs []string
	for _, id := range refs {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		ctx := block.BuildContextForID(id, jctx.Doc, seen)
		if ctx != "" {
			validCtxs = append(validCtxs, ctx)
		}
	}

	if len(validCtxs) > 0 {
		content = validCtxs[0]
		if len(validCtxs) > 1 {
			historyParts = validCtxs[1:]
		}
	}
	history := strings.Join(historyParts, "\n\n---\n\n")

	// Call BuildContext on the current block to form the question
	questionCtx := p.BuildContext(*blk, jctx.Doc, seen)

	var response string
	var runErr error
	if blockType == "EXPLAIN" {
		response, runErr = p.svc.AI.RunExplain(content, history, questionCtx, jctx.UUID)
	} else {
		response, runErr = p.svc.AI.RunAsk(content, history, questionCtx, jctx.UUID)
	}

	if runErr != nil {
		errMsg := runErr.Error()
		if strings.Contains(errMsg, "timeout") {
			blk.Attrs["status"] = "TIMEOUT"
		} else {
			blk.Attrs["status"] = block.BlockStatusError
		}
		blk.Attrs["error"] = errMsg
		return runErr
	}

	blk.Attrs["status"] = block.BlockStatusComplete
	blk.Attrs["response"] = response
	blk.Attrs["completedAt"] = time.Now().UTC().Format(time.RFC3339)
	return nil
}

func (p *AIBlockProcessor) MarkdownRepresentation(blk block.SieveBlock) string {
	status, _ := blk.Attrs["status"].(string)
	response, _ := blk.Attrs["response"].(string)
	response = strings.TrimSpace(response)
	if status != block.BlockStatusComplete || response == "" {
		return ""
	}
	question, _ := blk.Attrs["question"].(string)
	question = strings.TrimSpace(question)
	if question != "" {
		return "### " + question + "\n\n" + response
	}
	return response
}
