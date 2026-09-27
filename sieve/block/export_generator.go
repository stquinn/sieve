package block

// Export format words, as the export frame's format field spells them.
const (
	ExportFormatMarkdown   = "markdown"
	ExportFormatConfluence = "confluence"
)

// ExportGenerator renders one block of a document export into a target format.
// It is handed the block and that block's MarkdownRepresentation, and returns the
// block's text in the target format; an empty result drops the block from the
// export.
type ExportGenerator interface {
	RenderBlock(b SieveBlock, markdown string) string
}

// MarkdownGenerator exports each block as its MarkdownRepresentation, unchanged.
type MarkdownGenerator struct{}

// RenderBlock returns markdown as given.
func (MarkdownGenerator) RenderBlock(_ SieveBlock, markdown string) string { return markdown }

// ExportGenerators resolves an export format word to the generator that
// produces it.
type ExportGenerators struct{}

// Lookup returns a fresh generator for format, or false when no generator
// produces that format.
func (ExportGenerators) Lookup(format string) (ExportGenerator, bool) {
	switch format {
	case ExportFormatMarkdown:
		return MarkdownGenerator{}, true
	case ExportFormatConfluence:
		return NewConfluenceGenerator(), true
	}
	return nil, false
}
