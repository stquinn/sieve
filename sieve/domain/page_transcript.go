package domain

// The types of a TranscriptPart.
const (
	TranscriptPartText    = "text"
	TranscriptPartDiagram = "diagram"
)

// PageTranscript is what a model transcribes from one handwritten page: its parts in the page's
// top-to-bottom order. It is what AIService.TranscribePage answers; nothing checks it beyond its parse.
type PageTranscript struct {
	Parts []TranscriptPart `json:"parts"`
}

// TranscriptPart is one part of a page's transcript. A text part carries Markdown; a diagram part
// carries the Language it is written in (mermaid or plantuml) and its Source.
type TranscriptPart struct {
	Type     string `json:"type"`
	Markdown string `json:"markdown,omitempty"`
	Language string `json:"language,omitempty"`
	Source   string `json:"source,omitempty"`
}
