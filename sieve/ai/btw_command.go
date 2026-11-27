package ai

import (
	"fmt"
	"strings"

	"sieve/ident"
	"sieve/sieve/command"
	"sieve/sieve/services"
)

// BtwCommand — the first standalone AI command (#55): a detached ai-block
// built through the normal processor shape; never enters any ShadowDoc.
// Stateless singleton: immutable deps only; per-request state lives in
// Build's args and the Job closures.
type BtwCommand struct {
	popupAnswer
}

func NewBtwCommand(aiSvc *AIService, docs *services.DocumentService) *BtwCommand {
	return &BtwCommand{popupAnswer: newPopupAnswer(aiSvc, docs)}
}

func (c *BtwCommand) Name() string        { return "btw" }
func (c *BtwCommand) Description() string { return "Quick answer in a popup — nothing is added to the document" }
func (c *BtwCommand) Family() string      { return command.FamilyAI }
func (c *BtwCommand) ResultKind() string  { return "ai-block" }

func (c *BtwCommand) Build(text string, ctx command.Context) (command.Job, error) {
	if err := c.available(); err != nil {
		return command.Job{}, err
	}
	question := c.question(text, ctx.Body)
	if len(question) == 0 {
		return command.Job{}, fmt.Errorf("usage: /btw <question>")
	}
	prompt := question.Markdown()
	return c.job(c.label(prompt), "BTW", question.AttrValue(), prompt, ctx), nil
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
