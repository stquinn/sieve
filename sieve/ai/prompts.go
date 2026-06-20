package ai

import (
	"fmt"
	"sieve/sieve/domain"
	"sieve/store"
)

// PromptEntry represents a prompt available in the system.
type PromptEntry struct {
	ID          string `json:"id"`          // "prompt:" + Name — stable opaque ID for the frontend
	Name        string `json:"name"`        // e.g. "file", "explain", "ask"
	DisplayName string `json:"displayName"` // e.g. "Smart Filing"
	Path        string `json:"path"`        // store-relative path if override exists, otherwise empty
	IsVirtual   bool   `json:"isVirtual"`   // true if using baked-in default
}

// PromptService manages AI prompt templates through the Store interface.
// Template overrides live in the Prompts category (store/{hostname}/prompts/).
type PromptService struct {
	st store.Store
}

// NewPromptService creates a PromptService backed by st.
func NewPromptService(st store.Store) (*PromptService, error) {
	if err := st.PrepareCategory(domain.Prompts); err != nil {
		return nil, err
	}
	return &PromptService{st: st}, nil
}

// GetPromptContent returns the prompt template for name. If an override file
// exists in the Store, it is used; otherwise the baked-in default is returned.
func (ps *PromptService) GetPromptContent(name string) (string, error) {
	s, err := ps.st.Load(domain.Prompts, name+".md")
	if err == nil {
		return string(s.Body()), nil
	}
	// Fallback to default constants
	switch name {
	case "file":
		return DefaultFilingPrompt, nil
	case "explain":
		return DefaultExplainPrompt, nil
	case "ask":
		return DefaultAskPrompt, nil
	case "image":
		return DefaultImagePrompt, nil
	case "refine":
		return DefaultRefinePrompt, nil
	case "web-clip-fetch":
		return DefaultWebClipFetchPrompt, nil
	case "web-clip-summarise":
		return DefaultWebClipSummarisePrompt, nil
	default:
		return "", fmt.Errorf("unknown prompt: %s", name)
	}
}

// SavePrompt persists a prompt override to the Store.
func (ps *PromptService) SavePrompt(name string, content string) error {
	_, err := ps.st.CreateText(domain.Prompts, name+".md", []byte(content))
	return err
}

// DeletePrompt removes a prompt override from the Store.
func (ps *PromptService) DeletePrompt(name string) error {
	s, err := ps.st.Load(domain.Prompts, name+".md")
	if err != nil {
		return nil // Already deleted or doesn't exist
	}
	return ps.st.Delete(s)
}

// ListPrompts returns all standard prompts with their virtualization status.
func (ps *PromptService) ListPrompts() []PromptEntry {
	names := []string{"file", "explain", "ask", "refine", "image", "web-clip-fetch", "web-clip-summarise"}
	displayNames := map[string]string{
		"file":               "Smart Filing",
		"explain":            "Explain Content",
		"ask":                "In-context Chat",
		"refine":             "Language Detection",
		"image":              "Describe Image",
		"web-clip-fetch":     "Web Clip — Fetch",
		"web-clip-summarise": "Web Clip — Summarise",
	}

	out := make([]PromptEntry, 0, len(names))
	for _, name := range names {
		p := PromptEntry{
			ID:          "prompt:" + name,
			Name:        name,
			DisplayName: displayNames[name],
		}
		if s, err := ps.st.Load(domain.Prompts, name+".md"); err == nil {
			p.IsVirtual = false
			p.Path = s.ExternalRef()
		} else {
			p.IsVirtual = true
		}
		out = append(out, p)
	}
	return out
}

// DefaultPrompts baked into the binary to provide zero-config AI interactions.
// Users can override these by editing the copies written to store/{hostname}/prompts/
// and modifying settings.json.
// DefaultExplainPrompt and DefaultAskPrompt are intentionally separate constants
// even though they share most text — each can be overridden independently by the user.

const DefaultFilingPrompt = `
Given the following content, decide if it is worth keeping
as a permanent note in a knowledge stash.

Existing folders: {folder_list}
Select the most appropriate existing folder for this content.
If the content belongs to a distinct topic not covered by existing folders, suggest a new, appropriately named folder.
If the content is too generic, leave the folder empty for root.

### Document Context:
- Current Time: {now}
- Created: {created}
- Modified: {modified}
- Focus Signal: {focus_count} (Indicates number of times the file has been opened or 5 minute incrememtns of it being in focus)
- Iteration: {version} (Indicates manual user refinement)

### Evaluation Criteria (BE CRITICAL):
- Information Density: Is the content substantial? Gibberish, single sentences, or trivial tests should be discarded.
- Age/Staleness: Take into account how old the document is relative to 'Current Time'.
- Engagement: Look at 'Focus Signal' and the duration between 'Created' and 'Modified'.
- Refinement: Use 'Iteration' (version) to gauge if the note has been improved by the user over time.

### Voting Logic (STRICT HIERARCHY):
1. DISCARD (keep:false) if content is low-density, meta-talk about the test itself, or gibberish.
2. DISCARD (keep:false) if version < 3 AND focus_count < 2, unless the content contains a complex code block or > 3 distinct data points.
3. KEEP (keep:true) only if the content provides specific, non-obvious information AND has been refined (version > 2) or shows sustained engagement (focus_count > 3).

Generate rich semantic tags — relate it to broader technologies and topics.

CRITICAL: You MUST provide a descriptive kebab-case filename even if you decide keep:false.
CRITICAL: You MUST provide an appropriate folder name even if you decide keep:false.

After making the keep/discard decision, generate a short, plain‑language justification
explaining which signals most influenced the outcome.

Constraints for the justification:
- One sentence only.
- Descriptive, not evaluative (do NOT use words like "important", "valuable", "high quality").
- Refer only to observed signals (e.g. focus signal, iteration, refinement, explicit user intent, convergence).
- Do NOT restate the content.
- Do NOT explain the rules themselves.

Additionally, include a compact "density_signals" object that captures the specific cues used to judge information density.
Constraints:
- Only include 3–6 short bullet-like strings (each ≤ 8 words).
- Refer to observable cues (e.g., code blocks present, number of distinct points, presence of headings/lists, presence of actionable decisions, specificity of nouns, duplication/boilerplate).
- Do not quote the content.
- Do not use evaluative language ("good", "important", "high quality").
- If keep:false due primarily to triviality/gibberish, set density_signals to ["low-density", "<why>"].
- Otherwise always include it.


Respond ONLY with raw JSON. DO NOT use markdown code fences (triple backticks). No preamble or explanation.
{
  "keep": true,
  "title": "Short title",
  "filename": "meaningful-name.md",
  "folder": "folder-name",
  "new_folder": true,
  "type": "content type",
  "summary": "brief summary",
  "tags": ["tag1", "tag2"],
  "ai_justification": "brief heuristic explanation of why this was kept or discarded",
  "density_signals": ["signal1", "signal2"]
}

Content:
{content}

`

const DefaultExplainPrompt = `
[PERSONA]
Act as a highly efficient research assistant. Provide the answer concisely with insight, drawing connections from the available files, but never explain your search process. If you find a connection, present it as a finished thought.

[RESPONSE PROTOCOL]

- SILENT OPERATION: Perform all file searches, MCP tool calls, and image analysis silently. Do not list the files you are checking, the tools you are calling, or your internal reasoning steps.

- DIRECT ANSWER ONLY: Your final output must only contain the answer to the user's question in clean markdown.

- SYNTHESIZE: If information is gathered from multiple files (e.g., the knowledge base and the image), merge them into a single, cohesive response without citing the specific filenames unless they are requested.

[TASK]
You are part of an ongoing analysis thread. The user will provide a TARGET (the root piece of content), a THREAD (the history of questions and explanations about that target), and an ACTION to perform.
Your task is to explain the specific node requested in the ACTION clearly and concisely.
Respond in plain markdown suitable for inline display.
Do not repeat the content. Just explain the requested node.

Each THREAD entry has a NODE ID, a label indicating what it refers to (QUESTION ABOUT: <id> =question asked specifically about that prior node; EXPLAIN NODE: <id> = an explanation of that prior node), and an **ANSWER:** showing the response. The ACTION entry has the same structure but no answer yet — that's what you provide.

File Access Scope:
You are  authorized to access and process the specific files or paths named within the user's prompt. Do not perform exploratory file system operations, recursive directory walks, or search for "relevant" files on the local disk unless they are specifically targeted by name.
Do not draw any conclusion based on file names or paths.  Use only content of referenced file or this prompt to derive meaning.

Tool Usage:
You are encouraged to use available tools/MCP servers to fulfill the request, provided they do not involve unauthorized local disk scanning.

Content type: {type}

TARGET:
{content}

---
---

THREAD:
{history}

---
---

ACTION:
{action}
`

const DefaultAskPrompt = `
[PERSONA]
Act as a highly efficient research assistant. Provide the answer concisely with insight, drawing connections from the available files, but never explain your search process. If you find a connection, present it as a finished thought.

[RESPONSE PROTOCOL]

- SILENT OPERATION: Perform all file searches, MCP tool calls, and image analysis silently. Do not list the files you are checking, the tools you are calling, or your internal reasoning steps.

- DIRECT ANSWER ONLY: Your final output must only contain the answer to the user's question in clean markdown.

- SYNTHESIZE: If information is gathered from multiple files (e.g., the knowledge base and the image), merge them into a single, cohesive response without citing the specific filenames unless they are requested.

[TASK]
You are part of an ongoing analysis thread. The user will provide a TARGET (the root piece of content), a THREAD (the history of questions and explanations about that target), and an ACTION to perform.
Your task is to answer the user's question clearly and concisely.
Respond in plain markdown suitable for inline display.

Each THREAD entry has a NODE ID, a label indicating what it refers to (QUESTION ABOUT: <id> =question asked specifically about that prior node;  EXPLAIN NODE: <id> = an explanation of that prior node), and an **ANSWER:** showing the response. The ACTION entry has the same structure but no answer yet — that's what you provide.

File Access Scope:
You are  authorized to access and process the specific files or paths named within the user's prompt. Do not perform exploratory file system operations, recursive directory walks, or search for "relevant" files on the local disk unless they are specifically targeted by name.
Do not draw any conclusion based on file names or paths.  Use only content of referenced file or this prompt to derive meaning.

Tool Usage:
You are encouraged to use available tools/MCP servers to fulfill the request, provided they do not involve unauthorized local disk scanning.

Content type: {type}

TARGET:
{content}

---
---

THREAD:
{history}

---
---

ACTION:
{action}
`

const DefaultImagePrompt = `Describe the image file {image_filename} and help me describe and categorise it.

Respond ONLY with valid JSON. No preamble.

{
  "alt": "brief alt text for accessibility (30 words or fewer)",
  "summary": "1-2 sentence neutral description for search and context"
}
`

const DefaultRefinePrompt = `Identify the programming language of this code snippet.
Reply with ONLY the lowercase language name (e.g. python, go, javascript, typescript, rust, java, c, cpp, sql, bash, yaml, json, xml, html, css, ruby, php, swift, kotlin, dart, markdown, csharp, toml, ini, dockerfile, makefile, lua, powershell).
If you cannot identify a specific language confidently, reply with exactly: text

Current Detection State (use as a signal/context, but make up your own mind):
- Current Language: {current_language}
- Detection Method: {detection_method}

Code:
{content}
`

const DefaultWebClipFetchPrompt = `Please retrieve the content at the following URL and return it as clean, well-structured markdown. Preserve all meaningful content including headings, lists, tables, and code blocks.
Please ensure to grab any relevant images and include those as well.
Do not summarise - preserve content as is.  Your job is to simply retrieve the document and translate to markdown as per the instructions above.
URL: {source}
`

const DefaultWebClipSummarisePrompt = `Please retrieve the content at the following URL and return a
  concise markdown summary targeted to the context of the document below. Focus on aspects of the
  retrieved content that are most relevant to what is already in the document. Omit navigation,
  boilerplate, author bios, and related links.
  Only include an image if it directly illustrates a key point in your summary and cannot be adequately
  conveyed in text alone, and it relates to the document context below.
  URL: {source}

  Current document context:
  {document}
  `
