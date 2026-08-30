package ai

import (
	"fmt"
	"strings"
	"time"

	"sieve/ident"
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
	question := c.question(text, ctx.Body)
	if len(question) == 0 {
		return command.Job{}, fmt.Errorf("usage: /btw <question>")
	}
	prompt := question.Markdown()
	attrs := map[string]interface{}{
		"status":    "PENDING",
		"createdAt": time.Now().UTC().Format(time.RFC3339),
		"question":  question.AttrValue(),
		"type":      "BTW",
		"ref":       "", // detached: no target graph
	}
	// What the turn was given, recorded on the block from the PENDING envelope
	// onward: it is what renders the chip row (in the document and in the popup,
	// which hosts the same renderer) and what a later read of the block shows.
	ctx.Attachments.StampAttrs(attrs)
	pending := &command.Block{Kind: "ai-block", Attrs: attrs}
	return command.Job{
		Label:   c.label(prompt),
		Pending: pending,
		Work: func() (command.Block, error) {
			title, summary := c.docMeta(ctx.DocUUID)
			resp, err := c.ai.RunBtw(ctx.Attachments.AppendTo(prompt), ctx.SelectedText, title, summary, ctx.DocUUID)
			if err != nil {
				return command.Block{}, err
			}
			return c.complete(attrs, resp), nil
		},
	}, nil
}

// question picks the turn's question from the envelope's two projections of
// the one message: the block form verbatim when it was sent — every element
// keeping the id it arrived with, because an authored block's id travels —
// else the text form as a single minted prose element (a popup block enters
// no document, so it passes no door that would mint one).
//
// The list is EMPTY only when the turn carried neither, which is the one thing
// /btw refuses.
func (c *BtwCommand) question(text string, body command.Blocks) command.Blocks {
	if len(body) > 0 {
		return body
	}
	if trimmed := strings.TrimSpace(text); trimmed != "" {
		return command.Blocks{{Kind: "prose", Attrs: map[string]interface{}{
			"id":      ident.New(),
			"content": trimmed,
		}}}
	}
	return nil
}

// label names the job in the job list: the question's text on one line, cut to
// forty runes.
func (c *BtwCommand) label(text string) string {
	r := []rune(strings.Join(strings.Fields(text), " "))
	if len(r) > 40 {
		return "/btw " + string(r[:40]) + "…"
	}
	return "/btw " + string(r)
}
