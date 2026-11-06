package domain

// The types of a ReadingPart.
const (
	ReadingPartText    = "text"
	ReadingPartDiagram = "diagram"
)

// PageReading is what a model reads off one handwritten page: its parts in the page's
// top-to-bottom order. It is what AIService.ReadPage answers; nothing checks it beyond its parse.
type PageReading struct {
	Parts []ReadingPart `json:"parts"`
}

// ReadingPart is one part of a page's reading. A text part carries Markdown; a diagram part
// carries the Language it is written in (mermaid or plantuml) and its Source.
type ReadingPart struct {
	Type     string `json:"type"`
	Markdown string `json:"markdown,omitempty"`
	Language string `json:"language,omitempty"`
	Source   string `json:"source,omitempty"`
}
