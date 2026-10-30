package domain

// LinkPreviewResult holds Open Graph metadata fetched from a URL.
// OGImageURL is the raw OG image URL — callers are responsible for downloading
// and storing it via AssetService. Empty string means no image was found.
//
// It is a return type of block.LinkPreviewPort, so it lives in the leaf (block/
// must be able to name it without importing services/).
type LinkPreviewResult struct {
	Title       string
	Description string
	OGImageURL  string
	SiteName    string
}

// ReadablePage is a fetched page's readable article: its title, and HTML, a
// complete HTML document whose <title> carries Title and whose <body> is the
// extracted article content.
type ReadablePage struct {
	Title string
	HTML  string
}
