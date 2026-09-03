package processors

import (
	"encoding/json"
	"regexp"
	"sieve/sieve/block"
	"sieve/sieve/domain"
	"strings"
	"time"
)

// logSignalRe is the generic "this line looks like a log line" signal: a leading
// timestamp, a bracketed level, or a level= token. Deliberately does NOT match the
// bare words "Exception"/"Stack Trace" — those appear in ordinary source code, and
// matching them made plain code blocks get misdetected as logs.
var logSignalRe = regexp.MustCompile(`(?i)(?:^\s*\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}|^\s*\d{2}:\d{2}:\d{2}\b|\[(?:error|fatal|warn|warning|info|debug|trace)\]|\blevel=(?:error|warn|info|debug|trace))`)

// logParserRegexes returns the structured parsers — built-ins plus any the user
// configured in settings — compiled once. Invalid user patterns are skipped.
func logParserRegexes(customParsers []domain.CustomLogParser) []*regexp.Regexp {
	res := []*regexp.Regexp{springBootRe, homeAssistantRe}
	for _, cp := range customParsers {
		if re, err := regexp.Compile(cp.Pattern); err == nil {
			res = append(res, re)
		}
	}
	return res
}

// looksLikeLog is the single source of truth for "is this text a log": a line
// matches any structured parser (built-in OR user-custom), or shows a generic log
// signal. Shared by IsBlock / Transform so detection can never disagree with the
// parsers that actually run in parseLogLines.
func looksLikeLog(source string, customParsers []domain.CustomLogParser) bool {
	if strings.TrimSpace(source) == "" {
		return false
	}
	parsers := logParserRegexes(customParsers)
	for _, line := range strings.Split(source, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		if logSignalRe.MatchString(line) {
			return true
		}
		for _, re := range parsers {
			if re.MatchString(line) {
				return true
			}
		}
	}
	return false
}

type LogProcessor struct {
	svc                      block.BlockServices
	block.FencedSerializer   // one shared YAML serialization — free
	block.FencedDeserializer // its mirror — recognise+parse the fenced form
}

func NewLogProcessor(svc block.BlockServices) *LogProcessor {
	return &LogProcessor{svc: svc, FencedDeserializer: block.FencedDeserializer{Kind: "log"}}
}

func (p *LogProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":                id,
		"status":            block.BlockStatusPending,
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
	// Complete-vs-pending predicate MUST mirror DescribeJob: no source ⇒ no parse
	// job ⇒ born COMPLETE (never dispatched); a source present ⇒ PENDING.
	if src, _ := attrs["source"].(string); strings.TrimSpace(src) == "" {
		attrs["status"] = block.BlockStatusComplete
	}
	return attrs
}

func (p *LogProcessor) IsSupportedContent(entries []block.ContentEntry) block.SupportedActions {
	custom := p.customParsers()
	for _, e := range entries {
		if e.IsSieveType(p) {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionExtract}}
		}
		if kind, attrs, ok := e.SieveAttrs(); ok && kind == "code" {
			source, _ := attrs["source"].(string)
			if lang, _ := attrs["language"].(string); lang == "log" && strings.TrimSpace(source) != "" {
				return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionExtract}}
			}
			if looksLikeLog(source, custom) {
				return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionExtract}}
			}
		}
		if e.MIMEType == "text/plain" {
			if looksLikeLog(e.Content, custom) {
				return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste, block.ActionTransform}}
			}
		}
	}
	return block.SupportedActions{Kind: p.Kind()}
}

// customParsers loads the user-configured log parsers from settings (nil-safe).
func (p *LogProcessor) customParsers() []domain.CustomLogParser {
	if p.svc.State == nil {
		return nil
	}
	return p.svc.State.LoadSettings().CustomLogParsers
}

func (p *LogProcessor) Transform(entries []block.ContentEntry, uuid string, blockID string, action block.Action) map[string]interface{} {
	custom := p.customParsers()
	for _, e := range entries {
		if e.IsSieveType(p) {
			return e.AsAttrsForNewBlock(p)
		}
		if kind, attrs, ok := e.SieveAttrs(); ok && kind == "code" {
			source, _ := attrs["source"].(string)
			trimmed := strings.TrimSpace(source)
			if lang, _ := attrs["language"].(string); lang == "log" && trimmed != "" {
				return map[string]interface{}{"source": trimmed}
			}
			if looksLikeLog(trimmed, custom) {
				return map[string]interface{}{"source": trimmed}
			}
		}

		if e.MIMEType == "text/plain" {
			trimmed := strings.TrimSpace(e.Content)
			if looksLikeLog(trimmed, custom) {
				return map[string]interface{}{"source": trimmed}
			}
		}
	}
	return nil
}

func (p *LogProcessor) OnChange(_ *block.SieveBlock) {}

func (p *LogProcessor) BuildContext(blk block.SieveBlock, _ block.DocView, seen map[string]bool) block.AIContext {
	src, _ := blk.Attrs["source"].(string)
	if strings.TrimSpace(src) == "" {
		return block.AIContext{}
	}
	return block.AIContext{NodeIDs: []string{blk.ID}, Content: "```log\n" + src + "\n```"}
}

// logParseResult is Work's result: the saved parsed-asset ref plus format metadata.
type logParseResult struct {
	assetRef   string
	formatName string
	formatRe   string
}

func (p *LogProcessor) Kind() string { return p.FencedDeserializer.Kind }

func (p *LogProcessor) Mode() block.BlockMode {
	return block.BlockModeBlock
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
	Format  string        `json:"format"`
	Pattern string        `json:"pattern"`
	Lines   []LogLineData `json:"lines"`
}

var springBootRe = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)\s+(\w+)\s+(.*?)\s+---\s+\[(.*?)\]\s+(.*?)\s+:\s+(.*)$`)
var homeAssistantRe = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}\.\d{3})\s+([A-Z]+)\s+\((.*?)\)\s+\[(.*?)\]\s+(.*)$`)

// Fallback-sniffing regexes, compiled once (were previously recompiled per line).
var (
	logBracketRe    = regexp.MustCompile(`\[(.*?)\]|\((.*?)\)`)
	logDateInnerRe  = regexp.MustCompile(`\d{4}|\d{2}:\d{2}`)
	logLevelRe      = regexp.MustCompile(`\b(ERROR|WARN|WARNING|INFO|DEBUG|TRACE|FATAL)\b`)
	logLoggerRe     = regexp.MustCompile(`\b([a-zA-Z0-9_]+\.[a-zA-Z0-9_\.]+)\s*:|\b([A-Z][a-zA-Z0-9_]+(?:Service|Controller|Manager|Repository|Engine|Handler|Control|Processor))\s*:`)
	logDatePrefixRe = regexp.MustCompile(`^(?:\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?|\d{2}:\d{2}:\d{2})`)
)

func parseLogLines(source string, customParsers []domain.CustomLogParser) ParsedLogData {
	var compiledCustomParsers []*regexp.Regexp
	var customParserNames []string
	for _, cp := range customParsers {
		if re, err := regexp.Compile(cp.Pattern); err == nil {
			compiledCustomParsers = append(compiledCustomParsers, re)
			customParserNames = append(customParserNames, cp.Name)
		}
	}

	lines := strings.Split(source, "\n")
	parsed := ParsedLogData{
		Format:  "Smarter Fallback",
		Pattern: "Heuristics-based extraction (Date, Level, Thread, Logger)",
		Lines:   make([]LogLineData, 0, len(lines)),
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
				if v, ok := j["level"].(string); ok {
					data.Level = v
				}
				if v, ok := j["severity"].(string); ok && data.Level == "" {
					data.Level = v
				}

				// Extract Date
				if v, ok := j["time"].(string); ok {
					data.Date = v
				}
				if v, ok := j["timestamp"].(string); ok && data.Date == "" {
					data.Date = v
				}
				if v, ok := j["@timestamp"].(string); ok && data.Date == "" {
					data.Date = v
				}

				// Extract Logger/Thread
				if v, ok := j["logger"].(string); ok {
					data.Logger = v
				}
				if v, ok := j["thread"].(string); ok {
					data.Thread = v
				}

				// Extract Message
				if v, ok := j["message"].(string); ok {
					data.Message = v
				}
				if v, ok := j["msg"].(string); ok && data.Message == line {
					data.Message = v
				}

				data.Severity = mapLevelToSeverity(data.Level)
				parsed.Lines = append(parsed.Lines, data)
				continue
			}
		}

		// 1. Try Custom Regex if provided (not implemented in this stub yet, assuming fallback)
		// 1.5 Try Custom Parsers
		customMatched := false
		for idx, re := range compiledCustomParsers {
			if m := re.FindStringSubmatch(line); m != nil {
				parsed.Format = customParserNames[idx]
				parsed.Pattern = customParsers[idx].Pattern
				customMatched = true

				names := re.SubexpNames()
				for i, name := range names {
					if i != 0 && name != "" {
						val := m[i]
						switch strings.ToLower(name) {
						case "date":
							data.Date = val
						case "level":
							data.Level = strings.ToUpper(val)
						case "thread":
							data.Thread = val
						case "logger":
							data.Logger = val
						case "message":
							data.Message = val
						}
					}
				}
				data.Severity = mapLevelToSeverity(data.Level)
				parsed.Lines = append(parsed.Lines, data)
				break
			}
		}
		if customMatched {
			continue
		}

		// 2. Try strict Spring Boot format
		if m := springBootRe.FindStringSubmatch(line); m != nil {
			parsed.Format = "Spring Boot"
			parsed.Pattern = springBootRe.String()
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
			parsed.Format = "Home Assistant"
			parsed.Pattern = homeAssistantRe.String()
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
			if strings.Contains(remaining, "level=WARN") {
				data.Level = "WARN"
			}
			if strings.Contains(remaining, "level=ERROR") {
				data.Level = "ERROR"
			}
			if strings.Contains(remaining, "level=INFO") {
				data.Level = "INFO"
			}
			if strings.Contains(remaining, "level=DEBUG") {
				data.Level = "DEBUG"
			}
			data.Severity = mapLevelToSeverity(data.Level)
		}

		// Sniff Bracketed components (Threads, Apache Dates, bracketed Levels)
		matches := logBracketRe.FindAllStringSubmatch(remaining, -1)
		for _, match := range matches {
			inner := match[1]
			if inner == "" {
				inner = match[2]
			}
			matchedField := false
			// Is it a level?
			upper := strings.ToUpper(inner)
			if upper == "INFO" || upper == "ERROR" || upper == "WARN" || upper == "DEBUG" || upper == "TRACE" || upper == "FATAL" {
				if data.Level == "" {
					data.Level = inner
					matchedField = true
				}
			} else if logDateInnerRe.MatchString(inner) {
				// Looks like an apache date
				if data.Date == "" {
					data.Date = inner
					matchedField = true
				}
			} else {
				// Probably a thread
				if data.Thread == "" {
					data.Thread = inner
					matchedField = true
				}
			}

			if matchedField {
				remaining = strings.Replace(remaining, match[0], "", 1)
			}
		}

		// Sniff Standalone Date prefix
		if data.Date == "" {
			if loc := logDatePrefixRe.FindStringIndex(remaining); loc != nil {
				data.Date = strings.TrimSpace(remaining[loc[0]:loc[1]])
				remaining = remaining[:loc[0]] + remaining[loc[1]:]
			}
		}

		// If no level found in brackets, sniff standalone levels
		if data.Level == "" {
			if loc := logLevelRe.FindStringIndex(strings.ToUpper(remaining)); loc != nil {
				data.Level = remaining[loc[0]:loc[1]]
				remaining = remaining[:loc[0]] + remaining[loc[1]:]
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
			remaining = strings.Replace(remaining, m[0], "", 1)
		}

		remaining = strings.TrimSpace(remaining)
		remaining = strings.TrimPrefix(remaining, "- ")
		remaining = strings.TrimPrefix(remaining, "-")
		remaining = strings.TrimPrefix(remaining, ": ")
		remaining = strings.TrimPrefix(remaining, ":")
		data.Message = strings.TrimSpace(remaining)

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

// DescribeJob declares the log-parse job, or nil when there is no source to parse
// (the block is born COMPLETE by InitAttrs — same empty-source predicate). The
// parse + asset-save (which can error) lives in Work so a failure surfaces to the
// framework as status ERROR; Apply writes the success attrs.
func (p *LogProcessor) DescribeJob(jctx block.JobContext) *block.ProcessorJob {
	blk := jctx.Block
	uuid, id := jctx.UUID, blk.ID
	source, _ := blk.Attrs["source"].(string)

	if strings.TrimSpace(source) == "" {
		return nil // no source: no parse job (created COMPLETE)
	}

	return &block.ProcessorJob{
		Category: block.CategoryDefault,
		Label:    "Parsing log…",
		Work: func() (any, error) {
			settings := p.svc.State.LoadSettings()
			parsedData := parseLogLines(source, settings.CustomLogParsers)

			jsonData, err := json.Marshal(parsedData)
			if err != nil {
				return nil, err
			}

			cat := domain.WorkingCopy
			if d, err := p.svc.Documents.LoadByUUID(uuid); err == nil && d.Kind() == domain.KindNote {
				cat = domain.LibraryCategory
			}

			asset, err := p.svc.Assets.Save(cat, uuid, id+"-parsed", jsonData)
			if err != nil {
				return nil, err
			}

			return logParseResult{
				assetRef:   asset.ExternalRef(),
				formatName: parsedData.Format,
				formatRe:   parsedData.Pattern,
			}, nil
		},
		Apply: func(result any, b *block.SieveBlock) {
			r := result.(logParseResult)
			b.Attrs["parsedAssetRef"] = r.assetRef
			b.Attrs["logFormatName"] = r.formatName
			b.Attrs["logFormatRegex"] = r.formatRe
			b.Attrs["status"] = block.BlockStatusComplete
		},
	}
}

func (p *LogProcessor) MarkdownRepresentation(blk block.SieveBlock, _ string) string {
	source, _ := blk.Attrs["source"].(string)
	source = strings.TrimSpace(source)
	if source == "" {
		return ""
	}
	fence := getFence(source) // Reusing the package-level getFence from code_processor.go
	return fence + "log\n" + source + "\n" + fence
}

// RawContent returns the source text this block was built from (block.RawContenter).
func (p *LogProcessor) RawContent(blk block.SieveBlock) string {
	src, _ := blk.Attrs["source"].(string)
	return src
}

// LogSourceLocator names the one slot a log's captured text lives in.
const LogSourceLocator = "source"

// NormalisedText makes a log block a TextBearer, READ-ONLY: find can search
// captured output — a record is worth finding precisely because it is a
// record — but LogProcessor deliberately does not implement TextUpdater:
// editing a captured log would falsify what was actually logged. Reading and
// writing are separate participation predicates, and log is the kind that
// answers yes to the first and no to the second.
//
// Class CODE, not prose: a spell checker must not squiggle log output, and
// find reads every class regardless of which one this is. A log is stored
// as ONE string (the "source" attr) with no parse, so its reading is that
// string verbatim, and one segment is the whole of it.
//
// The locator is the BARE slot name, not a self-sufficient hash-carrying
// record like prose's, code's or diagram's. TextBearer's self-sufficiency
// obligation exists to answer one question — is this reading still the one
// an anchor was made against — and that question is only ever asked AT A
// WRITE: TextUpdaterFor("log") is false, so a write is refused before any
// locator here is ever decoded, and nothing this kind mints is ever asked
// to vouch for anything.
func (p *LogProcessor) NormalisedText(blk *block.SieveBlock) []domain.TextSegment {
	if blk == nil {
		return nil
	}
	return []domain.TextSegment{{
		Locator: LogSourceLocator,
		Text:    p.RawContent(*blk),
		Class:   domain.TextClassCode,
	}}
}
