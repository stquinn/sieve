package ai

import (
	"strings"

	"sieve/sieve/command"
	"sieve/sieve/services"
)

type SummaryCommand struct {
	popupAnswer
}

func NewSummaryCommand(aiSvc *AIService, docs *services.DocumentService) *SummaryCommand {
	return &SummaryCommand{popupAnswer: newPopupAnswer(aiSvc, docs)}
}

func (c *SummaryCommand) Name() string        { return "summary" }
func (c *SummaryCommand) Description() string { return "3-bullet summary of document or selection" }
func (c *SummaryCommand) Family() string      { return command.FamilyAI }
func (c *SummaryCommand) ResultKind() string  { return "ai-block" }

func (c *SummaryCommand) Build(text string, ctx command.Context) (command.Job, error) {
	if err := c.available(); err != nil {
		return command.Job{}, err
	}
	if err := c.readsDocument(c.Name(), ctx); err != nil {
		return command.Job{}, err
	}
	prompt := "Summarize the provided text or document in 3 concise, impactful Markdown bullet points. Keep it clear, direct, and factual. No intro preamble or concluding questions."
	if strings.TrimSpace(text) != "" {
		prompt += "\n\nSpecific focus from user: " + text
	}
	return c.job("/summary", "SUMMARY", "Document Summary (/summary)", prompt, ctx), nil
}
