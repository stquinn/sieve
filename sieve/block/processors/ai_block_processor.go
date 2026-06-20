package processors

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

	// Under the point-to-point model a block's ref IS its direct target(s) — the
	// whole ref is what it is about (a MANY when the question spans several blocks),
	// so reference all of it, not just the last segment.
	ref, _ := blk.Attrs["ref"].(string)
	if t == "EXPLAIN" {
		sb.WriteString("EXPLAIN NODE: ")
		sb.WriteString(strings.TrimSpace(ref))
		if r != "" {
			sb.WriteString("\n**ANSWER:** ")
			sb.WriteString(strings.TrimSpace(r))
		}
	} else {
		sb.WriteString("QUESTION ABOUT: ")
		sb.WriteString(strings.TrimSpace(ref))
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

// resolveChain walks the point-to-point ref graph from the action block (selfID,
// startRef) and classifies each reachable node by GEOMETRY, not type: a node that
// has its own ref is INTERIOR — part of the THREAD (the conversation/derivation
// history) — and is recursed into; a node with no ref is a LEAF — part of the
// TARGET, the terminal MANY the chain bottoms out at. "doc" is a leaf (the whole
// document). A seen-guard makes cyclic graphs terminate. thread is returned
// oldest-first (the deepest interior node is the oldest). Type never enters the
// decision, so a future DATA → GRAPH → AI chain classifies correctly with no change.
func (p *AIBlockProcessor) resolveChain(selfID, startRef string, doc block.DocView) (targets, thread []string) {
	seen := map[string]bool{}
	if selfID != "" {
		seen[selfID] = true
	}
	var descend func(ref string)
	descend = func(ref string) {
		for _, raw := range strings.Split(ref, ",") {
			id := strings.TrimSpace(raw)
			if id == "" || seen[id] {
				continue
			}
			seen[id] = true
			if id == "doc" {
				targets = append(targets, id)
				continue
			}
			childRef := ""
			if b, ok := doc.GetBlock(id); ok {
				childRef, _ = b.Attrs["ref"].(string)
			}
			if strings.TrimSpace(childRef) == "" {
				targets = append(targets, id) // leaf → target
			} else {
				thread = append(thread, id) // interior → thread
				descend(childRef)
			}
		}
	}
	descend(startRef)
	for i, j := 0, len(thread)-1; i < j; i, j = i+1, j-1 {
		thread[i], thread[j] = thread[j], thread[i] // shallow-first → oldest-first
	}
	return targets, thread
}

// buildTargets renders the terminal MANY (the target node) by asking each member
// block for its own AI representation through the registry (BuildContextForID) and
// joining them. Type-agnostic: every block self-describes, so a multi-block
// selection, a single block, or "doc" all render the same way. Empty contexts
// (e.g. an empty prose block) drop out.
func (p *AIBlockProcessor) buildTargets(targets []string, doc block.DocView) string {
	var parts []string
	for _, id := range targets {
		if c := block.BuildContextForID(id, doc, map[string]bool{}); c != "" {
			parts = append(parts, c)
		}
	}
	return strings.Join(parts, "\n\n")
}

// RunJob builds the prompt by walking this block's point-to-point ref graph and
// splitting it by GEOMETRY (resolveChain): the terminal MANY of leaf nodes is the
// TARGET (the content being asked about), the interior nodes are the THREAD (prior
// Q&A / derivation history), and this block is the ACTION. Each node self-describes
// through the registry (BuildContextForID), so dispatch stays kind-agnostic.
func (p *AIBlockProcessor) RunJob(jctx block.JobContext) error {
	blk := jctx.Block
	ref, _ := blk.Attrs["ref"].(string)
	blockType, _ := blk.Attrs["type"].(string)

	targets, threadIDs := p.resolveChain(blk.ID, ref, jctx.Doc)

	// TARGET: the terminal MANY, each member rendered and grouped.
	content := p.buildTargets(targets, jctx.Doc)

	// THREAD: the interior nodes, oldest-first, each as its own Q&A entry.
	seen := map[string]bool{blk.ID: true}
	var historyParts []string
	for _, id := range threadIDs {
		if ctx := block.BuildContextForID(id, jctx.Doc, seen); ctx != "" {
			historyParts = append(historyParts, ctx)
		}
	}
	history := strings.Join(historyParts, "\n\n---\n\n")

	// ACTION: this block's own question.
	questionCtx := p.BuildContext(*blk, jctx.Doc, map[string]bool{})

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
