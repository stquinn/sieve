package ai

import (
	"fmt"
	"sieve/sieve/domain"
	"sieve/store"
	"strings"
)

// PromptEntry represents a task in the Prompts dialog.
type PromptEntry struct {
	ID          string `json:"id"`          // "prompt:" + Name — stable opaque ID for the frontend
	Name        string `json:"name"`        // e.g. "file", "explain", "ask"
	DisplayName string `json:"displayName"` // e.g. "Smart Filing"
	Path        string `json:"path"`        // store-relative path of the addendum if there is one, otherwise empty
	IsVirtual   bool   `json:"isVirtual"`   // true if the task has no addendum
}

// PromptService owns the AI tasks and each task's addendum: the text this
// installation adds to the task's brief, stored as {name}.addendum.md in the
// Prompts category (store/{hostname}/prompts/). A {name}.md in that category
// is never read.
type PromptService struct {
	st    store.Store
	tasks []Task // in the order the Prompts dialog lists them
}

// NewPromptService creates a PromptService backed by st and removes from the
// Prompts category each {name}.md of a declared task, which no run reads.
func NewPromptService(st store.Store) (*PromptService, error) {
	if err := st.PrepareCategory(domain.Prompts); err != nil {
		return nil, err
	}
	ps := &PromptService{st: st, tasks: []Task{
		{Name: "file", DisplayName: "Smart Filing", Output: Data, Brief: Layer{Heading: briefHeading, Text: DefaultFilingPrompt}},
		{Name: "explain", DisplayName: "Explain Content", Output: Content, Brief: Layer{Heading: briefHeading, Text: DefaultExplainPrompt}},
		{Name: "ask", DisplayName: "In-context Chat", Output: Content, Brief: Layer{Heading: briefHeading, Text: DefaultAskPrompt}},
		{Name: "chat", DisplayName: "Chat", Output: Content, Brief: Layer{Heading: briefHeading, Text: DefaultChatPrompt}},
		{Name: "btw", DisplayName: "Quick Answer (/btw)", Output: Content, Brief: Layer{Heading: briefHeading, Text: DefaultBtwPrompt}},
		{Name: "refine", DisplayName: "Language Detection", Output: Data, Brief: Layer{Heading: briefHeading, Text: DefaultRefinePrompt}},
		{Name: "image", DisplayName: "Describe Image", Output: Data, Brief: Layer{Heading: briefHeading, Text: DefaultImagePrompt}},
		{Name: "note-meta", DisplayName: "Name Handwritten Note", Output: Data, Brief: Layer{Heading: briefHeading, Text: DefaultNoteMetaPrompt}},
		{Name: "chat-meta", DisplayName: "Name Chat", Output: Data, Brief: Layer{Heading: briefHeading, Text: DefaultChatMetaPrompt}},
		{Name: "page-transcript", DisplayName: "Transcribe Handwritten Page", Output: Data, Brief: Layer{Heading: briefHeading, Text: DefaultPageTranscriptPrompt}},
		{Name: "web-clip-fetch", DisplayName: "Web Clip — Fetch", Output: Data, Brief: Layer{Heading: briefHeading, Text: DefaultWebClipFetchPrompt}},
		{Name: "web-clip-summarise", DisplayName: "Web Clip — Summarise", Output: Data, Brief: Layer{Heading: briefHeading, Text: DefaultWebClipSummarisePrompt}},
	}}
	for _, t := range ps.tasks {
		old, err := st.Load(domain.Prompts, t.Name+".md")
		if err != nil {
			continue
		}
		if err := st.Delete(old); err != nil {
			return nil, fmt.Errorf("remove the old override of %s: %w", t.Name, err)
		}
	}
	return ps, nil
}

// Task returns the task named name.
func (ps *PromptService) Task(name string) (Task, error) {
	for _, t := range ps.tasks {
		if t.Name == name {
			return t, nil
		}
	}
	return Task{}, fmt.Errorf("unknown prompt: %s", name)
}

// Prompt is task's prompt for one run with data: the framework's Background,
// a Delivery layer when the task answers (Task.Answers), the task's brief, its
// addendum when it has one, and data's values. container is the id of the
// container the run works on, empty when it has none: the Data layer then opens
// with the line "Container: sieve://{container}" before data's values.
// sieveTools says whether the run carries the Sieve tools; the framework's
// layers speak of them only when it does.
func (ps *PromptService) Prompt(task Task, data TaskData, container string, sieveTools bool) Prompt {
	dataText := data.Text()
	if container != "" {
		dataText = "Container: " + domain.NewContainerAddress(container).String() + "\n\n" + dataText
	}
	p := Prompt{
		Background: Layer{Heading: backgroundHeading, Text: sieveBackground},
		Brief:      task.Brief,
		Data:       Layer{Heading: dataHeading, Text: dataText},
	}
	if text := ps.loadAddendum(task.Name); text != "" {
		p.Addendum = Layer{Heading: addendumHeading, Text: text}
	}
	if sieveTools {
		p.Background.Text += "\n\n" + sieveToolsBackground
	}
	if task.Writes() {
		p.Delivery = Layer{Heading: deliveryHeading, Text: answerPlainGuidance}
		if sieveTools {
			p.Delivery.Text = answerToolGuidance
		}
	}
	return p
}

// addendumKey is the key of the addendum of the task named name.
func (ps *PromptService) addendumKey(name string) string { return name + ".addendum.md" }

// loadAddendum returns the stored addendum of the task named name, empty when
// it has none.
func (ps *PromptService) loadAddendum(name string) string {
	s, err := ps.st.Load(domain.Prompts, ps.addendumKey(name))
	if err != nil {
		return ""
	}
	return string(s.Body())
}

// Addendum returns the addendum of the task named name: empty text when the
// task has none, never its brief.
func (ps *PromptService) Addendum(name string) (string, error) {
	if _, err := ps.Task(name); err != nil {
		return "", err
	}
	return ps.loadAddendum(name), nil
}

// SaveAddendum stores text as the addendum of the task named name. Empty or
// whitespace-only text deletes it: no empty addendum is stored.
func (ps *PromptService) SaveAddendum(name string, text string) error {
	if _, err := ps.Task(name); err != nil {
		return err
	}
	if strings.TrimSpace(text) == "" {
		return ps.DeleteAddendum(name)
	}
	_, err := ps.st.CreateText(domain.Prompts, ps.addendumKey(name), []byte(text))
	return err
}

// DeleteAddendum removes the addendum of the task named name; a task with none
// is left as it is.
func (ps *PromptService) DeleteAddendum(name string) error {
	s, err := ps.st.Load(domain.Prompts, ps.addendumKey(name))
	if err != nil {
		return nil
	}
	return ps.st.Delete(s)
}

// ListPrompts returns every task's entry, with whether it has an addendum.
func (ps *PromptService) ListPrompts() []PromptEntry {
	out := make([]PromptEntry, 0, len(ps.tasks))
	for _, t := range ps.tasks {
		p := PromptEntry{
			ID:          "prompt:" + t.Name,
			Name:        t.Name,
			DisplayName: t.DisplayName,
		}
		if s, err := ps.st.Load(domain.Prompts, ps.addendumKey(t.Name)); err == nil {
			p.IsVirtual = false
			p.Path = s.ExternalRef()
		} else {
			p.IsVirtual = true
		}
		out = append(out, p)
	}
	return out
}

// sieveBackground is the Background layer of every prompt: what Sieve is and
// how a run reads. sieveToolsBackground follows it when the run carries the
// Sieve tools.
const sieveBackground = `You are working inside Sieve, a personal tool for notes and thinking. What Sieve keeps is made of blocks: prose, code, a diagram, an image, a link card and others. A note is an ordered list of blocks; the other things Sieve keeps, such as a handwritten notebook or a conversation, hold blocks in their own way. Everything in Sieve has a sieve:// address, a standard URI: sieve://{container}/{leaf}. A container is a note or anything else Sieve keeps whole, and its own address is sieve://{container}. A leaf is a block or a file inside it. Every block has an id and sits in a container, so a block's address is its container's address, a /, and the block's id. In a note's markdown a block's id is in its <!--s:{id}--> marker or the id: line of its fenced block.

Work silently: do not describe your searches, tool calls or reasoning.

Read only the files this prompt names. Do not scan the disk, and draw no conclusion from a file's name or path.`

const sieveToolsBackground = `The Sieve tools read the user's library: search it, read a note, or read whatever a sieve:// address names.`

// directAnswerOnly closes every Delivery layer.
const directAnswerOnly = `- DIRECT ANSWER ONLY: The answer must only contain the answer to the user's question: no commentary on your work, the tools you used or your search.`

// answerToolGuidance is the Delivery layer of a run that carries the Sieve
// tools: its answer may be written as blocks with add_to_answer.
const answerToolGuidance = `- ANSWER IN BLOCKS OR TEXT: Favour writing your answer as Sieve blocks with the add_to_answer tool whenever it contains anything a Sieve block represents more richly than running text: code, a diagram, a table, other structured content. Write one block per call, in reading order; describe_answer lists the block types. An answer that is running text and nothing else may simply be your final message, in clean markdown. Once you have used add_to_answer your final message is not shown, so the whole answer must then be written with the tool.

` + directAnswerOnly

// answerPlainGuidance is the Delivery layer of a run without the Sieve tools.
const answerPlainGuidance = `Write your answer as your final message, in clean markdown.

` + directAnswerOnly

// The Default*Prompt constants are the tasks' briefs: what each job is for and
// what it must return. A run's values follow a brief in its Data layer.

const DefaultFilingPrompt = `
Given the following content, decide if it is worth keeping
as a permanent note in a knowledge stash.

Select the most appropriate existing folder for this content.
If the content belongs to a distinct topic not covered by existing folders, suggest a new, appropriately named folder.
If the content is too generic, leave the folder empty for root.

### Signals (their values are under Document Context in the data):
- Focus Signal: the number of times the file has been opened, or of 5 minute increments it has spent in focus.
- Iteration: manual refinement by the user.

### Evaluation Criteria (BE CRITICAL):
- Information Density: Is the content substantial? Gibberish, single sentences, or trivial tests should be discarded.
  Evaluate density from the content as it currently stands. Do NOT infer value from
  how the content arrived, or from how much it has changed since.
- Age/Staleness: Take into account how old the document is relative to 'Current Time'.
- Engagement: 'Focus Signal', 'Iteration' and the created-to-modified duration are
  evidence FOR keeping and never against. Their ABSENCE is not evidence of low
  value: content can arrive complete and require no refinement. Their PRESENCE is
  evidence of value you may not be able to see by reading alone.

### Voting Logic (ENGAGEMENT ONLY EVER ARGUES FOR KEEPING):
1. DISCARD (keep:false) only if content is low-density AND shows no engagement:
   gibberish, meta-talk about the application itself, a single trivial sentence,
   or boilerplate carrying no specifics.
   EXCEPTION: where focus signal or iteration is high, the user has returned to
   this content repeatedly — treat that as evidence it carries value your reading
   is missing. Terse reference material (lookup tables, command snippets,
   key-value lists, config fragments) is COMPRESSED, not empty. Prefer KEEP.
2. KEEP (keep:true) if the content carries substantial non-obvious information — a
   dense reference dump, a complex code block, structured data, several distinct
   factual points, or material clearly authored elsewhere and captured here. This
   holds REGARDLESS of iteration or focus signal.
3. Where content is neither clearly dense nor clearly trivial, let engagement
   decide: iteration > 2, focus signal > 3, or a long created-to-modified gap
   favours KEEP.
4. NEVER discard dense content for lack of refinement or low focus signal.

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
`

const DefaultExplainPrompt = `
[PERSONA]
Act as a highly efficient research assistant. Provide the answer concisely with insight, drawing connections from the user's notes.

[RESPONSE PROTOCOL]

- SYNTHESIZE: If information is gathered from multiple files (e.g., the knowledge base and the image), merge them into a single, cohesive response without citing the specific filenames unless they are requested.

[TASK]
You are part of an ongoing analysis thread. The user will provide a TARGET (the root piece of content), a THREAD (the history of questions and explanations about that target), and an ACTION to perform.
Your task is to explain the specific node requested in the ACTION clearly and concisely.
Do not repeat the content. Just explain the requested node.

TARGET is one or more blocks, each opened by a "===== BLOCK n of m · kind =====" line and headed by its ADDRESS.

THREAD entries are oldest first, each opened by a "===== TURN n of m =====" line. Each THREAD entry has an ADDRESS, a label indicating what it refers to (QUESTION ABOUT: <address> =question asked specifically about that prior node; EXPLAIN NODE: <address> = an explanation of that prior node), and an **ANSWER:** showing the response. The ACTION entry has the same structure but no answer yet — that's what you provide.

TARGET is the subject of the question and the sole source of document truth; ground anything you say about the document in TARGET as it stands now.
THREAD is the conversation so far about this TARGET. Use it to understand follow-ups and to build on or expand earlier answers when the ACTION asks you to. THREAD answers were written against earlier versions of the TARGET, so when you quote or describe the document itself, always use TARGET as it stands now — not document text repeated inside THREAD.
`

const DefaultAskPrompt = `
[PERSONA]
Act as a highly efficient research assistant. Provide the answer concisely with insight, drawing connections from the user's notes.

[RESPONSE PROTOCOL]

- SYNTHESIZE: If information is gathered from multiple files (e.g., the knowledge base and the image), merge them into a single, cohesive response without citing the specific filenames unless they are requested.

[TASK]
You are part of an ongoing analysis thread. The user will provide a TARGET (the root piece of content), a THREAD (the history of questions and explanations about that target), and an ACTION to perform.
Your task is to answer the user's question clearly and concisely.

TARGET is one or more blocks, each opened by a "===== BLOCK n of m · kind =====" line and headed by its ADDRESS.

THREAD entries are oldest first, each opened by a "===== TURN n of m =====" line. Each THREAD entry has an ADDRESS, a label indicating what it refers to (QUESTION ABOUT: <address> =question asked specifically about that prior node;  EXPLAIN NODE: <address> = an explanation of that prior node), and an **ANSWER:** showing the response. The ACTION entry has the same structure but no answer yet — that's what you provide.

TARGET is the subject of the question and the sole source of document truth; ground anything you say about the document in TARGET as it stands now.
THREAD is the conversation so far about this TARGET. Use it to understand follow-ups and to build on or expand earlier answers when the ACTION asks you to. THREAD answers were written against earlier versions of the TARGET, so when you quote or describe the document itself, always use TARGET as it stands now — not document text repeated inside THREAD.
`

const DefaultChatPrompt = `
[PERSONA]
Act as a highly efficient research assistant. Provide the answer concisely with insight, drawing connections from the user's notes.

[RESPONSE PROTOCOL]

- SYNTHESIZE: If information is gathered from multiple files (e.g., the knowledge base and the image), merge them into a single, cohesive response without citing the specific filenames unless they are requested.

[TASK]
You are continuing a conversation with the user. The user will provide a THREAD (the conversation so far), ABOUT when the question points at material, and the QUESTION to answer now.
Your task is to answer the QUESTION clearly and concisely, as the next turn of the conversation.

THREAD is the conversation so far, oldest first. Each turn is opened by a "===== TURN n =====" line and headed by its ADDRESS, then shows the question that was asked and the **ANSWER:** given to it. A question that pointed at something opens with a "QUESTION ABOUT:" line giving the addresses of what it pointed at. Use it to understand follow-ups and to build on or revise earlier answers when the QUESTION asks you to. A question that points at a turn names that turn's ADDRESS. When there is no THREAD, the QUESTION opens the conversation.

ABOUT, when present, is the material the QUESTION points at: one or more blocks, each opened by a "===== BLOCK n of m · kind =====" line and headed by its ADDRESS. Ground anything you say about that material in ABOUT as it stands now.

QUESTION is what to answer now. It has the same structure as a THREAD turn but no answer yet — that's what you provide.
`

const DefaultImagePrompt = `Describe the image file and help me describe and categorise it.

Respond ONLY with valid JSON. No preamble.

{
  "alt": "brief alt text for accessibility (30 words or fewer)",
  "summary": "1-2 sentence neutral description for search and context"
}
`

const DefaultNoteMetaPrompt = `The image files listed under Page files, in this directory, are the pages of one handwritten note, in page order.

Open each one, read the handwriting and look at any drawings, then describe the note as a whole.

- title: a short, specific title saying what the note is about, in at most eight words. Never a generic title such as "Notes", "Untitled" or "Meeting notes", and never a date alone.
- keywords: up to 8 keywords or short phrases for what the note covers.
- categories: from 0 to 3 categories, chosen only from the Categories listed. Give none when none fits.
- summary: two or three plain sentences saying what the note holds.

Respond ONLY with raw JSON. DO NOT use markdown code fences (triple backticks). No preamble or explanation.
{
  "title": "Short specific title",
  "keywords": ["keyword", "short phrase"],
  "categories": ["category"],
  "summary": "Two or three sentences."
}
`

const DefaultChatMetaPrompt = `THREAD, under Data, is one conversation between a person and a model, oldest turn first. Each turn is opened by a "===== TURN n =====" line, then shows the question the person asked and the **ANSWER:** the model gave.

Read the whole conversation, then describe it as a whole: what the person was asking about and what they came away with, not how the conversation went.

- title: a short, specific title saying what the conversation is about, in at most eight words. Never a generic title such as "Chat", "Question", "Untitled" or "Conversation", and never a date alone.
- keywords: up to 8 keywords or short phrases for what the conversation covers.
- categories: from 0 to 3 categories, chosen only from the Categories listed. Give none when none fits.
- summary: two or three plain sentences saying what the conversation holds.

Respond ONLY with raw JSON. DO NOT use markdown code fences (triple backticks). No preamble or explanation.
{
  "title": "Short specific title",
  "keywords": ["keyword", "short phrase"],
  "categories": ["category"],
  "summary": "Two or three sentences."
}
`

const DefaultPageTranscriptPrompt = `The image file named under Page file, in this directory, is one page of a handwritten note.

Open it and read the whole page, from top to bottom, as a list of parts in the order they appear on the page.

- Handwriting is a "text" part. Transcribe it faithfully as markdown. Keep headings, lists, emphasis and line structure where the writer clearly meant them. Correct nothing but obvious slips of the pen. Write a word you cannot read as [?].
- A hand-drawn diagram (boxes and arrows, a flow, a sequence, a hierarchy) is a "diagram" part. Write it as a Mermaid diagram, with "language": "mermaid". Use PlantUML, with "language": "plantuml", only when Mermaid cannot express it. Keep the writer's labels as they are written.
- A drawing that is not a diagram is a "text" part of one italic line saying what it shows.

Respond ONLY with raw JSON. DO NOT use markdown code fences (triple backticks). No preamble or explanation.
{
  "parts": [
    {"type": "text", "markdown": "# Heading\n\nWhat was written."},
    {"type": "diagram", "language": "mermaid", "source": "flowchart TD\n  A --> B"}
  ]
}
`

const DefaultRefinePrompt = `Identify the programming language of this code snippet.
Reply with ONLY the lowercase language name (e.g. python, go, javascript, typescript, rust, java, c, cpp, sql, bash, yaml, json, xml, html, css, ruby, php, swift, kotlin, dart, markdown, csharp, toml, ini, dockerfile, makefile, lua, powershell).
If you cannot identify a specific language confidently, reply with exactly: text
`

const DefaultWebClipFetchPrompt = `Please retrieve the content at the following URL and return it as clean, well-structured markdown. Preserve all meaningful content including headings, lists, tables, and code blocks.
Please ensure to grab any relevant images and include those as well.
Do not summarise - preserve content as is.  Your job is to simply retrieve the document and translate to markdown as per the instructions above.
`

const DefaultWebClipSummarisePrompt = `Please retrieve the content at the following URL and return a
  concise markdown summary targeted to the context of the document below. Focus on aspects of the
  retrieved content that are most relevant to what is already in the document. Omit navigation,
  boilerplate, author bios, and related links.
  Only include an image if it directly illustrates a key point in your summary and cannot be adequately
  conveyed in text alone, and it relates to the document context below.
  `

const DefaultBtwPrompt = `You are answering a quick side-question a writer asked ("/btw") while working on a document. Answer the question concisely and directly.

- SELECTED TEXT: may be empty; if present, the question is likely about it.
- BACKGROUND: ambient context for disambiguation only. Do not analyze the document, do not suggest edits, and do not mention it unless the question requires it.

Read the document only if the question genuinely requires its content; prefer answering directly.

Keep the answer short: a few sentences, or a compact list or snippet when clearer. No preamble, no closing questions.
`
