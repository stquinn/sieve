package stash

// NoteEntry represents a single node in the Library tree.
// Directories have IsDir=true and a Children slice; files have a store-relative Path.
type NoteEntry struct {
	Name        string      `json:"name"`
	DisplayName string      `json:"displayName,omitempty"` // from frontmatter
	Path        string      `json:"path,omitempty"`        // store-relative, empty for directories
	UserIntent  string      `json:"userIntent,omitempty"`  // from frontmatter: "keep", "trash", or ""
	IsDir       bool        `json:"isDir"`
	Children    []NoteEntry `json:"children,omitempty"`
}

// SearchResult represents a single Library search match.
type SearchResult struct {
	Path           string `json:"path"` // store-relative
	Name           string `json:"name"`
	IsTagMatch     bool   `json:"isTagMatch"`
	IsSummaryMatch bool   `json:"isSummaryMatch"`
	IsBodyMatch    bool   `json:"isBodyMatch"`
	Snippet        string `json:"snippet"`
}
