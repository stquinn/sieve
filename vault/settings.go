package vault

import (
	"encoding/json"
	"os"
	"os/exec"
	"strings"
)

// Tier represents the capability level of the app based on CLI availability.
type Tier int

const (
	TierDumb  Tier = 1 // no CLI configured or not on PATH
	TierSmart Tier = 2 // CLI configured and available
)

// Settings mirrors vault/{hostname}/settings.json.
// All fields are optional — missing keys fall back to defaults.
type Settings struct {
	CLI              string  `json:"cli,omitempty"`
	CLITimeout       int     `json:"cli_timeout,omitempty"`
	CLITimeoutLong   int     `json:"cli_timeout_long,omitempty"`
	AutosaveDebounce int     `json:"autosave_debounce,omitempty"`
	Debug            bool    `json:"debug,omitempty"`
	Theme            string  `json:"theme,omitempty"`
	Prompts          Prompts `json:"prompts,omitempty"`
}

// Prompts holds paths to the three prompt template files.
type Prompts struct {
	File    string `json:"file,omitempty"`
	Explain string `json:"explain,omitempty"`
	Ask     string `json:"ask,omitempty"`
}

// Tier returns the capability tier based on whether the configured CLI is
// reachable on PATH. Failing to find it degrades silently to Tier 1.
func (s Settings) Tier() Tier {
	if s.CLI == "" {
		return TierDumb
	}
	// LookPath respects PATH from the environment. When launched from the Dock
	// on macOS the inherited PATH is minimal, so we resolve the login shell PATH
	// first to find tools installed in /usr/local/bin, /opt/homebrew/bin, etc.
	if err := os.Setenv("PATH", LoginPath()); err == nil {
		if _, err := exec.LookPath(s.CLI); err != nil {
			return TierDumb
		}
	}
	return TierSmart
}

// Save writes the settings to path as indented JSON.
func (s Settings) Save(path string) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// LoadSettings reads settings.json at path and merges it with defaults.
// If the file is missing it writes defaults to disk so the user can see
// all available options. A corrupt file returns defaults without writing.
func LoadSettings(path string) Settings {
	s := defaults()

	data, err := os.ReadFile(path)
	if err != nil {
		// File missing — write defaults so the user can inspect and edit them
		_ = s.Save(path)
		return s
	}

	var loaded Settings
	if err := json.Unmarshal(data, &loaded); err != nil {
		return s // corrupt — use defaults
	}

	// Overlay loaded values, keeping defaults for zero values
	if loaded.CLI != "" {
		s.CLI = loaded.CLI
	}
	if loaded.CLITimeout > 0 {
		s.CLITimeout = loaded.CLITimeout
	}
	if loaded.CLITimeoutLong > 0 {
		s.CLITimeoutLong = loaded.CLITimeoutLong
	}
	if loaded.AutosaveDebounce > 0 {
		s.AutosaveDebounce = loaded.AutosaveDebounce
	}
	s.Debug = loaded.Debug
	if loaded.Prompts.File != "" {
		s.Prompts.File = loaded.Prompts.File
	}
	if loaded.Prompts.Explain != "" {
		s.Prompts.Explain = loaded.Prompts.Explain
	}
	if loaded.Prompts.Ask != "" {
		s.Prompts.Ask = loaded.Prompts.Ask
	}
	if loaded.Theme != "" {
		s.Theme = loaded.Theme
	}

	return s
}

// LoginPATH returns the PATH as seen by a login shell, which includes paths
// like /usr/local/bin and /opt/homebrew/bin that are absent when macOS launches
// an app from the Dock or Finder.
func LoginPath() string {
	cmd := exec.Command("/bin/bash", "-l", "-c", "echo $PATH")
	out, err := cmd.Output()
	if err != nil {
		return os.Getenv("PATH")
	}
	return strings.TrimSpace(string(out))
}

func defaults() Settings {
	return Settings{
		CLITimeout:       20,
		CLITimeoutLong:   60,
		AutosaveDebounce: 30,
		Theme:            "sublime",
	}
}
