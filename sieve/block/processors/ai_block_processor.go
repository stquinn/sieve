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

func (p *AIBlockProcessor) Kind() string { return p.FencedDeserializer.Kind }

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

// most basic version we can do
func (p *AIBlockProcessor) IsSupportedContent(entries []block.ContentEntry) block.SupportedActions {
	for _, e := range entries {
		if e.IsSieveType(p) {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionExtract}}
		}
	}
	return block.SupportedActions{Kind: p.Kind()}
}

// most basic version we can do - just copy the block with a new id
func (p *AIBlockProcessor) Transform(entries []block.ContentEntry, uuid, blockID string, action block.Action) map[string]interface{} {
	for _, e := range entries {
		if e.IsSieveType(p) {
			return e.AsAttrsForNewBlock(p)
		}
	}
	return nil
}

func (p *AIBlockProcessor) OnChange(blk *block.SieveBlock) {}

// aiBlockLabel is the in-flight status label for an ai-block job.
func (p *AIBlockProcessor) aiBlockLabel(blk *block.SieveBlock) string {
	if t, _ := blk.Attrs["type"].(string); t == "EXPLAIN" {
		return "Explaining…"
	}
	return "Asking AI…"
}

// BuildContext returns a Q&A summary for when this block appears in another block's
// ref chain. The NODE ID header is rendered by AIContext.String (from NodeIDs); the
// QUESTION ABOUT / EXPLAIN NODE line stays in Content because it is a header before
// the Q&A, not a mergeable trailer.
func (p *AIBlockProcessor) BuildContext(blk block.SieveBlock, doc block.DocView, seen map[string]bool) block.AIContext {
	q, _ := blk.Attrs["question"].(string)
	r, _ := blk.Attrs["response"].(string)
	t, _ := blk.Attrs["type"].(string)

	var sb strings.Builder
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

	return block.AIContext{NodeIDs: []string{blk.ID}, Content: sb.String()}
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

// buildTargets renders the terminal MANY by asking each member block for its
// AIContext (BuildContextForID) and MERGING them into one — node ids concat into a
// single header, contents append, and the "Specifically regarding" trailers union
// into ONE focus line. Type-agnostic: a multi-block selection, a single block, or
// "doc" all merge the same way; empty contexts drop out.
func (p *AIBlockProcessor) buildTargets(targets []string, doc block.DocView) string {
	var ctxs []block.AIContext
	for _, id := range targets {
		if c := block.BuildContextForID(id, doc, map[string]bool{}); !c.IsEmpty() {
			ctxs = append(ctxs, c)
		}
	}
	return block.MergeContexts(ctxs).String()
}

// DescribeJob builds the prompt by walking this block's point-to-point ref graph and
// splitting it by GEOMETRY (resolveChain): the terminal MANY of leaf nodes is the
// TARGET (the content being asked about), the interior nodes are the THREAD (prior
// Q&A / derivation history), and this block is the ACTION. Each node self-describes
// through the registry (BuildContextForID), so dispatch stays kind-agnostic. The
// prompt is assembled synchronously here (it needs the immutable jctx.Doc snapshot),
// then captured by Work; Apply writes the success attrs. An ai-block always has
// async work (born PENDING), so DescribeJob never returns nil. The error path
// (status ERROR/TIMEOUT) is the framework's job in EditorService.finish, so Apply
// is success-only.
func (p *AIBlockProcessor) DescribeJob(jctx block.JobContext) *block.ProcessorJob {
	blk := jctx.Block
	uuid := jctx.UUID
	ref, _ := blk.Attrs["ref"].(string)
	blockType, _ := blk.Attrs["type"].(string)

	targets, threadIDs := p.resolveChain(blk.ID, ref, jctx.Doc)

	// TARGET: the terminal MANY, each member rendered and grouped.
	content := p.buildTargets(targets, jctx.Doc)

	// THREAD: the interior nodes, oldest-first, each rendered as its own Q&A entry
	// (NOT merged — distinct entries, each keeping its own trailer).
	seen := map[string]bool{blk.ID: true}
	var historyParts []string
	for _, id := range threadIDs {
		if ctx := block.BuildContextForID(id, jctx.Doc, seen); !ctx.IsEmpty() {
			historyParts = append(historyParts, ctx.String())
		}
	}
	history := strings.Join(historyParts, "\n\n---\n\n")

	// ACTION: this block's own question.
	questionCtx := p.BuildContext(*blk, jctx.Doc, map[string]bool{}).String()

	isExplain := blockType == "EXPLAIN"
	return &block.ProcessorJob{
		Category: block.CategoryAI,
		Label:    p.aiBlockLabel(blk),
		Work: func() (any, error) {
			if isExplain {
				return p.svc.AI.RunExplain(content, history, questionCtx, uuid)
			}
			return p.svc.AI.RunAsk(content, history, questionCtx, uuid)
		},
		Apply: func(result any, b *block.SieveBlock) {
			b.Attrs["status"] = block.BlockStatusComplete
			b.Attrs["response"] = result.(string)
			b.Attrs["completedAt"] = time.Now().UTC().Format(time.RFC3339)
		},
	}
}

func (p *AIBlockProcessor) MarkdownRepresentation(blk block.SieveBlock, _ string) string {
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
