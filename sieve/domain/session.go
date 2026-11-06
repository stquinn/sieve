package domain

import (
	"encoding/json"
	"strings"
)

// TabKindPrompt is the kind of a tab showing a prompt.
const TabKindPrompt = "prompt"

// Tab represents one open tab in a session.
type Tab struct {
	ID string `json:"id"` // UUID (or "prompt:name" for prompts)
	// Kind is the shown container's own noun: a DocumentKind, a block kind, or
	// TabKindPrompt. A session written before tabs carried one leaves it empty, so
	// read it through ContainerKind.
	Kind        string `json:"kind,omitempty"`
	Scroll      int    `json:"scroll"`
	Active      bool   `json:"active"`
	Mode        string `json:"mode"`                  // "wysiwyg" or "markdown"
	DisplayName string `json:"displayName,omitempty"` // cached display name — avoids blank label on startup
	Status      string `json:"status,omitempty"`      // "unfiled" or "filed"
	UserIntent  string `json:"userIntent,omitempty"`  // "keep" or "trash"
	Presenting  bool   `json:"presenting,omitempty"`  // left in Presentation Mode
}

// ContainerKind is the kind of container the tab shows. A tab saved without a kind
// is a prompt tab when its id is a prompt id, and otherwise a document: a filed
// one is a note, anything else a buffer.
func (t Tab) ContainerKind() string {
	switch {
	case t.Kind != "":
		return t.Kind
	case strings.HasPrefix(t.ID, "prompt:"):
		return TabKindPrompt
	case t.Status == KindNote.FiledStatus():
		return string(KindNote)
	default:
		return string(KindBuffer)
	}
}

// IsDocument reports whether the tab shows a document, which is what a close
// files and a status refresh re-reads.
func (t Tab) IsDocument() bool {
	return DocumentKind(t.ContainerKind()).IsDocument()
}

// Window holds the saved window position and size.
type Window struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

// Session is the full contents of store/{hostname}/session.json.
type Session struct {
	ActiveIdx         int      `json:"activeIdx"`
	Tabs              []Tab    `json:"tabs"`
	Window            Window   `json:"window,omitempty"`
	SidebarWidth      int      `json:"sidebarWidth,omitempty"`
	MetaWidth         int      `json:"metaWidth,omitempty"`
	ShowSidebar       bool     `json:"showSidebar"`
	ShowMeta          bool     `json:"showMeta"`
	ShowPrompts       bool     `json:"showPrompts"`
	PromptsHeight     int      `json:"promptsHeight,omitempty"`
	AskPanelHeight    int      `json:"askPanelHeight,omitempty"`
	OpenFolders       []string `json:"openFolders,omitempty"`
	LastSettingsPanel string   `json:"lastSettingsPanel,omitempty"`
	ShowToolbar       bool     `json:"showToolbar,omitempty"`
	ShowAskPanel      bool     `json:"showAskPanel"`
	// No omitempty: false must serialise so an explicit "off" survives reload.
	// Defaults to true in ParseSession; sessions predating the field keep numbers on.
	ShowLineNumbers bool `json:"showLineNumbers"`
}

// ParseSession decodes session JSON bytes into a Session.
// Nil/empty data or a corrupt file returns a sensible default — caller is
// responsible for opening a default tab.
func ParseSession(data []byte) Session {
	s := Session{
		ShowSidebar:     true,
		ShowPrompts:     true,
		ShowLineNumbers: true,
		PromptsHeight:   180,
		AskPanelHeight:  220,
		SidebarWidth:    250,
		MetaWidth:       300,
	}
	if len(data) == 0 {
		return s
	}
	if err := json.Unmarshal(data, &s); err != nil {
		return s
	}
	if s.SidebarWidth <= 0 {
		s.SidebarWidth = 250
	}
	if s.MetaWidth <= 0 {
		s.MetaWidth = 300
	}
	if s.AskPanelHeight <= 0 {
		s.AskPanelHeight = 220
	}
	return s
}

// Marshal serialises the session to indented JSON.
func (s Session) Marshal() ([]byte, error) {
	return json.MarshalIndent(s, "", "  ")
}

// Tab is the tab of id, and whether the session has one.
func (s Session) Tab(id string) (Tab, bool) {
	for _, t := range s.Tabs {
		if t.ID == id {
			return t, true
		}
	}
	return Tab{}, false
}

// ShowsNonDocument reports whether the session's tab of id shows something other
// than a document: false when it shows a document or there is no such tab.
func (s Session) ShowsNonDocument(id string) bool {
	tab, open := s.Tab(id)
	return open && !tab.IsDocument()
}

// CloseTabs removes every tab whose ID is in ids and keeps ActiveIdx pointing at
// the SAME active tab when it survives — otherwise the nearest surviving tab to
// its right (clamped left when the active tab was the last). This is the one
// close mechanism: a single close passes one id, Close All passes every id, Close
// Others passes the complement of the kept tab. It returns the closed NON-prompt
// tab ids — the documents the caller must Smart-Close file (`Editor.CloseDocument`);
// prompt tabs carry nothing to file. An emptied session is the caller's to handle
// (mint a fresh note): CloseTabs only mutates the tab list + active index.
func (s *Session) CloseTabs(ids []string) []string {
	closing := make(map[string]bool, len(ids))
	for _, id := range ids {
		closing[id] = true
	}
	oldIdx := s.ActiveIdx
	removedBefore := 0
	kept := make([]Tab, 0, len(s.Tabs))
	filed := make([]string, 0, len(ids))
	for i, t := range s.Tabs {
		if closing[t.ID] {
			if i < oldIdx {
				removedBefore++
			}
			if t.IsDocument() {
				filed = append(filed, t.ID)
			}
			continue
		}
		kept = append(kept, t)
	}
	s.Tabs = kept
	// oldIdx-removedBefore is the active tab's new index if it survived, else the
	// index the tab to its right slid into (nearest right). Clamp for empty / last.
	s.ActiveIdx = oldIdx - removedBefore
	if s.ActiveIdx >= len(s.Tabs) {
		s.ActiveIdx = len(s.Tabs) - 1
	}
	if s.ActiveIdx < 0 {
		s.ActiveIdx = 0
	}
	return filed
}

// SetFolderOpen records a folder as expanded or collapsed in the tree. It
// answers the caller's intent rather than flipping what it finds, so two
// clients disagreeing about a folder converge instead of alternating, and a
// retried request lands where the first one did.
func (s *Session) SetFolderOpen(id string, open bool) {
	for i, f := range s.OpenFolders {
		if f == id {
			if !open {
				s.OpenFolders = append(s.OpenFolders[:i], s.OpenFolders[i+1:]...)
			}
			return
		}
	}
	if open {
		s.OpenFolders = append(s.OpenFolders, id)
	}
}
