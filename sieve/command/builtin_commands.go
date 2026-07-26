package command

import (
	"fmt"
	"strings"
	"time"

	"sieve/sieve/services"
)

// NowCommand — instant system timestamp and date in all standard formats.
type NowCommand struct{}

func NewNowCommand() *NowCommand {
	return &NowCommand{}
}

func (c *NowCommand) Name() string        { return "now" }
func (c *NowCommand) Description() string { return "Display current timestamp & date in all standard formats" }
func (c *NowCommand) Family() string      { return FamilyUtil }
func (c *NowCommand) ResultKind() string  { return "command-result" }

func (c *NowCommand) Build(text string, ctx Context) (Job, error) {
	now := time.Now()
	createdAt := now.UTC().Format(time.RFC3339)

	return Job{
		Label:   "/now",
		Pending: nil,
		Work: func() (Block, error) {
			utc := now.UTC()
			unixSec := now.Unix()
			unixMs := now.UnixMilli()

			resp := strings.Join([]string{
				"| Format | Value |",
				"| :--- | :--- |",
				fmt.Sprintf("| **UNIX Timestamp (s)** | `%d` |", unixSec),
				fmt.Sprintf("| **UNIX Timestamp (ms)** | `%d` |", unixMs),
				fmt.Sprintf("| **ISO 8601 / RFC 3339 (Local)** | `%s` |", now.Format(time.RFC3339)),
				fmt.Sprintf("| **ISO 8601 / RFC 3339 (UTC)** | `%s` |", utc.Format(time.RFC3339)),
				fmt.Sprintf("| **Local Date & Time** | `%s` |", now.Format("Monday, January 2, 2006 at 3:04:05 PM MST")),
				fmt.Sprintf("| **UTC Date & Time** | `%s` |", utc.Format("Monday, January 2, 2006 at 3:04:05 PM MST")),
				fmt.Sprintf("| **Date Only** | `%s` |", now.Format("2006-01-02")),
				fmt.Sprintf("| **Time Only (Local)** | `%s` |", now.Format("15:04:05")),
			}, "\n")

			return Block{Kind: "command-result", Attrs: map[string]interface{}{
				"cmd":         "now",
				"status":      "COMPLETE",
				"title":       "🕒 Current Date & Time",
				"response":    resp,
				"primary":     utc.Format(time.RFC3339),
				"createdAt":   createdAt,
				"completedAt": time.Now().UTC().Format(time.RFC3339),
			}}, nil
		},
	}, nil
}

// StatsCommand — instant word count, character count, reading time & document metrics.
type StatsCommand struct {
	docs *services.DocumentService
}

func NewStatsCommand(docs *services.DocumentService) *StatsCommand {
	return &StatsCommand{docs: docs}
}

func (c *StatsCommand) Name() string        { return "stats" }
func (c *StatsCommand) Description() string { return "Word count, character count, reading time & document metrics" }
func (c *StatsCommand) Family() string      { return FamilyUtil }
func (c *StatsCommand) ResultKind() string  { return "command-result" }

func (c *StatsCommand) Build(text string, ctx Context) (Job, error) {
	createdAt := time.Now().UTC().Format(time.RFC3339)

	return Job{
		Label:   "/stats",
		Pending: nil,
		Work: func() (Block, error) {
			var scope string
			var content string
			var docTitle string

			if strings.TrimSpace(ctx.SelectedText) != "" {
				scope = "Selected Text"
				content = ctx.SelectedText
			} else if ctx.DocUUID != "" && c.docs != nil {
				scope = "Current Document"
				if doc, err := c.docs.LoadByUUID(ctx.DocUUID); err == nil {
					docTitle = doc.Meta().DisplayName()
					content = string(doc.Body())
				}
			}

			if strings.TrimSpace(content) == "" {
				content = text
				scope = "Input Text"
			}

			words := len(strings.Fields(content))
			charsTotal := len([]rune(content))
			charsNoSpaces := len([]rune(strings.ReplaceAll(strings.ReplaceAll(strings.ReplaceAll(content, " ", ""), "\t", ""), "\n", "")))
			lines := len(strings.Split(content, "\n"))

			readingTimeMin := (words + 199) / 200
			if readingTimeMin == 0 && words > 0 {
				readingTimeMin = 1
			}

			title := "📊 Document Metrics"
			if docTitle != "" {
				title = fmt.Sprintf("📊 Metrics for *%s*", docTitle)
			}

			resp := strings.Join([]string{
				fmt.Sprintf("*Scope: %s*", scope),
				"",
				"| Metric | Count |",
				"| :--- | :--- |",
				fmt.Sprintf("| **Words** | `%d` |", words),
				fmt.Sprintf("| **Characters (total)** | `%d` |", charsTotal),
				fmt.Sprintf("| **Characters (no spaces)** | `%d` |", charsNoSpaces),
				fmt.Sprintf("| **Lines** | `%d` |", lines),
				fmt.Sprintf("| **Est. Reading Time** | `~%d min` |", readingTimeMin),
			}, "\n")

			// No single "answer" value for /stats — omit primary; the popup's Copy
			// falls back to the rendered markdown metrics table.
			return Block{Kind: "command-result", Attrs: map[string]interface{}{
				"cmd":         "stats",
				"status":      "COMPLETE",
				"title":       title,
				"response":    resp,
				"createdAt":   createdAt,
				"completedAt": time.Now().UTC().Format(time.RFC3339),
			}}, nil
		},
	}, nil
}
