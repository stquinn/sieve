# SieveBlock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Go processor registry and JS renderer registry infrastructure with `code` as the first concrete SieveBlock Kind — proving user-triggered block creation, server-side language detection, and the generic type/registry pattern end-to-end.

**Architecture:** One `BlockProcessor` interface on the Go side and one generic `sieveBlock` TipTap node on the JS side, both driven by registries keyed by Kind. The primary creation path is `CreateBlock(uuid, kind, overrides)` — triggered by UI commands, keyboard shortcuts, and tools. Paste detection is a secondary convenience that extracts overrides and delegates to `CreateBlock`. `InitAttrs` is the single place where a processor declares its YAML schema and zero-state. Go owns all intelligence; JS owns rendering via a `rendererRegistry`.

**Tech Stack:** Go 1.25, `sieve/sieve/fencedblock`, yaml.v3, vanilla JS ES module, TipTap 2, jsyaml, `regexp` (Go heuristics).

**Prerequisites:** Plan 1 (Go-heavy frontend) must be complete — `EditorService`, `WsHandler`, and `editorWs` in `editor.js` must all be in place.

**Scope:** `code` Kind only. The registry infrastructure built here supports all future Kinds without modification.

---

## The Core Principle

```
Primary path:  UI command → create-block (WS) → CreateBlock → InitAttrs → insert-block
Secondary path: paste     → paste (WS)         → HandlePaste → PasteMatch → CreateBlock → insert-block
```

```
Go side                              JS side
──────────────────────────────────   ──────────────────────────────────────────
SieveBlock (one struct)              sieveBlock (one TipTap node)
BlockProcessor registry              BlockRenderer registry
RegisterProcessor("code", …)         registerSieveRenderer("code", CodeRenderer)
InitAttrs — schema + zero state      makeNodeView — how the block looks
CreateBlock — canonical creation     sieve:create-block — UI trigger event
PasteMatch — paste detection only    paste WS message — secondary path
```

Go serialises all YAML. JS never constructs YAML. `rawYaml` flows from Go to JS and is replayed verbatim on serialise.

---

## File Map

| Action | Path | Purpose |
|--------|------|---------|
| Create | `sieve/processor_registry.go` | `BlockProcessor` interface, `Services`, registry, `GenerateBlockID` |
| Create | `sieve/processor_registry_test.go` | Registry and paste-ordering tests |
| Create | `sieve/language_heuristics.go` | Tier-based pattern matching, no AI dependency |
| Create | `sieve/language_heuristics_test.go` | Pattern tests covering all tiers |
| Modify | `sieve/ai_service.go` | Add `DetectCodeLanguage` (heuristics → AI fallback) |
| Create | `sieve/code_processor.go` | `CodeBlockProcessor`: `InitAttrs`, `PasteMatch`, `RunJob` |
| Create | `sieve/code_processor_test.go` | `InitAttrs` and `PasteMatch` unit tests |
| Modify | `sieve/editor_service.go` | Add `services`, `CreateBlock` (primary), `HandlePaste` (secondary) |
| Modify | `sieve/editor_service_test.go` | `CreateBlock` and `HandlePaste` tests |
| Modify | `sieve/service_provider.go` | Wire `Services`, register `CodeBlockProcessor` |
| Modify | `requesthandlers/ws_handler.go` | Write mutex, `create-block` (primary), `paste` (secondary) |
| Create | `frontend/src/static/sieve-block-extension.js` | Generic `sieveBlock` node + `rendererRegistry` + `CodeRenderer` |
| Modify | `frontend/src/static/editor.js` | WS events, `sieve:create-block` listener, `sieve:block-update` relay, paste routing, remove `detectLanguage` |
| Modify | `frontend/src/index.html` | Load `sieve-block-extension.js`, add `T.SieveBlock` |
| Modify | `frontend/src/static/extensions.js` | Remove `CodeBlockWithAttrs` |

---

## Task 1: BlockProcessor Interface and Registry

**Files:**
- Create: `sieve/processor_registry.go`
- Create: `sieve/processor_registry_test.go`

- [ ] **Step 1.1: Write failing tests**

Create `sieve/processor_registry_test.go`:

```go
package sieve

import (
	"context"
	"testing"
)

type mockProcessor struct {
	matchFn func(string) (bool, map[string]interface{})
}

func (p *mockProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{"id": id, "status": "PENDING"}
	for k, v := range overrides {
		attrs[k] = v
	}
	return attrs
}
func (p *mockProcessor) PasteMatch(c string) (bool, map[string]interface{}) { return p.matchFn(c) }
func (p *mockProcessor) BuildContext(_ SieveBlock, _ ShadowDocument) string  { return "" }
func (p *mockProcessor) RunJob(_ context.Context, _ *SieveBlock, _ Services) error { return nil }

func resetRegistry() {
	processorRegistry = map[string]BlockProcessor{}
	pasteMatchers = nil
}

func TestRegisterProcessor_storesInRegistry(t *testing.T) {
	resetRegistry()
	mock := &mockProcessor{matchFn: func(_ string) (bool, map[string]interface{}) { return false, nil }}
	RegisterProcessor("test-kind", mock)
	if GetProcessor("test-kind") == nil {
		t.Fatal("expected processor to be registered, got nil")
	}
}

func TestRegisterProcessor_unknownKindReturnsNil(t *testing.T) {
	resetRegistry()
	if GetProcessor("no-such-kind") != nil {
		t.Fatal("expected nil for unregistered kind")
	}
}

func TestPasteMatchers_firstMatchWins(t *testing.T) {
	resetRegistry()
	specific := &mockProcessor{matchFn: func(c string) (bool, map[string]interface{}) {
		if c == "target" { return true, map[string]interface{}{"winner": "specific"} }
		return false, nil
	}}
	general := &mockProcessor{matchFn: func(c string) (bool, map[string]interface{}) {
		return true, map[string]interface{}{"winner": "general"}
	}}
	RegisterProcessor("specific", specific)
	RegisterProcessor("general", general)

	registryMu.RLock()
	matchers := pasteMatchers
	registryMu.RUnlock()

	for _, pm := range matchers {
		ok, overrides := pm.Processor.PasteMatch("target")
		if ok {
			if overrides["winner"] != "specific" {
				t.Errorf("expected specific to win, got %v", overrides["winner"])
			}
			break
		}
	}
}

func TestGenerateBlockID_formatAndUniqueness(t *testing.T) {
	id1 := GenerateBlockID("code")
	id2 := GenerateBlockID("code")
	if len(id1) < 5 {
		t.Errorf("expected ID length >= 5, got %q", id1)
	}
	if id1 == id2 {
		t.Errorf("expected unique IDs, got %q twice", id1)
	}
	if id1[:2] != "co" {
		t.Errorf("expected prefix 'co', got %q", id1[:2])
	}
}
```

- [ ] **Step 1.2: Run — expect compile failure**

```bash
go test ./sieve/... -run "TestRegisterProcessor|TestPasteMatchers|TestGenerateBlockID" -v
```
Expected: compile error — `BlockProcessor`, `Services`, `RegisterProcessor`, `GetProcessor`, `GenerateBlockID` not defined.

- [ ] **Step 1.3: Implement processor_registry.go**

Create `sieve/processor_registry.go`:

```go
package sieve

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sync"
)

// BlockProcessor is implemented by every SieveBlock Kind.
//
// InitAttrs is the schema declaration. It returns the complete, valid initial
// YAML map for a new block — every field at its zero value, overridden by
// whatever the creation trigger supplied. Called by CreateBlock regardless of
// how the block was created (UI command, paste, API).
//
// PasteMatch is secondary: it detects whether pasted content should become
// this Kind and extracts override values to pass into InitAttrs. Processors
// that have no paste trigger return false, nil from PasteMatch.
type BlockProcessor interface {
	InitAttrs(id string, overrides map[string]interface{}) map[string]interface{}
	PasteMatch(content string) (matched bool, overrides map[string]interface{})
	BuildContext(block SieveBlock, doc ShadowDocument) string
	RunJob(ctx context.Context, block *SieveBlock, svc Services) error
}

// Services is the dependency bag passed to BlockProcessor.RunJob.
type Services struct {
	AI        *AIService
	Documents *DocumentService
	Assets    *AssetService
}

var (
	registryMu        sync.RWMutex
	processorRegistry = map[string]BlockProcessor{}
	pasteMatchers     []struct {
		Kind      string
		Processor BlockProcessor
	}
)

// RegisterProcessor registers kind → processor. Registration order sets
// paste-match priority — more-specific kinds must be registered first.
func RegisterProcessor(kind string, processor BlockProcessor) {
	registryMu.Lock()
	defer registryMu.Unlock()
	processorRegistry[kind] = processor
	pasteMatchers = append(pasteMatchers, struct {
		Kind      string
		Processor BlockProcessor
	}{Kind: kind, Processor: processor})
}

// GetProcessor returns the registered processor for kind, or nil.
func GetProcessor(kind string) BlockProcessor {
	registryMu.RLock()
	defer registryMu.RUnlock()
	return processorRegistry[kind]
}

// GenerateBlockID returns "XX-YYYY" where XX = first two chars of kind
// and YYYY = 4 random hex chars. Example: "co-a3f9" for kind "code".
func GenerateBlockID(kind string) string {
	b := make([]byte, 2)
	_, _ = rand.Read(b)
	prefix := kind
	if len(prefix) > 2 {
		prefix = prefix[:2]
	}
	return prefix + "-" + hex.EncodeToString(b)
}
```

- [ ] **Step 1.4: Run — expect pass**

```bash
go test ./sieve/... -run "TestRegisterProcessor|TestPasteMatchers|TestGenerateBlockID" -v
```
Expected: 4 tests PASS.

- [ ] **Step 1.5: Commit**

```bash
git add sieve/processor_registry.go sieve/processor_registry_test.go
git commit -m "feat(sieve): BlockProcessor interface, processor registry, GenerateBlockID"
```

---

## Task 2: Language Heuristics

Go owns all language intelligence. This task ports the tiered heuristic logic from `editor.js` `detectLanguage()` into a pure Go function — no AI dependency, fully testable. `DetectCodeLanguage` (Task 3) calls it first; the AI is only a fallback.

### Heuristic Execution Order & Mechanics

The Go function `detectByHeuristics` determines a file type/language programmatically using a sequence of rules:

1. **Trusted Hint Bypass:**
   - The first check looks at the info string (hint) provided in the markdown fence. 
   - If this hint matches a known, supported programming language name (e.g. `go`, `python`, `typescript`, `sql`, etc., defined in `knownLanguages`), the hint is trusted immediately and returned without running any code analysis.

2. **Structural JSON Check:**
   - If the snippet starts and ends with standard braces (`{`/`}` or `[`/`]`), it attempts to parse the content via `json.Unmarshal`.
   - If unmarshaling succeeds, the snippet is immediately and confidently classified as `json`.

3. **Tier 1: Unambiguous Signals (Decisive Matches):**
   - The source is evaluated against regular expressions that represent decisive, non-overlapping language-specific structures (e.g., Go `package main`, Java class definitions `public class ...`, Python function declarations `def func(self):`, SQL commands `SELECT ... FROM ...`, shebangs like `#!/bin/bash`).
   - The first matching rule returns that language immediately.

4. **Tier 2: Cumulative Signals (Weaker Hints):**
   - If Tier 1 does not match, the source is evaluated against rules representing weaker, potentially overlapping indicator patterns (e.g., standard assignment operators like `:=` in Go, import names like `fmt.Println`, or TS/JS type annotations `: number`).
   - We count the number of hits for each candidate language. If a language accumulates **two or more hits**, it is selected as the detected language.
   - If no candidate language accumulates enough hits, the heuristic check fails, allowing the system to fall back to the AI language detection model.

**Files:**
- Create: `sieve/language_heuristics.go`
- Create: `sieve/language_heuristics_test.go`

- [ ] **Step 2.1: Write failing tests**

Create `sieve/language_heuristics_test.go`:

```go
package sieve

import (
	"testing"
)

func TestDetectByHeuristics_json(t *testing.T) {
	lang, ok := detectByHeuristics(`{"key": "value", "num": 42}`, "")
	if !ok || lang != "json" {
		t.Errorf("expected json/true, got %q/%v", lang, ok)
	}
}

func TestDetectByHeuristics_yamlK8s(t *testing.T) {
	src := "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: my-app"
	lang, ok := detectByHeuristics(src, "")
	if !ok || lang != "yaml" {
		t.Errorf("expected yaml/true, got %q/%v", lang, ok)
	}
}

func TestDetectByHeuristics_go_tier1(t *testing.T) {
	lang, ok := detectByHeuristics("package main\n\nfunc main() {}", "")
	if !ok || lang != "go" {
		t.Errorf("expected go/true, got %q/%v", lang, ok)
	}
}

func TestDetectByHeuristics_go_struct(t *testing.T) {
	lang, ok := detectByHeuristics("type User struct {\n\tName string `json:\"name\"`\n}", "")
	if !ok || lang != "go" {
		t.Errorf("expected go/true, got %q/%v", lang, ok)
	}
}

func TestDetectByHeuristics_java_tier1(t *testing.T) {
	lang, ok := detectByHeuristics("public class Foo {\n\tpublic static void main(String[] args) {}\n}", "")
	if !ok || lang != "java" {
		t.Errorf("expected java/true, got %q/%v", lang, ok)
	}
}

func TestDetectByHeuristics_python(t *testing.T) {
	lang, ok := detectByHeuristics("def greet(self):\n    return self.name", "")
	if !ok || lang != "python" {
		t.Errorf("expected python/true, got %q/%v", lang, ok)
	}
}

func TestDetectByHeuristics_sql(t *testing.T) {
	lang, ok := detectByHeuristics("SELECT id, name FROM users WHERE active = 1", "")
	if !ok || lang != "sql" {
		t.Errorf("expected sql/true, got %q/%v", lang, ok)
	}
}

func TestDetectByHeuristics_bash_shebang(t *testing.T) {
	lang, ok := detectByHeuristics("#!/bin/bash\necho hello", "")
	if !ok || lang != "bash" {
		t.Errorf("expected bash/true, got %q/%v", lang, ok)
	}
}

func TestDetectByHeuristics_typescript(t *testing.T) {
	lang, ok := detectByHeuristics("export interface User {\n  name: string\n  age: number\n}", "")
	if !ok || lang != "typescript" {
		t.Errorf("expected typescript/true, got %q/%v", lang, ok)
	}
}

func TestDetectByHeuristics_hint_trusted(t *testing.T) {
	lang, ok := detectByHeuristics("x = 1", "python")
	if !ok || lang != "python" {
		t.Errorf("expected python/true from hint, got %q/%v", lang, ok)
	}
}

func TestDetectByHeuristics_unknownHint_falls_through(t *testing.T) {
	_, ok := detectByHeuristics("x = 1", "weirdlang")
	_ = ok // no panic is the assertion
}

func TestDetectByHeuristics_noMatch(t *testing.T) {
	_, ok := detectByHeuristics("hello world", "")
	if ok {
		t.Error("expected no match for plain prose")
	}
}
```

- [ ] **Step 2.2: Run — expect compile failure**

```bash
go test ./sieve/... -run "TestDetectByHeuristics" -v
```
Expected: compile error — `detectByHeuristics` not defined.

- [ ] **Step 2.3: Implement language_heuristics.go**

Create `sieve/language_heuristics.go`:

```go
package sieve

import (
	"encoding/json"
	"regexp"
	"strings"
)

// knownLanguages are trusted as hints without pattern matching.
var knownLanguages = map[string]bool{
	"python": true, "go": true, "javascript": true, "typescript": true,
	"rust": true, "java": true, "kotlin": true, "dart": true,
	"swift": true, "c": true, "cpp": true, "sql": true,
	"bash": true, "sh": true, "shell": true, "yaml": true, "json": true,
	"xml": true, "html": true, "css": true, "ruby": true, "php": true,
	"mermaid": true, "plantuml": true, "text": true,
}

// tier1 patterns are unambiguous single signals.
var tier1 = []struct {
	re   *regexp.Regexp
	lang string
}{
	{regexp.MustCompile(`(?m)^apiVersion:\s*\S+`), "yaml"},
	{regexp.MustCompile(`(?m)^package\s+\w+`), "go"},
	{regexp.MustCompile(`(?m)^type\s+\w+\s+struct\s*\{`), "go"},
	{regexp.MustCompile(`(?m)^type\s+\w+\s+interface\s*\{`), "go"},
	{regexp.MustCompile("(?m)`(?:json|yaml|db|bson|form|validate):\"[^\"]*\"`"), "go"},
	{regexp.MustCompile(`(?m)^import\s+\(`), "go"},
	{regexp.MustCompile(`(?m)^public\s+(?:class|interface|enum|abstract\s+class)\s+\w+`), "java"},
	{regexp.MustCompile(`\bpublic\s+static\s+void\s+main\s*\(\s*String`), "java"},
	{regexp.MustCompile(`(?m)^import\s+java\.`), "java"},
	{regexp.MustCompile(`(?m)^import\s+(?:org|com)\.\w+\.\w+`), "java"},
	{regexp.MustCompile(`(?m)^import\s+'(?:package:flutter|dart:)`), "dart"},
	{regexp.MustCompile(`\bextends\s+(?:StatefulWidget|StatelessWidget|State)\b`), "dart"},
	{regexp.MustCompile(`(?m)\bdef\s+\w+\s*\(.*\)\s*:`), "python"},
	{regexp.MustCompile(`(?i)(?m)^\s*SELECT\s+.+\bFROM\b`), "sql"},
	{regexp.MustCompile(`(?i)(?m)^\s*(?:INSERT\s+INTO|CREATE\s+TABLE|DROP\s+TABLE|ALTER\s+TABLE)\b`), "sql"},
	{regexp.MustCompile(`^#!.*(?:bash|sh|zsh)\b`), "bash"},
	{regexp.MustCompile(`(?m)^(?:export\s+)?interface\s+\w+\s*\{`), "typescript"},
	{regexp.MustCompile(`(?m)^(?:export\s+)?type\s+\w+\s*=`), "typescript"},
}

// tier2 patterns require 2+ hits per language.
var tier2 = []struct {
	re   *regexp.Regexp
	lang string
}{
	{regexp.MustCompile(`\bfunc\s+\(\s*\w+\s+\*?\w+\s*\)\s+\w+\s*\(`), "go"},
	{regexp.MustCompile(`\bfunc\s+\w+\s*\(`), "go"},
	{regexp.MustCompile(`:=\s`), "go"},
	{regexp.MustCompile(`\bfmt\.\w+\(`), "go"},
	{regexp.MustCompile(`\berr\s*!=\s*nil\b`), "go"},
	{regexp.MustCompile(`@(?:Override|SpringBootApplication|Component|Service|Repository|Controller|Autowired|Bean|Test)\b`), "java"},
	{regexp.MustCompile(`\bthrows\s+\w+(?:Exception|Error)\b`), "java"},
	{regexp.MustCompile(`\bSystem\.out\.print`), "java"},
	{regexp.MustCompile(`\bnew\s+\w+\(.*\);`), "java"},
	{regexp.MustCompile(`\bScaffold\s*\(`), "dart"},
	{regexp.MustCompile(`\bColumn\s*\(\s*children:`), "dart"},
	{regexp.MustCompile(`\bfinal\s+\w+\s+\w+\s*=`), "dart"},
	{regexp.MustCompile(`:\s*(?:string|number|boolean|any)\b`), "typescript"},
	{regexp.MustCompile(`(?m)^(?:const|let)\s+\w+\s*=.*=>`), "typescript"},
}

// detectByHeuristics returns the detected language and true when confident.
// hint is trusted unconditionally if it is a known language name.
func detectByHeuristics(source, hint string) (string, bool) {
	h := strings.ToLower(strings.TrimSpace(hint))
	if h != "" && knownLanguages[h] {
		return h, true
	}

	trimmed := strings.TrimSpace(source)
	if trimmed == "" {
		return "", false
	}

	// JSON: validate by parsing to avoid false positives from regex
	if (strings.HasPrefix(trimmed, "{") && strings.HasSuffix(trimmed, "}")) ||
		(strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]")) {
		var v interface{}
		if json.Unmarshal([]byte(trimmed), &v) == nil {
			return "json", true
		}
	}

	for _, rule := range tier1 {
		if rule.re.MatchString(trimmed) {
			return rule.lang, true
		}
	}

	hits := map[string]int{}
	for _, rule := range tier2 {
		if rule.re.MatchString(trimmed) {
			hits[rule.lang]++
		}
	}
	for lang, count := range hits {
		if count >= 2 {
			return lang, true
		}
	}

	return "", false
}
```

- [ ] **Step 2.4: Run — expect pass**

```bash
go test ./sieve/... -run "TestDetectByHeuristics" -v
```
Expected: 12 tests PASS.

- [ ] **Step 2.5: Commit**

```bash
git add sieve/language_heuristics.go sieve/language_heuristics_test.go
git commit -m "feat(sieve): language heuristics — tier-based pattern matching, no AI dependency"
```

---

## Task 3: DetectCodeLanguage on AIService

**Files:**
- Modify: `sieve/ai_service.go`

- [ ] **Step 3.1: Add DetectCodeLanguage**

Append to `sieve/ai_service.go` after `RefineLanguage`:

```go
// DetectCodeLanguage returns the programming language for source code.
// Heuristics run first. If not confident, RefineLanguage (AI) is the fallback.
func (s *AIService) DetectCodeLanguage(source, hint string) (string, error) {
	if lang, ok := detectByHeuristics(source, hint); ok {
		return lang, nil
	}
	lang, err := s.RefineLanguage(source)
	if err != nil {
		return "unknown", err
	}
	if lang == "" {
		return "unknown", nil
	}
	return lang, nil
}
```

- [ ] **Step 3.2: Build check**

```bash
go build ./...
```

- [ ] **Step 3.3: Commit**

```bash
git add sieve/ai_service.go
git commit -m "feat(ai): DetectCodeLanguage — heuristics first, AI fallback"
```

---

## Task 4: CodeBlockProcessor

**Files:**
- Create: `sieve/code_processor.go`
- Create: `sieve/code_processor_test.go`

- [ ] **Step 4.1: Write failing tests**

Create `sieve/code_processor_test.go`:

```go
package sieve

import (
	"testing"
)

// ── InitAttrs ────────────────────────────────────────────────────────────────

func TestCodeBlockProcessor_InitAttrs_zeroState(t *testing.T) {
	p := &CodeBlockProcessor{}
	attrs := p.InitAttrs("co-0001", nil)
	if attrs["id"] != "co-0001" {
		t.Errorf("expected id=co-0001, got %v", attrs["id"])
	}
	if attrs["status"] != "PENDING" {
		t.Errorf("expected status=PENDING, got %v", attrs["status"])
	}
	if attrs["source"] != "" {
		t.Errorf("expected empty source, got %v", attrs["source"])
	}
	// No source → heuristics return nothing → language empty
	if attrs["language"] != "" {
		t.Errorf("expected empty language with no source, got %v", attrs["language"])
	}
}

func TestCodeBlockProcessor_InitAttrs_heuristicsApplied(t *testing.T) {
	p := &CodeBlockProcessor{}
	// InitAttrs must run heuristics synchronously so the user sees a language
	// badge immediately, before RunJob (AI) completes.
	attrs := p.InitAttrs("co-0002", map[string]interface{}{
		"source": "package main\n\nfunc main() {}",
	})
	if attrs["language"] != "go" {
		t.Errorf("expected heuristics to detect 'go', got %v", attrs["language"])
	}
	// Status stays PENDING — AI enrichment still runs in RunJob
	if attrs["status"] != "PENDING" {
		t.Errorf("expected PENDING (AI enrichment not done yet), got %v", attrs["status"])
	}
}

func TestCodeBlockProcessor_InitAttrs_withOverrides(t *testing.T) {
	p := &CodeBlockProcessor{}
	attrs := p.InitAttrs("co-0003", map[string]interface{}{
		"source": "print('hello')",
		"hint":   "python",
	})
	if attrs["source"] != "print('hello')" {
		t.Errorf("expected source from override, got %v", attrs["source"])
	}
	// hint "python" is a known language — heuristics trust it immediately
	if attrs["language"] != "python" {
		t.Errorf("expected language=python from hint, got %v", attrs["language"])
	}
	if attrs["id"] != "co-0003" {
		t.Errorf("expected id=co-0003, got %v", attrs["id"])
	}
	// id must not be overrideable via overrides
	attrs2 := p.InitAttrs("co-0004", map[string]interface{}{"id": "injected"})
	if attrs2["id"] != "co-0004" {
		t.Errorf("id must come from parameter, not overrides; got %v", attrs2["id"])
	}
}

// ── PasteMatch ───────────────────────────────────────────────────────────────

func TestCodeBlockProcessor_PasteMatch_withLanguage(t *testing.T) {
	p := &CodeBlockProcessor{}
	matched, overrides := p.PasteMatch("```python\nprint('hello')\nprint('world')\n```")
	if !matched {
		t.Fatal("expected match for bare code fence")
	}
	if overrides["source"] != "print('hello')\nprint('world')" {
		t.Errorf("unexpected source: %v", overrides["source"])
	}
	if overrides["hint"] != "python" {
		t.Errorf("expected hint=python, got %v", overrides["hint"])
	}
	// PasteMatch must NOT set status or id — those belong to InitAttrs
	if _, ok := overrides["status"]; ok {
		t.Error("PasteMatch must not set status")
	}
	if _, ok := overrides["id"]; ok {
		t.Error("PasteMatch must not set id")
	}
}

func TestCodeBlockProcessor_PasteMatch_noLanguage(t *testing.T) {
	p := &CodeBlockProcessor{}
	matched, overrides := p.PasteMatch("```\nsome code\n```")
	if !matched {
		t.Fatal("expected match for fence without language")
	}
	if overrides["source"] != "some code" {
		t.Errorf("unexpected source: %v", overrides["source"])
	}
	if _, ok := overrides["hint"]; ok {
		t.Errorf("expected no hint when fence has no language")
	}
}

func TestCodeBlockProcessor_PasteMatch_noMatch(t *testing.T) {
	p := &CodeBlockProcessor{}
	if matched, _ := p.PasteMatch("just plain text"); matched {
		t.Fatal("expected no match for plain text")
	}
	if matched, _ := p.PasteMatch("`inline code`"); matched {
		t.Fatal("expected no match for inline code")
	}
}

func TestCodeBlockProcessor_PasteMatch_multiline(t *testing.T) {
	p := &CodeBlockProcessor{}
	matched, overrides := p.PasteMatch("```go\npackage main\n\nfunc main() {\n\tfmt.Println(\"hi\")\n}\n```")
	if !matched {
		t.Fatal("expected match for multiline fence")
	}
	if src, _ := overrides["source"].(string); src == "" {
		t.Error("expected non-empty source")
	}
}
```

- [ ] **Step 4.2: Run — expect compile failure**

```bash
go test ./sieve/... -run "TestCodeBlockProcessor" -v
```
Expected: compile error — `CodeBlockProcessor` not defined.

- [ ] **Step 4.3: Implement CodeBlockProcessor**

Create `sieve/code_processor.go`:

```go
package sieve

import (
	"context"
	"regexp"
	"strings"
)

var codeFenceRe = regexp.MustCompile("(?s)^```(\\w*)\\n(.+)\\n```$")

// CodeBlockProcessor handles the 'code' Kind.
type CodeBlockProcessor struct{}

// InitAttrs declares the code block schema and returns the complete initial
// YAML map. id is always set from the parameter — overrides cannot replace it.
// Heuristics run synchronously here so the user sees a language badge immediately
// when the block is inserted. RunJob (AI) then enriches silently in the background.
func (p *CodeBlockProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{
		"id":       id,
		"status":   "PENDING",
		"source":   "",
		"language": "",
	}
	for k, v := range overrides {
		if k == "id" {
			continue // id is authoritative from parameter
		}
		attrs[k] = v
	}
	// Free-hit language detection: heuristics are fast and give the user something
	// useful immediately. Status stays PENDING — AI enrichment runs in RunJob.
	source, _ := attrs["source"].(string)
	hint, _ := attrs["hint"].(string)
	if lang, ok := detectByHeuristics(source, hint); ok {
		attrs["language"] = lang
	}
	return attrs
}

// PasteMatch detects a bare fenced code block and returns the source and optional
// language hint as overrides for InitAttrs. It does NOT set id, status, or language.
func (p *CodeBlockProcessor) PasteMatch(content string) (bool, map[string]interface{}) {
	m := codeFenceRe.FindStringSubmatch(strings.TrimSpace(content))
	if m == nil {
		return false, nil
	}
	overrides := map[string]interface{}{"source": m[2]}
	if m[1] != "" {
		overrides["hint"] = m[1]
	}
	return true, overrides
}

func (p *CodeBlockProcessor) BuildContext(block SieveBlock, _ ShadowDocument) string {
	src, _ := block.Attrs["source"].(string)
	return src
}

// RunJob enriches the language via AI and marks the block COMPLETE.
// Heuristics already ran in InitAttrs — RunJob calls RefineLanguage (AI-only)
// to potentially improve the result. If the AI returns empty, the heuristic
// result from InitAttrs is kept. hint is transient and deleted after use.
func (p *CodeBlockProcessor) RunJob(ctx context.Context, block *SieveBlock, svc Services) error {
	source, _ := block.Attrs["source"].(string)

	lang, err := svc.AI.RefineLanguage(source)
	if err != nil {
		// Non-fatal: heuristics may have already set a language. Mark complete
		// and keep whatever language is set rather than overwriting with "unknown".
		block.Attrs["status"] = "COMPLETE"
		delete(block.Attrs, "hint")
		return nil
	}
	if lang != "" {
		block.Attrs["language"] = lang
	}
	// If lang == "" AI was not confident — keep the heuristic result unchanged.
	block.Attrs["status"] = "COMPLETE"
	delete(block.Attrs, "hint")
	return nil
}
```

- [ ] **Step 4.4: Run — expect pass**

```bash
go test ./sieve/... -run "TestCodeBlockProcessor" -v
```
Expected: 6 tests PASS.

- [ ] **Step 4.5: Commit**

```bash
git add sieve/code_processor.go sieve/code_processor_test.go
git commit -m "feat(sieve): CodeBlockProcessor — InitAttrs schema, PasteMatch, RunJob"
```

---

## Task 5: EditorService — CreateBlock (primary) and HandlePaste (secondary)

**Files:**
- Modify: `sieve/editor_service.go`
- Modify: `sieve/editor_service_test.go`

- [ ] **Step 5.1: Write failing tests**

Append to `sieve/editor_service_test.go`:

```go
func TestEditorService_CreateBlock_code(t *testing.T) {
	resetRegistry()
	RegisterProcessor("code", &CodeBlockProcessor{})

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, 0)

	doc, _ := ds.New()
	doc.SetBody([]byte("# Hello"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()
	_ = es.Open(uuid, nil)

	id, rawYaml, err := es.CreateBlock(uuid, "code", nil)
	if err != nil {
		t.Fatalf("CreateBlock: %v", err)
	}
	if len(id) < 5 {
		t.Errorf("expected valid id, got %q", id)
	}
	if !strings.Contains(rawYaml, "status: PENDING") {
		t.Errorf("expected PENDING in rawYaml, got:\n%s", rawYaml)
	}

	// Block must be in shadow with complete attrs
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	shadow.mu.Lock()
	blk, ok := shadow.Blocks[id]
	shadow.mu.Unlock()
	if !ok {
		t.Fatal("expected block in shadow")
	}
	if blk.Attrs["id"] != id {
		t.Errorf("expected id in attrs, got %v", blk.Attrs["id"])
	}
	if _, ok := blk.Attrs["source"]; !ok {
		t.Error("expected source field in attrs (zero value)")
	}
	if _, ok := blk.Attrs["language"]; !ok {
		t.Error("expected language field in attrs (zero value)")
	}
}

func TestEditorService_CreateBlock_withOverrides(t *testing.T) {
	resetRegistry()
	RegisterProcessor("code", &CodeBlockProcessor{})

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, 0)
	doc, _ := ds.New()
	doc.SetBody([]byte("# Hello"))
	doc, _ = ds.Save(doc)
	_ = es.Open(doc.UUID(), nil)

	id, rawYaml, err := es.CreateBlock(doc.UUID(), "code", map[string]interface{}{
		"source": "print('hello')",
		"hint":   "python",
	})
	if err != nil {
		t.Fatalf("CreateBlock: %v", err)
	}
	if !strings.Contains(rawYaml, "print") {
		t.Errorf("expected source in rawYaml, got:\n%s", rawYaml)
	}
	_ = id
}

func TestEditorService_HandlePaste_delegatesToCreateBlock(t *testing.T) {
	resetRegistry()
	RegisterProcessor("code", &CodeBlockProcessor{})

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, 0)
	doc, _ := ds.New()
	doc.SetBody([]byte("# Hello"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()
	_ = es.Open(uuid, nil)

	kind, id, rawYaml, matched := es.HandlePaste(uuid, "```python\nprint('hello')\n```")
	if !matched {
		t.Fatal("expected match")
	}
	if kind != "code" {
		t.Errorf("expected kind=code, got %q", kind)
	}
	if len(id) < 5 {
		t.Errorf("expected valid id, got %q", id)
	}
	// rawYaml must contain the complete initial state, not just paste-extracted values
	if !strings.Contains(rawYaml, "status: PENDING") {
		t.Errorf("expected complete state in rawYaml, got:\n%s", rawYaml)
	}
	if !strings.Contains(rawYaml, "print") {
		t.Errorf("expected source in rawYaml, got:\n%s", rawYaml)
	}
}

func TestEditorService_HandlePaste_noMatch(t *testing.T) {
	resetRegistry()
	RegisterProcessor("code", &CodeBlockProcessor{})

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, 0)
	doc, _ := ds.New()
	doc.SetBody([]byte("# Hello"))
	doc, _ = ds.Save(doc)
	_ = es.Open(doc.UUID(), nil)

	_, _, _, matched := es.HandlePaste(doc.UUID(), "just plain text")
	if matched {
		t.Fatal("expected no match for plain text")
	}
}
```

- [ ] **Step 5.2: Run — expect compile failure**

```bash
go test ./sieve/... -run "TestEditorService_CreateBlock|TestEditorService_HandlePaste" -v
```
Expected: compile error — `CreateBlock` not defined.

- [ ] **Step 5.3: Add services field to EditorService struct**

In `sieve/editor_service.go`, update the `EditorService` struct — add `services`, preserving `debounce`:

```go
type EditorService struct {
	documents *DocumentService
	services  Services
	debounce  time.Duration
	mu        sync.RWMutex
	shadows   map[string]*ShadowDocument
}
```

Add `"context"` and `"fmt"` to the import block if not already present.

- [ ] **Step 5.4: Append SetServices, CreateBlock, HandlePaste, RunJob to editor_service.go**

```go
func (es *EditorService) SetServices(svc Services) {
	es.services = svc
}

// CreateBlock is the canonical block creation path. It initialises a new block
// via the registered processor's InitAttrs, registers it in the shadow, and
// returns the serialised rawYaml for the JS to insert as a sieveBlock node.
// overrides may be nil for a zero-state block (UI command, keyboard shortcut).
func (es *EditorService) CreateBlock(uuid, kind string, overrides map[string]interface{}) (id, rawYaml string, err error) {
	processor := GetProcessor(kind)
	if processor == nil {
		return "", "", fmt.Errorf("no processor registered for kind %q", kind)
	}
	id = GenerateBlockID(kind)
	attrs := processor.InitAttrs(id, overrides)
	es.UpdateBlock(uuid, kind, id, attrs)
	raw, err := fencedblock.Serialize[map[string]interface{}](attrs)
	if err != nil {
		return "", "", err
	}
	return id, raw, nil
}

// HandlePaste runs paste matchers and delegates to CreateBlock on the first match.
// It is the secondary creation path — prefer CreateBlock directly for UI-triggered creation.
func (es *EditorService) HandlePaste(uuid, content string) (kind, id, rawYaml string, matched bool) {
	registryMu.RLock()
	matchers := pasteMatchers
	registryMu.RUnlock()

	for _, pm := range matchers {
		ok, overrides := pm.Processor.PasteMatch(content)
		if !ok {
			continue
		}
		blockID, raw, err := es.CreateBlock(uuid, pm.Kind, overrides)
		if err != nil {
			return "", "", "", false
		}
		return pm.Kind, blockID, raw, true
	}
	return "", "", "", false
}

// RunJob executes the background job for blockID, merges results into the shadow,
// flushes to disk, and calls notify with the updated rawYaml.
func (es *EditorService) RunJob(ctx context.Context, uuid, blockID string, notify func(id, rawYaml string)) {
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	if shadow == nil {
		return
	}

	shadow.mu.Lock()
	blk, ok := shadow.Blocks[blockID]
	if !ok {
		shadow.mu.Unlock()
		return
	}
	kind := blk.Kind
	blkCopy := &SieveBlock{
		ID:    blk.ID,
		Kind:  blk.Kind,
		Attrs: make(map[string]interface{}, len(blk.Attrs)),
	}
	for k, v := range blk.Attrs {
		blkCopy.Attrs[k] = v
	}
	shadow.mu.Unlock()

	processor := GetProcessor(kind)
	if processor == nil {
		return
	}

	if err := processor.RunJob(ctx, blkCopy, es.services); err != nil {
		shadow.setBlock(kind, blockID, map[string]interface{}{"status": "ERROR"})
	} else {
		shadow.setBlock(kind, blockID, blkCopy.Attrs)
	}

	_ = es.Flush(uuid)

	if notify != nil {
		shadow.mu.Lock()
		blk2, ok2 := shadow.Blocks[blockID]
		shadow.mu.Unlock()
		if ok2 {
			rawYaml, _ := fencedblock.Serialize[map[string]interface{}](blk2.Attrs)
			notify(blockID, rawYaml)
		}
	}
}
```

- [ ] **Step 5.5: Run — expect pass**

```bash
go test ./sieve/... -run "TestEditorService" -v
```
Expected: all PASS.

- [ ] **Step 5.6: Commit**

```bash
git add sieve/editor_service.go sieve/editor_service_test.go
git commit -m "feat(editor): CreateBlock (primary), HandlePaste (secondary), RunJob"
```

---

## Task 6: Wire Services and Register Processors

**Files:**
- Modify: `sieve/service_provider.go`

- [ ] **Step 6.1: Wire Services and register CodeBlockProcessor**

In `sieve/service_provider.go`, in `Init()`, immediately after:
```go
s.Editor = NewEditorService(s.Documents, autosave)
```
Add:

```go
s.Editor.SetServices(Services{
    AI:        s.AI,
    Documents: s.Documents,
    Assets:    s.Assets,
})
RegisterProcessor("code", &CodeBlockProcessor{})
```

- [ ] **Step 6.2: Build + test**

```bash
go build ./...
go test ./...
```
Expected: all PASS.

- [ ] **Step 6.3: Commit**

```bash
git add sieve/service_provider.go
git commit -m "feat(sieve): register CodeBlockProcessor, wire Services into EditorService"
```

---

## Task 7: WsHandler — Write Mutex, create-block (primary), paste (secondary)

**Files:**
- Modify: `requesthandlers/ws_handler.go`

- [ ] **Step 7.1: Add write mutex and update existing write call sites**

In `handleWS`, add before the message loop:

```go
var writeMu sync.Mutex
writeMsg := func(v interface{}) {
    data, err := json.Marshal(v)
    if err != nil {
        return
    }
    writeMu.Lock()
    _ = conn.WriteMessage(websocket.TextMessage, data)
    writeMu.Unlock()
}
```

Update signatures of `handleFlush` and `handleEnterMarkdown` from `(conn *websocket.Conn, uuid string)` to `(writeMsg func(interface{}), uuid string)`. Replace internal `conn.WriteMessage` with `writeMsg(...)`. Update the switch:

```go
case "flush":
    h.handleFlush(writeMsg, uuid)
case "enter-markdown":
    h.handleEnterMarkdown(writeMsg, uuid)
```

Updated helpers:

```go
func (h *WsHandler) handleFlush(writeMsg func(interface{}), uuid string) {
    _ = h.ServiceProvider.Editor.Flush(uuid)
    writeMsg(map[string]string{"type": "flush-ack", "uuid": uuid})
}

func (h *WsHandler) handleEnterMarkdown(writeMsg func(interface{}), uuid string) {
    merged := h.ServiceProvider.Editor.EnterMarkdown(uuid)
    writeMsg(map[string]string{"type": "markdown-content", "uuid": uuid, "markdown": merged})
}
```

Add `"sync"` to imports.

- [ ] **Step 7.2: Add create-block handler (primary creation path)**

Add to the switch in `handleWS`:

```go
case "create-block":
    h.handleCreateBlock(uuid, raw, writeMsg)
case "paste":
    h.handlePaste(uuid, raw, writeMsg)
```

Add methods:

```go
// handleCreateBlock is the primary UI-triggered block creation path.
// JS sends this when the user uses a keyboard shortcut, toolbar button, or command.
func (h *WsHandler) handleCreateBlock(uuid string, raw []byte, writeMsg func(interface{})) {
    var msg struct {
        Kind string `json:"kind"`
    }
    if err := json.Unmarshal(raw, &msg); err != nil || msg.Kind == "" {
        return
    }
    id, rawYaml, err := h.ServiceProvider.Editor.CreateBlock(uuid, msg.Kind, nil)
    if err != nil {
        logger.Warn("ws: create-block failed", "uuid", uuid, "kind", msg.Kind, "err", err)
        return
    }
    writeMsg(map[string]string{
        "type":    "insert-block",
        "kind":    msg.Kind,
        "id":      id,
        "rawYaml": rawYaml,
    })
    go h.ServiceProvider.Editor.RunJob(context.Background(), uuid, id, func(blkID, updatedRawYaml string) {
        writeMsg(map[string]string{
            "type":    "block-attrs-updated",
            "id":      blkID,
            "rawYaml": updatedRawYaml,
        })
    })
}

// handlePaste is the secondary paste-triggered creation path.
// Runs paste matchers; delegates to CreateBlock internally on match.
func (h *WsHandler) handlePaste(uuid string, raw []byte, writeMsg func(interface{})) {
    var msg struct {
        Content string `json:"content"`
    }
    if err := json.Unmarshal(raw, &msg); err != nil {
        return
    }
    kind, id, rawYaml, matched := h.ServiceProvider.Editor.HandlePaste(uuid, msg.Content)
    if !matched {
        return
    }
    writeMsg(map[string]string{
        "type":    "insert-block",
        "kind":    kind,
        "id":      id,
        "rawYaml": rawYaml,
    })
    go h.ServiceProvider.Editor.RunJob(context.Background(), uuid, id, func(blkID, updatedRawYaml string) {
        writeMsg(map[string]string{
            "type":    "block-attrs-updated",
            "id":      blkID,
            "rawYaml": updatedRawYaml,
        })
    })
}
```

Add `"context"` to imports. Import `"sieve/logger"` if not already present.

- [ ] **Step 7.3: Build check**

```bash
go build ./...
```

- [ ] **Step 7.4: Commit**

```bash
git add requesthandlers/ws_handler.go
git commit -m "feat(ws): create-block (primary) + paste (secondary) → insert-block + RunJob"
```

---

## Task 8: sieve-block-extension.js — Generic Node + Renderer Registry

One `sieveBlock` TipTap node delegates rendering to `rendererRegistry[node.attrs.kind]`. `CodeRenderer` is the first entry. Future Kinds register via `T.registerSieveRenderer(kind, renderer)` without touching this file.

**Files:**
- Create: `frontend/src/static/sieve-block-extension.js`

- [ ] **Step 8.1: Create the extension**

Create `frontend/src/static/sieve-block-extension.js`:

```js
// sieve-block-extension.js
// One generic TipTap node + a renderer registry keyed by Kind.
// Mirrors Go: BlockProcessor registry ↔ BlockRenderer registry.
//
// BlockRenderer interface:
//   makeNodeView(node)        → TipTap NodeView object
//   parseAttrs(data)          → { key: value } extra data-* attrs for fence parser (optional)

import { esc, applyHighlighting, isStaleByTime, isJobActive } from './fenced-block-base.js'

;(function () {
  'use strict'

  var T = window.TipTap
  var Node = T.Node
  var mergeAttributes = T.mergeAttributes

  // ── Renderer Registry ────────────────────────────────────────────────────────

  var rendererRegistry = {}

  function registerSieveRenderer(kind, renderer) {
    rendererRegistry[kind] = renderer
  }

  // ── Generic sieveBlock TipTap Node ──────────────────────────────────────────

  var SieveBlock = Node.create({
    name: 'sieveBlock',
    group: 'block',
    atom: true,
    selectable: true,
    draggable: true,

    addAttributes() {
      return {
        kind:      { default: '',        parseHTML: function (el) { return el.getAttribute('data-kind')       || '' } },
        id:        { default: '',        parseHTML: function (el) { return el.getAttribute('data-id')         || '' } },
        rawYaml:   { default: '',        parseHTML: function (el) { return el.getAttribute('data-raw-yaml')   || '' } },
        status:    { default: 'PENDING', parseHTML: function (el) { return el.getAttribute('data-status')     || 'PENDING' } },
        language:  { default: '',        parseHTML: function (el) { return el.getAttribute('data-language')   || '' } },
        source:    { default: '',        parseHTML: function (el) { return el.getAttribute('data-source')     || '' } },
        createdAt: { default: null,      parseHTML: function (el) { return el.getAttribute('data-created-at') || null } },
      }
    },

    parseHTML() {
      return [{ tag: 'div[data-type="sieveBlock"]' }]
    },

    renderHTML({ HTMLAttributes }) {
      return ['div', mergeAttributes({ 'data-type': 'sieveBlock' }, HTMLAttributes)]
    },

    addNodeView() {
      return function ({ node }) {
        var renderer = rendererRegistry[node.attrs.kind]
        if (!renderer) {
          var dom = document.createElement('div')
          dom.className = 'sieve-block sieve-block--unknown'
          dom.textContent = '[unknown block kind: ' + (node.attrs.kind || '?') + ']'
          return { dom: dom }
        }
        return renderer.makeNodeView(node)
      }
    },

    addStorage() {
      return {
        markdown: {
          // Serialize: write ```<kind>\n<rawYaml>\n```.
          // Go owns all YAML — JS replays rawYaml verbatim. kind drives the fence info string.
          serialize: function (state, node) {
            state.ensureNewLine()
            if (node.attrs.kind && node.attrs.rawYaml) {
              state.write('```' + node.attrs.kind + '\n' + node.attrs.rawYaml + '\n```')
            } else {
              state.write('```\n\n```')
            }
            state.closeBlock(node)
          },
          parse: {
            // Intercept any fence whose kind has a registered renderer AND whose
            // YAML body contains an id. All other fences fall through unchanged.
            setup: function (markdownit) {
              var defaultFence = markdownit.renderer.rules.fence
              markdownit.renderer.rules.fence = function (tokens, idx, options, env, self) {
                var token = tokens[idx]
                var kind = (token.info || '').trim()

                if (!kind || !rendererRegistry[kind]) {
                  return defaultFence
                    ? defaultFence(tokens, idx, options, env, self)
                    : self.renderToken(tokens, idx, options)
                }

                var data
                try { data = window.jsyaml.load(token.content) } catch (e) { data = null }
                if (!data || !data.id) {
                  return defaultFence
                    ? defaultFence(tokens, idx, options, env, self)
                    : self.renderToken(tokens, idx, options)
                }

                var attrs = [
                  'data-type="sieveBlock"',
                  'data-kind="' + esc(kind) + '"',
                  'data-id="' + esc(data.id) + '"',
                  'data-raw-yaml="' + esc(token.content) + '"',
                  'data-status="' + esc(data.status || 'PENDING') + '"',
                ]
                var renderer = rendererRegistry[kind]
                if (renderer && renderer.parseAttrs) {
                  var extra = renderer.parseAttrs(data)
                  Object.keys(extra).forEach(function (k) {
                    attrs.push('data-' + k + '="' + esc(String(extra[k])) + '"')
                  })
                }
                if (data.createdAt) attrs.push('data-created-at="' + esc(data.createdAt) + '"')
                return '<div ' + attrs.join(' ') + '></div>\n'
              }
            },
          },
        },
      }
    },
  })

  // ── CodeRenderer ─────────────────────────────────────────────────────────────

  var CodeRenderer = {
    parseAttrs: function (data) {
      return {
        language: data.language || '',
        source: (typeof data.source === 'string' ? data.source.trim() : ''),
      }
    },

    makeNodeView: function (node) {
      var currentAttrs = Object.assign({}, node.attrs)

      var dom = document.createElement('div')
      dom.className = 'sieve-block sieve-block--code'
      dom.setAttribute('data-block-id', node.attrs.id || '')
      dom.contentEditable = 'false'

      var header = document.createElement('div')
      header.className = 'sieve-block__header'
      header.contentEditable = 'false'

      var badge = document.createElement('span')
      badge.className = 'sieve-block__badge'
      header.appendChild(badge)

      var pre = document.createElement('pre')
      pre.className = 'sieve-block__pre not-prose'

      var codeEl = document.createElement('code')
      codeEl.className = 'sieve-block__source'
      codeEl.contentEditable = 'true'
      codeEl.spellcheck = false
      codeEl.setAttribute('autocorrect', 'off')
      codeEl.setAttribute('autocapitalize', 'off')
      pre.appendChild(codeEl)
      dom.appendChild(header)
      dom.appendChild(pre)

      function render(attrs) {
        currentAttrs = attrs
        var isPending = attrs.status === 'PENDING'
        var isStale = isPending && !isJobActive(attrs.id) && isStaleByTime(attrs.createdAt)
        // Show "detecting…" only when pending AND heuristics gave no language yet.
        // If heuristics already set a language in InitAttrs, show it immediately —
        // the AI is enriching silently in the background.
        var showDetecting = isPending && !isStale && (!attrs.language || attrs.language === '')

        if (showDetecting) {
          badge.textContent = 'detecting…'
          badge.className = 'sieve-block__badge sieve-block__badge--pending'
        } else if (attrs.language && attrs.language !== 'unknown') {
          badge.textContent = attrs.language
          badge.className = 'sieve-block__badge'
        } else {
          badge.textContent = attrs.language || ''
          badge.className = 'sieve-block__badge sieve-block__badge--unknown'
        }

        if (document.activeElement !== codeEl) {
          codeEl.textContent = attrs.source || ''
          var langClass = (attrs.language && attrs.language !== 'unknown')
            ? 'language-' + attrs.language : 'language-text'
          codeEl.className = 'sieve-block__source ' + langClass
          applyHighlighting(pre)
        }
      }

      render(node.attrs)

      var inputTimer = null
      codeEl.addEventListener('input', function () {
        clearTimeout(inputTimer)
        inputTimer = setTimeout(function () {
          document.dispatchEvent(new CustomEvent('sieve:block-update', {
            detail: { id: currentAttrs.id, kind: 'code', attrs: { source: codeEl.textContent } },
          }))
        }, 200)
      })

      codeEl.addEventListener('keydown', function (e) {
        if (e.metaKey || e.ctrlKey) return
        e.stopPropagation()
      })

      return {
        dom: dom,
        contentDOM: null,
        update: function (updatedNode) {
          if (updatedNode.type.name !== 'sieveBlock') return false
          render(updatedNode.attrs)
          return true
        },
        ignoreMutation: function () { return true },
        stopEvent: function (event) {
          if (event.type === 'keydown' && (event.metaKey || event.ctrlKey)) return false
          return event.type === 'keydown' || event.type === 'keyup' || event.type === 'keypress'
        },
        destroy: function () { clearTimeout(inputTimer) },
      }
    },
  }

  registerSieveRenderer('code', CodeRenderer)

  // ── Exports ───────────────────────────────────────────────────────────────────
  T.SieveBlock = SieveBlock
  T.registerSieveRenderer = registerSieveRenderer

})()
```

- [ ] **Step 8.2: Commit**

```bash
git add frontend/src/static/sieve-block-extension.js
git commit -m "feat(js): sieveBlock TipTap node + renderer registry + CodeRenderer"
```

---

## Task 9: editor.js — WS Events, UI Creation, Relay, Paste, Remove detectLanguage

**Files:**
- Modify: `frontend/src/static/editor.js`

- [ ] **Step 9.1: Add WS message dispatch for insert-block and block-attrs-updated**

In `editorWs.onmessage` (from Plan 1), after the `markdown-content` dispatch:

```js
if (msg.type === 'insert-block') {
  document.dispatchEvent(new CustomEvent('editor:insert-block', { detail: msg }))
}
if (msg.type === 'block-attrs-updated') {
  document.dispatchEvent(new CustomEvent('editor:block-attrs-updated', { detail: msg }))
}
```

- [ ] **Step 9.2: Add sieveInsertPos state variable**

Near the top of the IIFE alongside other state variables:

```js
var sieveInsertPos = null
```

- [ ] **Step 9.3: Listen for sieve:create-block — primary UI-triggered creation**

After the `wsSendAndAwait` helper, add:

```js
// Primary creation path. JS fires sieve:create-block when the user uses a
// keyboard shortcut, toolbar button, or slash command to insert a block.
// detail: { kind: 'code' }
document.addEventListener('sieve:create-block', function (e) {
  if (!currentUuid || currentUuid.startsWith('prompt:') || !e.detail.kind) return
  sieveInsertPos = currentEditor ? currentEditor.state.selection.to : null
  wsSend({ type: 'create-block', kind: e.detail.kind, uuid: currentUuid })
})
```

- [ ] **Step 9.4: Relay sieve:block-update to WebSocket**

```js
// NodeViews fire sieve:block-update when the user edits block content.
document.addEventListener('sieve:block-update', function (e) {
  if (!currentUuid || !e.detail.id) return
  wsSend({ type: 'block-update', uuid: currentUuid, id: e.detail.id, kind: e.detail.kind, attrs: e.detail.attrs })
})
```

- [ ] **Step 9.5: Handle editor:insert-block — insert sieveBlock node at cursor**

```js
document.addEventListener('editor:insert-block', function (e) {
  if (!currentEditor) return
  var msg = e.detail
  var parsed = {}
  try { parsed = window.jsyaml.load(msg.rawYaml) || {} } catch (_) {}

  var pos = sieveInsertPos !== null ? sieveInsertPos : currentEditor.state.doc.content.size
  sieveInsertPos = null

  currentEditor.commands.insertContentAt(pos, {
    type: 'sieveBlock',
    attrs: {
      kind:     msg.kind || 'code',
      id:       msg.id || parsed.id || '',
      rawYaml:  msg.rawYaml || '',
      status:   parsed.status || 'PENDING',
      language: parsed.language || '',
      source:   typeof parsed.source === 'string' ? parsed.source.trim() : '',
    },
  })
})
```

- [ ] **Step 9.6: Handle editor:block-attrs-updated — update node attrs in place**

```js
document.addEventListener('editor:block-attrs-updated', function (e) {
  if (!currentEditor) return
  var msg = e.detail
  var parsed = {}
  try { parsed = window.jsyaml.load(msg.rawYaml) || {} } catch (_) {}

  currentEditor.commands.command(function (commandProps) {
    var tr = commandProps.tr
    commandProps.state.doc.descendants(function (node, pos) {
      if (node.type.name === 'sieveBlock' && node.attrs.id === msg.id) {
        tr.setNodeMarkup(pos, null, Object.assign({}, node.attrs, {
          rawYaml:  msg.rawYaml || node.attrs.rawYaml,
          status:   parsed.status   || node.attrs.status,
          language: parsed.language || node.attrs.language,
          source:   parsed.source != null
            ? (typeof parsed.source === 'string' ? parsed.source.trim() : String(parsed.source))
            : node.attrs.source,
        }))
        return false
      }
    })
    return true
  })
})
```

- [ ] **Step 9.7: Add code-fence paste routing in handleSmartPaste**

In `handleSmartPaste`, BEFORE the existing `ai-block` paste check:

```js
// Bare code fences → Go processor registry via WebSocket (secondary creation path).
// ai-block and web-clip have their own dedicated JS paste handlers.
if (text && currentUuid && !currentUuid.startsWith('prompt:')) {
  var fenceMatch = text.trim().match(/^```(\w*)\n[\s\S]+\n```$/)
  var jsOwnedKinds = ['ai-block', 'web-clip']
  if (fenceMatch && jsOwnedKinds.indexOf((fenceMatch[1] || '').toLowerCase()) === -1) {
    event.preventDefault()
    sieveInsertPos = currentEditor ? currentEditor.state.selection.to : null
    wsSend({ type: 'paste', uuid: currentUuid, content: text.trim() })
    return true
  }
}
```

- [ ] **Step 9.8: Remove detectLanguage from editor.js**

Delete the `detectLanguage` function definition (~line 1125) and its call site (~line 1031) along with any branching on `result.tier` / `result.language`. Language detection now lives entirely in Go.

Verify no remaining references:

```bash
grep -n "detectLanguage\|result\.tier\|result\.language" frontend/src/static/editor.js
```
Expected: zero results.

- [ ] **Step 9.9: Build check**

```bash
go build ./...
```

- [ ] **Step 9.10: Commit**

```bash
git add frontend/src/static/editor.js
git commit -m "feat(editor): create-block listener, sieveBlock events, paste routing; remove detectLanguage"
```

---

## Task 10: index.html + Remove CodeBlockWithAttrs

**Files:**
- Modify: `frontend/src/index.html`
- Modify: `frontend/src/static/editor.js`
- Modify: `frontend/src/static/extensions.js`

- [ ] **Step 10.1: Load sieve-block-extension.js**

In `frontend/src/index.html`, after the `ai-block-extension.js` script tag:

```html
<script type="module" src="/static/sieve-block-extension.js"></script>
```

- [ ] **Step 10.2: Add T.SieveBlock to TipTap extensions**

In `mountWysiwyg` extensions array, after `T.WebClip`:

```js
T.SieveBlock,
```

- [ ] **Step 10.3: Remove CodeBlockWithAttrs from editor.js**

Remove from `mountWysiwyg`:

```js
T.CodeBlockWithAttrs.configure({ lowlight: lowlight }),
```

Check remaining `lowlight` references:

```bash
grep -n "lowlight" frontend/src/static/editor.js
```

If count drops to zero, also remove:

```js
var lowlight = T.createLowlight(T.common)
```

- [ ] **Step 10.4: Remove CodeBlockWithAttrs from extensions.js**

```bash
grep -n "parseInfoString\|CodeBlockWithAttrs" frontend/src/static/extensions.js
```

Delete:
- `function parseInfoString(info) { ... }`
- `var CodeBlockWithAttrs = T.CodeBlockLowlight.extend({ ... })` through its closing `})`
- `T.CodeBlockWithAttrs = CodeBlockWithAttrs`

- [ ] **Step 10.5: Run all tests**

```bash
go build ./...
go test ./...
```
Expected: all PASS.

- [ ] **Step 10.6: Smoke test**

`wails dev`:
1. Fire `document.dispatchEvent(new CustomEvent('sieve:create-block', { detail: { kind: 'code' } }))` from DevTools console — a `sieveBlock` appears with empty source and "detecting…" badge (no source, heuristics have nothing to work with)
2. Paste `` ```python\nprint("hello")\n``` `` — badge shows "python" **immediately** (heuristics fired in InitAttrs); AI enriches silently and confirms in the background
3. Edit source in the block — edits relay via `sieve:block-update`; source survives flush
4. Switch to markdown mode → merged markdown shows updated source in the YAML
5. Reload the note → block restores from the `` ```code `` fence on disk

- [ ] **Step 10.7: Commit**

```bash
git add frontend/src/index.html frontend/src/static/editor.js frontend/src/static/extensions.js
git commit -m "feat: wire SieveBlock, remove CodeBlockWithAttrs — code block cutover complete"
```

---

## Completion Criteria

| Task | Done when |
|------|-----------|
| 1 | `TestRegisterProcessor*`, `TestPasteMatchers*`, `TestGenerateBlockID*` (4 tests) pass |
| 2 | `TestDetectByHeuristics*` (12 tests) pass |
| 3 | `go build ./...` clean; `DetectCodeLanguage` present |
| 4 | `TestCodeBlockProcessor*` (6 tests) pass; `PasteMatch` returns only overrides, not status/id |
| 5 | `TestEditorService_CreateBlock*` (2 tests) + `TestEditorService_HandlePaste*` (2 tests) pass |
| 6 | `go build ./...` clean; `CodeBlockProcessor` registered |
| 7 | `go build ./...` clean; `create-block` and `paste` messages handled |
| 8 | `T.SieveBlock` and `T.registerSieveRenderer` on `window.TipTap`; extension loads without errors |
| 9 | `sieve:create-block` listener active; `detectLanguage` removed from editor.js |
| 10 | All tests pass; UI-triggered and paste-triggered creation both work; note survives reload |

---

## Future Work

Each new Kind: implement `BlockProcessor` (Go) + `BlockRenderer` (JS), register both.

| Kind | Notes |
|------|-------|
| `diagram` | Entirely separate Kind. `DiagramBlockProcessor.InitAttrs` defines the diagram schema. No paste trigger — `PasteMatch` returns `false, nil`. `DiagramRenderer` with CODE + RENDER modes; `Ctrl+R` toggles. UI creation via `sieve:create-block` with `kind: 'diagram'`. |
| `ai-block` | `AiBlockProcessor.InitAttrs` defines question/response/status schema. Replace `ai-block-extension.js` with `AiBlockRenderer`. On-disk format already correct — extension swap only. |
| `web-clip` | No paste trigger. Creation via explicit UI action. `WebClipProcessor.RunJob` handles HTTP fetch + content extraction. `WebClipRenderer` replaces existing web-clip extension. |
| `rich-image` | `RichImageProcessor` (AI description job) + `RichImageRenderer`. |
| `titled-link` | `TitledLinkProcessor` (URL paste → HTTP title fetch) + `TitledLinkRenderer`. Has paste trigger — URL detection in `PasteMatch`. |
