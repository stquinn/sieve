package sieve

import (
	"regexp"
	"strings"
	"time"
)

// logDetectRe looks for standard log indicators: [ERROR], ISO timestamps, "Exception", "stack trace", etc.
var logDetectRe = regexp.MustCompile(`(?i)(?:\[(?:error|fatal|exception|warn|info|debug)\]|\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}|Exception|Stack Trace:)`)

type LogProcessor struct{ svc BlockServices }

func NewLogProcessor(svc BlockServices) *LogProcessor {
	return &LogProcessor{svc: svc}
}

func (p *LogProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":                id,
		"status":            BlockStatusComplete,
		"source":            "",
		"language":          "log",
		"createdAt":         time.Now().UTC().Format(time.RFC3339),
		"supportsEmbedding": true,
	}
	for k, v := range overrides {
		if k == "id" {
			continue
		}
		attrs[k] = v
	}
	return attrs
}

func (p *LogProcessor) IsBlock(entries []ContentEntry) bool {
	for _, e := range entries {
		// Native Sieve Log block
		if e.MIMEType == "sieve/log" {
			return true
		}
		// Code block with language "log" or matching heuristics
		if e.MIMEType == "sieve/code" && strings.TrimSpace(e.Content) != "" {
			block := ParseFirstBlock(e.Content)
			if block != nil {
				if block.Attrs["language"] == "log" && strings.TrimSpace(block.Attrs["source"].(string)) != "" {
					return true
				}
				source, _ := block.Attrs["source"].(string)
				if strings.TrimSpace(source) != "" && logDetectRe.MatchString(source) {
					return true
				}
			}
		}
		// Raw text that looks like a log
		if e.MIMEType == "text/plain" {
			trimmed := strings.TrimSpace(e.Content)
			if trimmed != "" && logDetectRe.MatchString(trimmed) {
				return true
			}
		}
	}
	return false
}

func (p *LogProcessor) Transform(entries []ContentEntry, uuid string, blockID string) map[string]interface{} {
	for _, e := range entries {
		if e.MIMEType == "sieve/log" {
			block := ParseFirstBlock(e.Content)
			if block != nil {
				return map[string]interface{}{
					"source": strings.TrimSpace(block.Attrs["source"].(string)),
				}
			}
		}
		if e.MIMEType == "sieve/code" && strings.TrimSpace(e.Content) != "" {
			block := ParseFirstBlock(e.Content)
			if block != nil {
				if block.Attrs["language"] == "log" && strings.TrimSpace(block.Attrs["source"].(string)) != "" {
					return map[string]interface{}{
						"source": strings.TrimSpace(block.Attrs["source"].(string)),
					}
				}
				source, _ := block.Attrs["source"].(string)
				trimmed := strings.TrimSpace(source)
				if trimmed != "" && logDetectRe.MatchString(trimmed) {
					return map[string]interface{}{
						"source": trimmed,
					}
				}
			}
		}
		if e.MIMEType == "text/plain" {
			trimmed := strings.TrimSpace(e.Content)
			if trimmed != "" && logDetectRe.MatchString(trimmed) {
				return map[string]interface{}{"source": trimmed}
			}
		}
	}
	return nil
}

func (p *LogProcessor) OnChange(_ *SieveBlock) {}

func (p *LogProcessor) BuildContext(block SieveBlock, _ ShadowDocument, seen map[string]bool) string {
	src, _ := block.Attrs["source"].(string)
	if strings.TrimSpace(src) == "" {
		return ""
	}
	return "NODE ID: " + block.ID + "\n\n```log\n" + src + "\n```"
}

func (p *LogProcessor) JobLabel(_ *SieveBlock) string { return "" }

func (p *LogProcessor) Mode() BlockMode {
	return BlockModeBlock
}

func (p *LogProcessor) RunJob(jctx JobContext) error {
	jctx.Block.Attrs["status"] = BlockStatusComplete
	return nil
}

func (p *LogProcessor) MarkdownRepresentation(block SieveBlock) string {
	source, _ := block.Attrs["source"].(string)
	source = strings.TrimSpace(source)
	if source == "" {
		return ""
	}
	fence := getFence(source) // Reusing the package-level getFence from code_processor.go
	return fence + "log\n" + source + "\n" + fence
}
