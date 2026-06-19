package sieve

import (
	"strings"
	"time"
)

// AIBlockProcessor implements BlockProcessor for the "ai-block" kind.
type AIBlockProcessor struct {
	svc BlockServices
	FencedSerializer // one shared YAML serialization — free
}

func NewAIBlockProcessor(svc BlockServices) *AIBlockProcessor {
	return &AIBlockProcessor{svc: svc}
}

func (p *AIBlockProcessor) IDPrefix() string { return "ai" }

func (p *AIBlockProcessor) Mode() BlockMode { return BlockModeBlock }

func (p *AIBlockProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":        id,
		"status":    BlockStatusPending,
		"createdAt": time.Now().UTC().Format(time.RFC3339),
		"ref":       "doc",
		"question":  "",
		"response":  "",
		"type":      "ASK",
		"model":     "",
		"error":     "",
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

func (p *AIBlockProcessor) IsBlock(entries []ContentEntry) bool { return false }
func (p *AIBlockProcessor) Transform(entries []ContentEntry, uuid, blockID string) map[string]interface{} { return nil }

func (p *AIBlockProcessor) OnChange(block *SieveBlock) {}

func (p *AIBlockProcessor) JobLabel(block *SieveBlock) string {
	if t, _ := block.Attrs["type"].(string); t == "EXPLAIN" {
		return "Explaining…"
	}
	return "Asking AI…"
}

// BuildContext returns a Q&A summary for when this block appears in another block's ref chain.
func (p *AIBlockProcessor) BuildContext(block SieveBlock, doc DocView, seen map[string]bool) string {
	q, _ := block.Attrs["question"].(string)
	r, _ := block.Attrs["response"].(string)
	t, _ := block.Attrs["type"].(string)

	var sb strings.Builder
	sb.WriteString("NODE ID: ")
	sb.WriteString(block.ID)
	sb.WriteString("\n")

	if t == "EXPLAIN" {
		sb.WriteString("EXPLAIN NODE: ")
		ref, _ := block.Attrs["ref"].(string)
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
		ref, _ := block.Attrs["ref"].(string)
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
func expandAIBlockRefs(refs []string, doc DocView) []string {
	var result []string
	for _, id := range refs {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if blk, ok := doc.getBlock(id); ok && blk.Kind == "ai-block" {
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
func (p *AIBlockProcessor) RunJob(jctx JobContext) error {
	block := jctx.Block
	ref, _ := block.Attrs["ref"].(string)
	blockType, _ := block.Attrs["type"].(string)

	// Seed seen with this block's own ID to prevent self-reference.
	seen := map[string]bool{block.ID: true}
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
		ctx := BuildContextForID(id, jctx.Doc, seen)
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
	questionCtx := p.BuildContext(*block, jctx.Doc, seen)

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
			block.Attrs["status"] = "TIMEOUT"
		} else {
			block.Attrs["status"] = BlockStatusError
		}
		block.Attrs["error"] = errMsg
		return runErr
	}

	block.Attrs["status"] = BlockStatusComplete
	block.Attrs["response"] = response
	block.Attrs["completedAt"] = time.Now().UTC().Format(time.RFC3339)
	return nil
}

func (p *AIBlockProcessor) MarkdownRepresentation(block SieveBlock) string {
	status, _ := block.Attrs["status"].(string)
	response, _ := block.Attrs["response"].(string)
	response = strings.TrimSpace(response)
	if status != BlockStatusComplete || response == "" {
		return ""
	}
	question, _ := block.Attrs["question"].(string)
	question = strings.TrimSpace(question)
	if question != "" {
		return "### " + question + "\n\n" + response
	}
	return response
}
