package ai

import (
	"fmt"
	"strings"
	"time"

	"sieve/sieve/command"
	"sieve/sieve/domain"
	"sieve/sieve/services"
)

type SummaryCommand struct {
	ai *AIService
	docMetaReader
}

func NewSummaryCommand(aiSvc *AIService, docs *services.DocumentService) *SummaryCommand {
	return &SummaryCommand{ai: aiSvc, docMetaReader: docMetaReader{docs: docs}}
}

func (c *SummaryCommand) Name() string        { return "summary" }
func (c *SummaryCommand) Description() string { return "3-bullet summary of document or selection" }
func (c *SummaryCommand) Family() string      { return command.FamilyAI }
func (c *SummaryCommand) ResultKind() string  { return "ai-block" }

func (c *SummaryCommand) Build(text string, ctx command.Context) (command.Job, error) {
	if c.ai == nil || c.ai.Tier() == domain.TierDumb {
		return command.Job{}, fmt.Errorf("AI commands are unavailable — configure an AI CLI in Settings")
	}
	attrs := map[string]interface{}{
		"status":    "PENDING",
		"createdAt": time.Now().UTC().Format(time.RFC3339),
		"question":  "Document Summary (/summary)",
		"type":      "SUMMARY",
		"ref":       "",
	}
	pending := &command.Block{Kind: "ai-block", Attrs: attrs}
	return command.Job{
		Label:   "/summary",
		Pending: pending,
		Work: func() (command.Block, error) {
			title, summary := c.docMeta(ctx.DocUUID)
			prompt := "Summarize the provided text or document in 3 concise, impactful Markdown bullet points. Keep it clear, direct, and factual. No intro preamble or concluding questions."
			if strings.TrimSpace(text) != "" {
				prompt += "\n\nSpecific focus from user: " + text
			}
			resp, err := c.ai.RunBtw(prompt, ctx.SelectedText, title, summary, ctx.DocUUID)
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
