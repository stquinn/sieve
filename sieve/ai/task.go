package ai

import (
	"fmt"
	"strings"
	"time"
)

// Layer is one part of a prompt: a heading and the text under it.
type Layer struct {
	Heading string
	Text    string
}

// IsEmpty reports whether the layer has no text to send.
func (l Layer) IsEmpty() bool { return strings.TrimSpace(l.Text) == "" }

// String renders the layer as its heading, a blank line, then its text with
// surrounding blank space trimmed.
func (l Layer) String() string {
	return l.Heading + "\n\n" + strings.TrimSpace(l.Text)
}

// The headings the model sees over each layer.
const (
	backgroundHeading = "# Sieve"
	deliveryHeading   = "# Answer"
	briefHeading      = "# Task"
	addendumHeading   = "# Addendum"
	dataHeading       = "# Data"
)

// Prompt is everything a run tells the model, in five layers sent in this
// order: Background (what Sieve is), Delivery (how a CONTENT answer is
// written), Brief (what the task is for and must return), Addendum (what this
// installation adds to the brief) and Data (this run's values). Layers 1 to 3
// are the system's (System), layers 4 and 5 the run's input (Input).
type Prompt struct {
	Background, Delivery, Brief, Addendum, Data Layer
}

// Layers returns the prompt's layers in order, leaving out the empty ones.
func (p Prompt) Layers() []Layer {
	return p.present(p.Background, p.Delivery, p.Brief, p.Addendum, p.Data)
}

// String renders every non-empty layer under its heading, separated by a blank
// line: the whole prompt, for a backend that sends it in one piece.
func (p Prompt) String() string { return p.render(p.Layers()) }

// System renders the non-empty layers of Background, Delivery and Brief as
// String does.
func (p Prompt) System() string { return p.render(p.present(p.Background, p.Delivery, p.Brief)) }

// Input renders the non-empty layers of Addendum and Data as String does.
func (p Prompt) Input() string { return p.render(p.present(p.Addendum, p.Data)) }

// FrameworkLayers renders the layers the framework writes, Background and
// Delivery, as String does: the same for every run of a task.
func (p Prompt) FrameworkLayers() string { return p.render(p.present(p.Background, p.Delivery)) }

// TaskLayers renders the layers that are the task's and the run's, Brief,
// Addendum and Data, as String does.
func (p Prompt) TaskLayers() string { return p.render(p.present(p.Brief, p.Addendum, p.Data)) }

// present returns layers in the order given, leaving out the empty ones.
func (Prompt) present(layers ...Layer) []Layer {
	var out []Layer
	for _, l := range layers {
		if !l.IsEmpty() {
			out = append(out, l)
		}
	}
	return out
}

// render joins layers, each under its heading, with a blank line between.
func (Prompt) render(layers []Layer) string {
	parts := make([]string, len(layers))
	for i, l := range layers {
		parts[i] = l.String()
	}
	return strings.Join(parts, "\n\n")
}

// Output is what a task produces, which decides how its answer is delivered.
type Output int

const (
	// Content is blocks for a reader, written into an answer holder; a plain
	// final message is taken as prose.
	Content Output = iota + 1
	// Data is a result returned to the Go caller in the shape its brief states.
	Data
)

// Task is one kind of AI job. Name keys its timeout override, its log lines and
// its stored addendum; DisplayName is what the Prompts dialog shows.
type Task struct {
	Name        string
	DisplayName string
	Output      Output
	Brief       Layer
}

// Writes reports whether the task's run may write into a document, as an answer
// for a reader: a Content task's does, a Data task's returns its result to the
// Go caller and writes nothing.
func (t Task) Writes() bool { return t.Output == Content }

// TaskData is one run's values for a task. Text renders them as the prompt's
// Data layer, each under a plain label; a value is written verbatim.
type TaskData interface {
	Text() string
}

// FilingData is the data of the file task: the document to judge and the
// signals its brief weighs.
type FilingData struct {
	Folders    []string // the library's existing top-level folders
	Now        time.Time
	Created    time.Time // zero when unknown
	Modified   time.Time // zero when unknown
	FocusCount int
	Version    int // 0 is read as the first version
	Content    string
}

func (d FilingData) Text() string {
	folders := strings.Join(d.Folders, ", ")
	if folders == "" {
		folders = "(none yet)"
	}
	version := d.Version
	if version == 0 {
		version = 1
	}
	return fmt.Sprintf("Existing folders: %s\n\nDocument Context:\n- Current Time: %s\n- Created: %s\n- Modified: %s\n- Focus Signal: %d\n- Iteration: %d\n\nContent:\n%s",
		folders, d.Now.Format(time.RFC3339), d.timestamp(d.Created), d.timestamp(d.Modified), d.FocusCount, version, d.Content)
}

func (FilingData) timestamp(t time.Time) string {
	if t.IsZero() {
		return "unknown"
	}
	return t.Format("2006-01-02T15:04:05")
}

// ThreadData is the data of the ask and explain tasks: the target, the thread
// about it so far, and the action to answer.
type ThreadData struct {
	ContentType string
	Content     string
	History     string
	Action      string
}

func (d ThreadData) Text() string {
	return fmt.Sprintf("Content type: %s\n\nTARGET:\n%s\n\n---\n---\n\nTHREAD:\n%s\n\n---\n---\n\nACTION:\n%s",
		d.ContentType, d.Content, d.History, d.Action)
}

// ChatData is the data of the chat task: the conversation so far, what the
// question points at, and the question to answer now.
type ChatData struct {
	// Turns are the exchanges before this one, oldest first.
	Turns []ChatTurn
	// About is the material the question points at, "" when it points at none.
	About string
	// Question is the exchange being answered, as it is shown with no answer.
	Question string
}

// ChatTurn is one earlier exchange of a chat: its absolute address and its
// text, question and answer.
type ChatTurn struct {
	Address string
	Text    string
}

// Text prints THREAD, ABOUT and QUESTION, in that order, each only when it has
// content. Turn n is printed under the line "===== TURN n =====", then its
// "ADDRESS:" line, then its text; nothing printed for a turn depends on a later
// one.
func (d ChatData) Text() string {
	var sections []string
	if len(d.Turns) > 0 {
		turns := make([]string, len(d.Turns))
		for i, turn := range d.Turns {
			turns[i] = fmt.Sprintf("===== TURN %d =====\nADDRESS: %s\n%s", i+1, turn.Address, turn.Text)
		}
		sections = append(sections, "THREAD:\n"+strings.Join(turns, "\n\n"))
	}
	if strings.TrimSpace(d.About) != "" {
		sections = append(sections, "ABOUT:\n"+d.About)
	}
	if strings.TrimSpace(d.Question) != "" {
		sections = append(sections, "QUESTION:\n"+d.Question)
	}
	return strings.Join(sections, "\n\n---\n---\n\n")
}

// BtwData is the data of the btw task: the question, the selection it may be
// about, and the open document's title and summary as background.
type BtwData struct {
	Question   string
	Selection  string
	DocTitle   string
	DocSummary string
}

func (d BtwData) Text() string {
	return fmt.Sprintf("QUESTION:\n%s\n\nSELECTED TEXT:\n%s\n\nBACKGROUND:\n- Document title: %s\n- Document summary: %s",
		d.Question, d.Selection, d.DocTitle, d.DocSummary)
}

// ImageData is the data of the image task: the file name of the image, in the
// run's working directory.
type ImageData struct {
	File string
}

func (d ImageData) Text() string { return "Image file: " + d.File }

// NoteMetaData is the data of the note-meta task: the file names of a note's
// page images in page order, in the run's working directory, and the
// categories to choose from.
type NoteMetaData struct {
	Pages      []string
	Categories []string
}

func (d NoteMetaData) Text() string {
	var b strings.Builder
	b.WriteString("Page files:")
	for i, page := range d.Pages {
		fmt.Fprintf(&b, "\n%d. %s", i+1, page)
	}
	categories := strings.Join(d.Categories, ", ")
	if categories == "" {
		categories = "(none)"
	}
	fmt.Fprintf(&b, "\n\nCategories: %s", categories)
	return b.String()
}

// ChatMetaData is the data of the chat-meta task: a chat's answered exchanges,
// oldest first, each its question and answer as the chat task's thread shows a
// turn, and the categories to choose from.
type ChatMetaData struct {
	Turns      []string
	Categories []string
}

// Text prints THREAD, each turn under the line "===== TURN n =====", then the
// categories offered.
func (d ChatMetaData) Text() string {
	turns := make([]string, len(d.Turns))
	for i, turn := range d.Turns {
		turns[i] = fmt.Sprintf("===== TURN %d =====\n%s", i+1, turn)
	}
	categories := strings.Join(d.Categories, ", ")
	if categories == "" {
		categories = "(none)"
	}
	return "THREAD:\n" + strings.Join(turns, "\n\n") + "\n\n---\n---\n\nCategories: " + categories
}

// PageTranscriptData is the data of the page-transcript task: the file name of
// one page image, in the run's working directory.
type PageTranscriptData struct {
	File string
}

func (d PageTranscriptData) Text() string { return "Page file: " + d.File }

// RefineData is the data of the refine task: a code snippet and what detection
// has said of its language so far.
type RefineData struct {
	Content         string
	CurrentLanguage string
	DetectionMethod string
}

func (d RefineData) Text() string {
	return fmt.Sprintf("Current Detection State (use as a signal/context, but make up your own mind):\n- Current Language: %s\n- Detection Method: %s\n\nCode:\n%s",
		d.CurrentLanguage, d.DetectionMethod, d.Content)
}

// WebClipFetchData is the data of the web-clip-fetch task: the URL to retrieve.
type WebClipFetchData struct {
	Source string
}

func (d WebClipFetchData) Text() string { return "URL: " + d.Source }

// WebClipSummariseData is the data of the web-clip-summarise task: the URL to
// summarise and the document the summary is for.
type WebClipSummariseData struct {
	Source   string
	Document string
}

func (d WebClipSummariseData) Text() string {
	return "URL: " + d.Source + "\n\nCurrent document context:\n" + d.Document
}
