package vault

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// SearchResult represents a single vault search match.
type SearchResult struct {
	Path           string `json:"path"` // vault-relative
	Name           string `json:"name"`
	IsTagMatch     bool   `json:"isTagMatch"`
	IsSummaryMatch bool   `json:"isSummaryMatch"`
	IsBodyMatch    bool   `json:"isBodyMatch"`
	Snippet        string `json:"snippet"`
}

// SearchVault walks the provided directories concurrently and returns matches for query.
func SearchVault(vaultRoot string, searchDirs []string, query string) []SearchResult {
	if query == "" {
		return nil
	}

	queryLower := strings.ToLower(query)
	var mu sync.Mutex
	var results []SearchResult
	var wg sync.WaitGroup

	for _, dir := range searchDirs {
		err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() {
				if strings.HasPrefix(d.Name(), ".") {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.EqualFold(filepath.Ext(d.Name()), ".md") {
				return nil
			}

			wg.Add(1)
			go func(filePath string, entry fs.DirEntry) {
				defer wg.Done()

				content, err := os.ReadFile(filePath)
				if err != nil {
					return
				}
				text := string(content)

				// Parse out frontmatter and body
				var frontmatter, body string
				if strings.HasPrefix(text, "---\n") {
					parts := strings.SplitN(text[4:], "\n---\n", 2)
					if len(parts) == 2 {
						frontmatter = parts[0]
						body = parts[1]
					} else {
						body = text
					}
				} else {
					body = text
				}

				frontmatterLower := strings.ToLower(frontmatter)
				bodyLower := strings.ToLower(body)

				isTagMatch := false
				isSummaryMatch := false
				isBodyMatch := false
				var snippet string

				// Naive check for tags and summary in frontmatter
				for _, line := range strings.Split(frontmatterLower, "\n") {
					if strings.HasPrefix(line, "tags:") {
						if strings.Contains(line, queryLower) {
							isTagMatch = true
						}
					} else if strings.HasPrefix(line, "summary:") {
						if strings.Contains(line, queryLower) {
							isSummaryMatch = true
						}
					}
				}

				if strings.Contains(bodyLower, queryLower) {
					isBodyMatch = true
					idx := strings.Index(bodyLower, queryLower)
					// Extract snippet
					start := idx - 30
					if start < 0 {
						start = 0
					}
					end := idx + len(queryLower) + 30
					if end > len(bodyLower) {
						end = len(bodyLower)
					}

					snippet = strings.ReplaceAll(body[start:end], "\n", " ")
					if start > 0 {
						snippet = "..." + snippet
					}
					if end < len(bodyLower) {
						snippet = snippet + "..."
					}
				}

				if isTagMatch || isSummaryMatch || isBodyMatch {
					rel, err := filepath.Rel(vaultRoot, filePath)
					if err != nil {
						rel = filePath
					}

					if snippet == "" {
						// Fallback to getting a summary snippet if only frontmatter matched
						if isSummaryMatch {
							for _, line := range strings.Split(frontmatter, "\n") {
								if strings.HasPrefix(strings.ToLower(line), "summary:") {
									sn := strings.TrimSpace(line[8:])
									if len(sn) > 60 {
										sn = sn[:60] + "..."
									}
									snippet = sn
									break
								}
							}
						}
					}

					mu.Lock()
					results = append(results, SearchResult{
						Path:           filepath.ToSlash(rel),
						Name:           strings.TrimSuffix(entry.Name(), ".md"),
						IsTagMatch:     isTagMatch,
						IsSummaryMatch: isSummaryMatch,
						IsBodyMatch:    isBodyMatch,
						Snippet:        strings.TrimSpace(snippet),
					})
					mu.Unlock()
				}
			}(path, d)
			return nil
		})
		if err != nil {
			fmt.Printf("[stash] error walking vault dir %s: %v\n", dir, err)
		}
	}

	wg.Wait()
	return results
}
