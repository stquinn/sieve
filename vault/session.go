package vault

import (
	"encoding/json"
	"os"
)

// Tab represents one open tab in a session.
// Path is relative to the vault root.
type Tab struct {
	Path        string `json:"path"`
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

// Session is the full contents of vault/{hostname}/session.json.
type Session struct {
	Tabs         []Tab  `json:"tabs"`
	Window       Window `json:"window,omitempty"`
	SidebarWidth int    `json:"sidebarWidth,omitempty"`
	MetaWidth    int    `json:"metaWidth,omitempty"`
}

// LoadSession reads session.json at path. Missing or corrupt file returns an
// empty session — caller is responsible for opening a default tab.
func LoadSession(path string) Session {
	data, err := os.ReadFile(path)
	if err != nil {
		return Session{}
	}
	var s Session
	if err := json.Unmarshal(data, &s); err != nil {
		return Session{}
	}
	return s
}

// Save writes the session to disk, creating or replacing the file.
func (s Session) Save(path string) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}
