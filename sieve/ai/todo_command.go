package ai

import (
	"fmt"
	"strings"
	"time"

	"sieve/sieve/command"
	"sieve/sieve/domain"
	"sieve/sieve/services"
)

type TodoCommand struct {
	ai *AIService
	docMetaReader
}

func NewTodoCommand(aiSvc *AIService, docs *services.DocumentService) *TodoCommand {
	return &TodoCommand{ai: aiSvc, docMetaReader: docMetaReader{docs: docs}}
}

func (c *TodoCommand) Name() string        { return "todo" }
func (c *TodoCommand) Description() string { return "Extract open action items, TODOs, and decisions as a checklist" }
func (c *TodoCommand) Family() string      { return command.FamilyAI }
func (c *TodoCommand) ResultKind() string  { return "ai-block" }

func (c *TodoCommand) Build(text string, ctx command.Context) (command.Job, error) {
	if c.ai == nil || c.ai.Tier() == domain.TierDumb {
		return command.Job{}, fmt.Errorf("AI commands are unavailable — configure an AI CLI in Settings")
	}
	attrs := map[string]interface{}{
		"status":    "PENDING",
		"createdAt": time.Now().UTC().Format(time.RFC3339),
		"question":  "Extracted Action Items (/todo)",
		"type":      "TODO",
		"ref":       "",
	}
	pending := &command.Block{Kind: "ai-block", Attrs: attrs}
	return command.Job{
		Label:   "/todo",
		Pending: pending,
		Work: func() (command.Block, error) {
			title, summary := c.docMeta(ctx.DocUUID)
			prompt := "Scan the provided text or document and extract all open TODOs, action items, tasks, and key decisions. Format as a clean Markdown checklist using '- [ ]'. If no explicit tasks exist, infer 3-5 logical next action steps. Keep it direct with no preamble."
			if strings.TrimSpace(text) != "" {
				prompt += "\n\nUser request filter: " + text
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
