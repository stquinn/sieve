package ai

import (
	"strings"

	"sieve/sieve/command"
	"sieve/sieve/services"
)

type TodoCommand struct {
	popupAnswer
}

func NewTodoCommand(aiSvc *AIService, docs *services.DocumentService) *TodoCommand {
	return &TodoCommand{popupAnswer: newPopupAnswer(aiSvc, docs)}
}

func (c *TodoCommand) Name() string        { return "todo" }
func (c *TodoCommand) Description() string { return "Extract open action items, TODOs, and decisions as a checklist" }
func (c *TodoCommand) Family() string      { return command.FamilyAI }
func (c *TodoCommand) ResultKind() string  { return "ai-block" }

func (c *TodoCommand) Build(text string, ctx command.Context) (command.Job, error) {
	if err := c.available(); err != nil {
		return command.Job{}, err
	}
	if err := c.readsDocument(c.Name(), ctx); err != nil {
		return command.Job{}, err
	}
	prompt := "Scan the provided text or document and extract all open TODOs, action items, tasks, and key decisions. Format as a clean Markdown checklist using '- [ ]'. If no explicit tasks exist, infer 3-5 logical next action steps. Keep it direct with no preamble."
	if strings.TrimSpace(text) != "" {
		prompt += "\n\nUser request filter: " + text
	}
	return c.job("/todo", "TODO", "Extracted Action Items (/todo)", prompt, ctx), nil
}
