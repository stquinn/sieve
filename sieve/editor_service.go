package sieve

import (
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
	"sieve/sieve/fencedblock"
)

// SieveBlock is the Go representation of any fenced YAML block.
// Kind comes from the fence info string — it is never written to the YAML body.
type SieveBlock struct {
	ID    string
	Kind  string                 // from fence info string
	Attrs map[string]interface{} // all YAML fields including "id"
}

// ShadowDocument holds the in-memory editor state for one open document.
// Mode controls how Flush and Remux behave ("wysiwyg" or "markdown").
type ShadowDocument struct {
	UUID     string
	Markdown string                 // full document from TipTap; block rawYaml may be stale
	Blocks   map[string]*SieveBlock // user-edited blocks; authoritative over shadow.Markdown
	Mode     string                 // "wysiwyg" (default) or "markdown"
	mu       sync.Mutex
	timer    *time.Timer
	onFlush  func()
}

func newShadow(uuid, body string, onFlush func()) *ShadowDocument {
	return &ShadowDocument{
		UUID:     uuid,
		Markdown: body,
		Blocks:   make(map[string]*SieveBlock),
		Mode:     "wysiwyg",
		onFlush:  onFlush,
	}
}

func (s *ShadowDocument) setMarkdown(md string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Markdown = md
	s.resetDebounce()
}

// setBlock creates or merges attrs into the named block. kind is only used
// when creating a new entry; subsequent calls preserve the existing Kind.
func (s *ShadowDocument) setBlock(kind, blockID string, attrs map[string]interface{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if blk, ok := s.Blocks[blockID]; ok {
		for k, v := range attrs {
			blk.Attrs[k] = v
		}
	} else {
		merged := make(map[string]interface{}, len(attrs))
		for k, v := range attrs {
			merged[k] = v
		}
		s.Blocks[blockID] = &SieveBlock{ID: blockID, Kind: kind, Attrs: merged}
	}
	s.resetDebounce()
}

func (s *ShadowDocument) resetDebounce() {
	if s.onFlush == nil {
		return
	}
	if s.timer != nil {
		s.timer.Stop()
	}
	s.timer = time.AfterFunc(1*time.Second, s.onFlush)
}

func (s *ShadowDocument) stopDebounce() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
}

// Remux returns shadow.Markdown with each block in shadow.Blocks replaced by
// a freshly serialised fence. In markdown mode it returns Markdown verbatim —
// the user is editing raw YAML directly, so no substitution is needed.
func (s *ShadowDocument) Remux() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Mode == "markdown" {
		return s.Markdown
	}
	out := s.Markdown
	for _, blk := range s.Blocks {
		updated, err := fencedblock.Replace[map[string]interface{}](out, blk.Kind, blk.ID, blk.Attrs)
		if err == nil {
			out = updated
		}
	}
	return out
}

// parseAllBlocks scans body for all named fenced blocks (```kind where kind != "")
// and returns them keyed by block ID. Used when re-entering WYSIWYG mode so that
// any block YAML the user edited directly in markdown mode is picked up.
func parseAllBlocks(body string) map[string]*SieveBlock {
	blocks := make(map[string]*SieveBlock)
	lines := strings.Split(body, "\n")
	i := 0
	for i < len(lines) {
		line := lines[i]
		if strings.HasPrefix(line, "```") && len(line) > 3 {
			kind := strings.TrimPrefix(line, "```")
			j := i + 1
			for j < len(lines) && lines[j] != "```" {
				j++
			}
			if j < len(lines) {
				content := strings.Join(lines[i+1:j], "\n")
				var attrs map[string]interface{}
				if yaml.Unmarshal([]byte(content), &attrs) == nil {
					if id, ok := attrs["id"].(string); ok && id != "" {
						blocks[id] = &SieveBlock{ID: id, Kind: kind, Attrs: attrs}
					}
				}
				i = j + 1
				continue
			}
		}
		i++
	}
	return blocks
}
