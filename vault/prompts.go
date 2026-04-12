package vault

// DefaultPrompts baked into the binary to provide zero-config AI interactions.
// Users can override these by editing the copies written to vault/{hostname}/prompts/
// and modifying settings.json.

const DefaultFilingPrompt = `Given the following content, decide if it is worth keeping
as a permanent note.

Existing folders: {folder_list}
Select the most appropriate existing folder for this content.
If the content belongs to a distinct topic not covered by existing folders, suggest a new, appropriately named folder.
If the content is too generic, leave the folder empty for root.

Importance signals:
- version: {version} — higher means more curation by user
- focus_count: {focus_count} — higher means repeatedly returned to
- v1 with focus_count 0 is almost certainly throwaway
- v10+ with focus_count 4+ is almost certainly worth keeping

Generate rich semantic tags — not just literal terms but related
concepts, technologies, and topics that would help find this note
later. Err on the side of more tags rather than fewer.

CRITICAL: You MUST provide a descriptive kebab-case filename even if you decide the note is not worth keeping.

Respond ONLY with valid JSON. No preamble. No markdown fences.

{
  "keep": true,
  "title": "Short human-readable title, max 20 chars",
  "filename": "meaningful-kebab-case-name.md",
  "folder": "suggested-folder-name",
  "new_folder": true, // set to true ONLY if suggesting a folder not in the Existing folders list
  "type": "detected language or content type",
  "summary": "one line description",
  "tags": ["tag1", "tag2", "tag3"]
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
