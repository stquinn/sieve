package sieve

import (
	"encoding/json"
)

// Tab represents one open tab in a session.
type Tab struct {
	ID          string `json:"id"`                    // UUID (or "prompt:name" for prompts)
	Scroll      int    `json:"scroll"`
	Active      bool   `json:"active"`
	Mode        string `json:"mode"`                  // "wysiwyg" or "markdown"
	DisplayName string `json:"displayName,omitempty"` // cached display name — avoids blank label on startup
	Status      string `json:"status,omitempty"`      // "unfiled" or "filed"
	UserIntent  string `json:"userIntent,omitempty"`  // "keep" or "trash"
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
	ActiveIdx     int      `json:"activeIdx"`
	Tabs          []Tab    `json:"tabs"`
	Window        Window   `json:"window,omitempty"`
	SidebarWidth  int      `json:"sidebarWidth,omitempty"`
	MetaWidth     int      `json:"metaWidth,omitempty"`
	ShowSidebar   bool     `json:"showSidebar"`
	ShowMeta      bool     `json:"showMeta"`
	ShowPrompts   bool     `json:"showPrompts"`
	PromptsHeight int      `json:"promptsHeight,omitempty"`
	OpenFolders       []string `json:"openFolders,omitempty"`
	LastSettingsPanel string   `json:"lastSettingsPanel,omitempty"`
}

// ParseSession decodes session JSON bytes into a Session.
// Nil/empty data or a corrupt file returns a sensible default — caller is
// responsible for opening a default tab.
func ParseSession(data []byte) Session {
	s := Session{
		ShowSidebar:   true,
		ShowPrompts:   true,
		PromptsHeight: 180,
		SidebarWidth:  250,
		MetaWidth:     300,
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
	return s
}

// Marshal serialises the session to indented JSON.
func (s Session) Marshal() ([]byte, error) {
	return json.MarshalIndent(s, "", "  ")
}
