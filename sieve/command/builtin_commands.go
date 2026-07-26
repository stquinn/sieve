package command

import (
	"crypto/rand"
	"encoding/hex"
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

func (c *NowCommand) Build(text string, ctx Context) (Job, error) {
	now := time.Now()
	id := generateBuiltinBlockID()
	attrs := map[string]interface{}{
		"id":        id,
		"status":    "PENDING",
		"createdAt": now.UTC().Format(time.RFC3339),
		"question":  "Current Time & Date (/now)",
		"type":      "NOW",
		"ref":       "",
	}
	pending := &Block{Kind: "ai-block", Attrs: attrs}

	return Job{
		Label:   "/now",
		Pending: pending,
		Work: func() (Block, error) {
			utc := now.UTC()
			unixSec := now.Unix()
			unixMs := now.UnixMilli()

			resp := strings.Join([]string{
				"### 🕒 Current Date & Time (`/now`)",
				"",
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

			done := make(map[string]interface{}, len(attrs)+3)
			for k, v := range attrs {
				done[k] = v
			}
			done["status"] = "COMPLETE"
			done["response"] = resp
			done["completedAt"] = time.Now().UTC().Format(time.RFC3339)
			return Block{Kind: "ai-block", Attrs: done}, nil
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

func (c *StatsCommand) Build(text string, ctx Context) (Job, error) {
	id := generateBuiltinBlockID()
	attrs := map[string]interface{}{
		"id":        id,
		"status":    "PENDING",
		"createdAt": time.Now().UTC().Format(time.RFC3339),
		"question":  "Document & Selection Stats (/stats)",
		"type":      "STATS",
		"ref":       "",
	}
	pending := &Block{Kind: "ai-block", Attrs: attrs}

	return Job{
		Label:   "/stats",
		Pending: pending,
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

			header := "### 📊 Document Metrics (`/stats`)"
			if docTitle != "" {
				header = fmt.Sprintf("### 📊 Metrics for *%s* (`/stats`)", docTitle)
			}

			resp := strings.Join([]string{
				header,
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

			done := make(map[string]interface{}, len(attrs)+3)
			for k, v := range attrs {
				done[k] = v
			}
			done["status"] = "COMPLETE"
			done["response"] = resp
			done["completedAt"] = time.Now().UTC().Format(time.RFC3339)
			return Block{Kind: "ai-block", Attrs: done}, nil
		},
	}, nil
}

func generateBuiltinBlockID() string {
	b := make([]byte, 2)
	_, _ = rand.Read(b)
	return "cmd-" + hex.EncodeToString(b)
}
