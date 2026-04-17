package vault

import (
	"os"
)

// PromptEntry represents a prompt available in the system.
type PromptEntry struct {
	Name        string `json:"name"`        // e.g. "file", "explain", "ask"
	DisplayName string `json:"displayName"` // e.g. "file.md"
	Path        string `json:"path"`        // absolute path if override exists, otherwise empty
	IsVirtual   bool   `json:"isVirtual"`   // true if using baked-in default
}

// DefaultPrompts baked into the binary to provide zero-config AI interactions.
// Users can override these by editing the copies written to vault/{hostname}/prompts/
// and modifying settings.json.

const DefaultFilingPrompt = `Given the following content, decide if it is worth keeping
as a permanent note in a knowledge vault.

Existing folders: {folder_list}
Select the most appropriate existing folder for this content.
If the content belongs to a distinct topic not covered by existing folders, suggest a new, appropriately named folder.
If the content is too generic, leave the folder empty for root.

### Document Context:
- Current Time: {now}
- Created: {created}
- Modified: {modified}
- Focus Signal: {focus_count} (Indicates active engagement time)
- Iteration: {version} (Indicates manual user refinement)

### Evaluation Criteria (BE CRITICAL):
- Information Density: Is the content substantial? Gibberish, single sentences, or trivial tests should be discarded.
- Age/Staleness: Take into account how old the document is relative to 'Current Time'.
- Engagement: Look at 'Focus Signal' and the duration between 'Created' and 'Modified'.
- Refinement: Use 'Iteration' (version) to gauge if the note has been improved by the user over time.

### Voting Logic:
- keep:false IF content is low-density or gibberish.
- keep:false IF version is 1 AND focus_count is 0 AND the content is trivial.
- keep:true IF content contains useful info, code, or structured thoughts.
- keep:true IF version > 2 OR focus_count > 1 (indicates intent to preserve).

Generate rich semantic tags — relate it to broader technologies and topics.

CRITICAL: You MUST provide a descriptive kebab-case filename even if you decide keep:false.
CRITICAL: You MUST provide an appropriate folder name even if you decide keep:false.

After making the keep/discard decision, generate a short, plain‑language justification
explaining which signals most influenced the outcome.

Constraints for the justification:
- One sentence only.
- Descriptive, not evaluative (do NOT use words like “important”, “valuable”, “high quality”).
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

const DefaultExplainPrompt = `Explain the following content clearly and concisely.
Respond in plain markdown suitable for inline display.
Do not repeat the content. Just explain it.

Content type: {type}
Content:
{content}
`

const DefaultAskPrompt = `Given the following content and conversation history,
answer the user's question clearly and concisely.
Respond in plain markdown suitable for inline display.

Content type: {type}
Content:
{content}

Conversation history:
{history}

User question:
{question}
`

const DefaultImagePrompt = `Describe this image briefly and suggest a short meaningful
kebab-case filename without extension.

Respond ONLY with valid JSON. No preamble.

{
  "filename": "suggested-filename",
  "description": "brief description for alt text"
}
`

const DefaultRefinePrompt = `Identify the programming language of this code snippet.
Reply with ONLY the lowercase language name (e.g. python, go, javascript, typescript, rust, java, c, cpp, sql, bash, yaml, json, xml, html, css, ruby, php, swift, kotlin, dart).
If you cannot identify a specific language confidently, reply with exactly: text

Code:
{content}
`
// GetPromptContent returns the content of the requested prompt.
// It checks settings for an override path first, then falls back to baked-in defaults.
func GetPromptContent(name string, settings Settings) (string, error) {
	var path string
	var defaultContent string

	switch name {
	case "file":
		path = settings.Prompts.File
		defaultContent = DefaultFilingPrompt
	case "explain":
		path = settings.Prompts.Explain
		defaultContent = DefaultExplainPrompt
	case "ask":
		path = settings.Prompts.Ask
		defaultContent = DefaultAskPrompt
	case "image":
		defaultContent = DefaultImagePrompt
	case "refine":
		path = settings.Prompts.Refine
		defaultContent = DefaultRefinePrompt
	default:
		return "", os.ErrNotExist
	}

	if path != "" {
		// Try reading override from disk
		data, err := os.ReadFile(path)
		if err == nil {
			return string(data), nil
		}
		// If path is set but file is missing, we fall back to default silently per spec
	}

	return defaultContent, nil
}
