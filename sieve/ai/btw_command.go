package ai

import (
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
	ai *AIService
	docMetaReader
	popupAnswer
}

func NewBtwCommand(aiSvc *AIService, docs *services.DocumentService) *BtwCommand {
	return &BtwCommand{ai: aiSvc, docMetaReader: docMetaReader{docs: docs}}
}

func (c *BtwCommand) Name() string        { return "btw" }
func (c *BtwCommand) Description() string { return "Quick answer in a popup — nothing is added to the document" }
func (c *BtwCommand) Family() string      { return command.FamilyAI }
func (c *BtwCommand) ResultKind() string  { return "ai-block" }

func (c *BtwCommand) Build(text string, ctx command.Context) (command.Job, error) {
	// THIS command needs the AI CLI — its precondition, checked here, not by
	// the dispatcher (a non-AI command would check something else or nothing).
	if c.ai == nil || c.ai.Tier() == domain.TierDumb {
		return command.Job{}, fmt.Errorf("AI commands are unavailable — configure an AI CLI in Settings")
	}
	if strings.TrimSpace(text) == "" {
		return command.Job{}, fmt.Errorf("usage: /btw <question>")
	}
	attrs := map[string]interface{}{
		"status":    "PENDING",
		"createdAt": time.Now().UTC().Format(time.RFC3339),
		"question":  text,
		"type":      "BTW",
		"ref":       "", // detached: no target graph
	}
	// What the turn was given, recorded on the block from the PENDING envelope
	// onward: it is what renders the chip row (in the document and in the popup,
	// which hosts the same renderer) and what a later read of the block shows.
	ctx.Attachments.StampAttrs(attrs)
	pending := &command.Block{Kind: "ai-block", Attrs: attrs}
	return command.Job{
		Label:   c.label(text),
		Pending: pending,
		Work: func() (command.Block, error) {
			title, summary := c.docMeta(ctx.DocUUID)
			resp, err := c.ai.RunBtw(ctx.Attachments.AppendTo(text), ctx.SelectedText, title, summary, ctx.DocUUID)
			if err != nil {
				return command.Block{}, err
			}
			return c.complete(attrs, resp), nil
		},
	}, nil
}

func (c *BtwCommand) label(text string) string {
	r := []rune(text)
	if len(r) > 40 {
		return "/btw " + string(r[:40]) + "…"
	}
	return "/btw " + text
}
