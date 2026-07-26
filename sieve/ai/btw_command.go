package ai

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"sieve/sieve/command"
	"sieve/sieve/domain"
	"sieve/sieve/services"
)

// BtwCommand — the first standalone AI command (#55): a detached ai-block
// built through the normal processor shape; never enters any ShadowDoc.
// Stateless singleton: immutable deps only; per-request state lives in
// Build's args and the Job closures.
type BtwCommand struct {
	ai   *AIService
	docs *services.DocumentService
}

func NewBtwCommand(aiSvc *AIService, docs *services.DocumentService) *BtwCommand {
	return &BtwCommand{ai: aiSvc, docs: docs}
}

func (c *BtwCommand) Name() string        { return "btw" }
func (c *BtwCommand) Description() string { return "Quick answer in a popup — nothing is added to the document" }

func (c *BtwCommand) Build(text string, ctx command.Context) (command.Job, error) {
	// THIS command needs the AI CLI — its precondition, checked here, not by
	// the dispatcher (a non-AI command would check something else or nothing).
	if c.ai == nil || c.ai.Tier() == domain.TierDumb {
		return command.Job{}, fmt.Errorf("AI commands are unavailable — configure an AI CLI in Settings")
	}
	if strings.TrimSpace(text) == "" {
		return command.Job{}, fmt.Errorf("usage: /btw <question>")
	}
	id := generateAIBlockID()
	attrs := map[string]interface{}{
		"id":        id,
		"status":    "PENDING",
		"createdAt": time.Now().UTC().Format(time.RFC3339),
		"question":  text,
		"type":      "BTW",
		"ref":       "", // detached: no target graph
	}
	pending := &command.Block{Kind: "ai-block", Attrs: attrs}
	return command.Job{
		Label:   c.label(text),
		Pending: pending,
		Work: func() (command.Block, error) {
			title, summary := c.docMeta(ctx.DocUUID)
			resp, err := c.ai.RunBtw(text, ctx.SelectedText, title, summary, ctx.DocUUID)
			if err != nil {
				return command.Block{}, err
			}
			done := make(map[string]interface{}, len(attrs)+3)
			for k, v := range attrs {
				done[k] = v
			}
			done["status"] = "COMPLETE"
			done["response"] = resp
			done["completedAt"] = time.Now().UTC().Format(time.RFC3339)
			return command.Block{Kind: "ai-block", Attrs: done}, nil
		},
	}, nil
}

// docMeta reads title+summary from disk meta ONLY (LoadByUUID resolves buffers
// too; accepted staleness = the autosave debounce). Every field optional.
func (c *BtwCommand) docMeta(uuid string) (title, summary string) {
	if uuid == "" || c.docs == nil {
		return "", ""
	}
	doc, err := c.docs.LoadByUUID(uuid)
	if err != nil {
		return "", ""
	}
	m := doc.Meta()
	title = m.DisplayName()
	if s := m.Summary(); s != nil {
		summary = *s
	}
	return title, summary
}

func (c *BtwCommand) label(text string) string {
	r := []rune(text)
	if len(r) > 40 {
		return "/btw " + string(r[:40]) + "…"
	}
	return "/btw " + text
}

func generateAIBlockID() string {
	b := make([]byte, 2)
	_, _ = rand.Read(b)
	return "ai-" + hex.EncodeToString(b)
}
