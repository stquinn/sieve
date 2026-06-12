package sieve

import (
	"encoding/json"
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
				source, _ := block.Attrs["source"].(string)
				if block.Attrs["language"] == "log" && strings.TrimSpace(source) != "" {
					return true
				}
				if strings.TrimSpace(source) != "" && logDetectRe.MatchString(source) {
					return true
				}
			} else if logDetectRe.MatchString(e.Content) {
				return true
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
				source, _ := block.Attrs["source"].(string)
				return map[string]interface{}{"source": strings.TrimSpace(source)}
			}
		}
		if e.MIMEType == "sieve/code" && strings.TrimSpace(e.Content) != "" {
			block := ParseFirstBlock(e.Content)
			if block != nil {
				source, _ := block.Attrs["source"].(string)
				trimmed := strings.TrimSpace(source)
				if block.Attrs["language"] == "log" && trimmed != "" {
					return map[string]interface{}{"source": trimmed}
				}
				if trimmed != "" && logDetectRe.MatchString(trimmed) {
					return map[string]interface{}{"source": trimmed}
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

type LogLineData struct {
	LineNumber int    `json:"lineNumber"`
	Date       string `json:"date,omitempty"`
	Level      string `json:"level,omitempty"`
	Thread     string `json:"thread,omitempty"`
	Logger     string `json:"logger,omitempty"`
	Message    string `json:"message"`
	Severity   string `json:"severity"` // "info", "warn", "error", "none"
	Raw        string `json:"raw"`
}

type ParsedLogData struct {
	Format string        `json:"format"`
	Lines  []LogLineData `json:"lines"`
}

var springBootRe = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)\s+(\w+)\s+(.*?)\s+---\s+\[(.*?)\]\s+(.*?)\s+:\s+(.*)$`)
var homeAssistantRe = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}\.\d{3})\s+([A-Z]+)\s+\((.*?)\)\s+\[(.*?)\]\s+(.*)$`)

// Fallback-sniffing regexes, compiled once (were previously recompiled per line).
var (
	logBracketRe   = regexp.MustCompile(`\[(.*?)\]`)
	logDateInnerRe = regexp.MustCompile(`\d{4}|\d{2}:\d{2}`)
	logLevelRe     = regexp.MustCompile(`\b(ERROR|WARN|WARNING|INFO|DEBUG|TRACE|FATAL)\b`)
	logLoggerRe    = regexp.MustCompile(`\b([a-zA-Z0-9_]+\.[a-zA-Z0-9_\.]+)\s*:|\b([A-Z][a-zA-Z0-9_]+(?:Service|Controller|Manager|Repository|Engine|Handler|Control|Processor))\s*:`)
)

func parseLogLines(source string) ParsedLogData {
	lines := strings.Split(source, "\n")
	parsed := ParsedLogData{
		Format: "generic",
		Lines:  make([]LogLineData, 0, len(lines)),
	}

	for i, line := range lines {
		line = strings.TrimRight(line, "\r")
		trimmedLine := strings.TrimSpace(line)
		data := LogLineData{
			LineNumber: i + 1,
			Raw:        line,
			Message:    line,
			Severity:   "none",
		}

		// 0. Try JSON Log Sniffing
		if strings.HasPrefix(trimmedLine, "{") && strings.HasSuffix(trimmedLine, "}") {
			var j map[string]interface{}
			if err := json.Unmarshal([]byte(trimmedLine), &j); err == nil {
				parsed.Format = "json"
				
				// Extract Level
				if v, ok := j["level"].(string); ok { data.Level = v }
				if v, ok := j["severity"].(string); ok && data.Level == "" { data.Level = v }
				
				// Extract Date
				if v, ok := j["time"].(string); ok { data.Date = v }
				if v, ok := j["timestamp"].(string); ok && data.Date == "" { data.Date = v }
				if v, ok := j["@timestamp"].(string); ok && data.Date == "" { data.Date = v }
				
				// Extract Logger/Thread
				if v, ok := j["logger"].(string); ok { data.Logger = v }
				if v, ok := j["thread"].(string); ok { data.Thread = v }
				
				// Extract Message
				if v, ok := j["message"].(string); ok { data.Message = v }
				if v, ok := j["msg"].(string); ok && data.Message == line { data.Message = v }
				
				data.Severity = mapLevelToSeverity(data.Level)
				parsed.Lines = append(parsed.Lines, data)
				continue
			}
		}

		// 1. Try Custom Regex if provided (not implemented in this stub yet, assuming fallback)
		// 2. Try strict Spring Boot format
		if m := springBootRe.FindStringSubmatch(line); m != nil {
			parsed.Format = "spring-boot"
			data.Date = m[1]
			data.Level = strings.ToUpper(m[2])
			data.Thread = strings.TrimSpace(m[4])
			data.Logger = strings.TrimSpace(m[5])
			data.Message = m[6]
			data.Severity = mapLevelToSeverity(data.Level)
			parsed.Lines = append(parsed.Lines, data)
			continue
		}

		// 2.5 Try strict Home Assistant format
		if m := homeAssistantRe.FindStringSubmatch(line); m != nil {
			parsed.Format = "home-assistant"
			data.Date = m[1]
			data.Level = strings.ToUpper(m[2])
			data.Thread = strings.TrimSpace(m[3])
			data.Logger = strings.TrimSpace(m[4])
			data.Message = m[5]
			data.Severity = mapLevelToSeverity(data.Level)
			parsed.Lines = append(parsed.Lines, data)
			continue
		}

		// 3. Fallback Heuristic Sniffing
		remaining := line
		
		// Sniff Go logfmt (level=INFO msg="..." etc)
		if strings.Contains(remaining, "level=") || strings.Contains(remaining, "time=") {
			// very naive logfmt sniffing
			if strings.Contains(remaining, "level=WARN") { data.Level = "WARN" }
			if strings.Contains(remaining, "level=ERROR") { data.Level = "ERROR" }
			if strings.Contains(remaining, "level=INFO") { data.Level = "INFO" }
			if strings.Contains(remaining, "level=DEBUG") { data.Level = "DEBUG" }
			data.Severity = mapLevelToSeverity(data.Level)
		}

		// Sniff Bracketed components (Threads, Apache Dates, bracketed Levels)
		matches := logBracketRe.FindAllStringSubmatch(remaining, -1)
		for _, match := range matches {
			inner := match[1]
			// Is it a level?
			upper := strings.ToUpper(inner)
			if upper == "INFO" || upper == "ERROR" || upper == "WARN" || upper == "DEBUG" || upper == "TRACE" || upper == "FATAL" {
				if data.Level == "" { data.Level = inner }
			} else if logDateInnerRe.MatchString(inner) {
				// Looks like an apache date
				if data.Date == "" { data.Date = inner }
			} else {
				// Probably a thread
				if data.Thread == "" { data.Thread = inner }
			}
		}

		// If no level found in brackets, sniff standalone levels
		if data.Level == "" {
			if m := logLevelRe.FindString(strings.ToUpper(remaining)); m != "" {
				data.Level = m
			}
		}

		data.Severity = mapLevelToSeverity(data.Level)

		// Sniff Logger / Class Name
		// Usually looks like: package.ClassName : or ClassName: 
		if m := logLoggerRe.FindStringSubmatch(remaining); m != nil {
			if m[1] != "" {
				data.Logger = m[1]
			} else if m[2] != "" {
				data.Logger = m[2]
			}
		}

		parsed.Lines = append(parsed.Lines, data)
	}

	return parsed
}

func mapLevelToSeverity(level string) string {
	upper := strings.ToUpper(level)
	switch {
	case strings.Contains(upper, "ERROR"), strings.Contains(upper, "FATAL"):
		return "error"
	case strings.Contains(upper, "WARN"):
		return "warn"
	case strings.Contains(upper, "INFO"), strings.Contains(upper, "DEBUG"), strings.Contains(upper, "TRACE"):
		return "info"
	}
	return "none"
}

func (p *LogProcessor) RunJob(jctx JobContext) error {
	block := jctx.Block
	source, _ := block.Attrs["source"].(string)

	if strings.TrimSpace(source) == "" {
		block.Attrs["status"] = BlockStatusComplete
		return nil
	}

	parsedData := parseLogLines(source)
	
	jsonData, err := json.Marshal(parsedData)
	if err != nil {
		return err
	}

	cat := WorkingCopy
	if d, err := p.svc.Documents.LoadByUUID(jctx.UUID); err == nil && d.Kind() == KindNote {
		cat = LibraryCategory
	}

	asset, err := p.svc.Assets.Save(cat, jctx.UUID, block.ID+"-parsed", jsonData)
	if err != nil {
		return err
	}

	block.Attrs["parsedAssetRef"] = asset.ExternalRef()
	block.Attrs["status"] = BlockStatusComplete
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
