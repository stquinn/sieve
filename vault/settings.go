package vault

import (
	"encoding/json"
	"os"
	"os/exec"
	"strings"

	"stash/logger"
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
	CLI                string  `json:"cli,omitempty"`
	Model              string  `json:"model,omitempty"`
	CLITimeout         int     `json:"cli_timeout,omitempty"`
	CLITimeoutLong     int     `json:"cli_timeout_long,omitempty"`
	AutosaveDebounce   int     `json:"autosave_debounce,omitempty"`
	Debug              bool    `json:"debug,omitempty"`
	Theme              string  `json:"theme,omitempty"`
	Prompts            Prompts `json:"prompts,omitempty"`
	MaxHistoryVersions int     `json:"max_history_versions,omitempty"`
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
	logger.Debug("tier check start", "cli", s.CLI, "inherited_path", os.Getenv("PATH"))

	if s.CLI == "" {
		logger.Debug("tier check: no CLI configured, returning TierDumb")
		return TierDumb
	}

	// LookPath respects PATH from the environment. When launched from the Dock
	// on macOS the inherited PATH is minimal, so we resolve the login shell PATH
	// first to find tools installed in /usr/local/bin, /opt/homebrew/bin, etc.
	resolved := LoginPath()
	if err := os.Setenv("PATH", resolved); err != nil {
		logger.Error("tier check: failed to set PATH", "err", err)
		return TierDumb
	}

	// Log which-results for all supported CLIs so we can see what's visible.
	for _, name := range []string{"claude", "gemini", "copilot"} {
		if p, err := exec.LookPath(name); err == nil {
			logger.Debug("which "+name, "path", p)
		} else {
			logger.Debug("which "+name, "path", "not found", "err", err)
		}
	}

	p, err := exec.LookPath(s.CLI)
	if err != nil {
		logger.Warn("tier check: CLI not found on resolved PATH",
			"cli", s.CLI, "err", err, "resolved_path", resolved)
		return TierDumb
	}
	logger.Debug("tier check: CLI found", "cli", s.CLI, "resolved_to", p)
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
		logger.Warn("LoadSettings: corrupt settings file, using defaults", "path", path, "err", err)
		return s // corrupt — use defaults
	}

	// Overlay loaded values, keeping defaults for zero values
	if loaded.CLI != "" {
		s.CLI = loaded.CLI
	}
	if loaded.Model != "" {
		s.Model = loaded.Model
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
	if loaded.MaxHistoryVersions > 0 {
		s.MaxHistoryVersions = loaded.MaxHistoryVersions
	}

	if pretty, err := json.MarshalIndent(s, "", "  "); err == nil {
		logger.Debug("LoadSettings: loaded", "path", path, "settings", string(pretty))
	}

	return s
}

// LoginPath returns the PATH as seen by the user's login shell, which includes
// paths like /usr/local/bin and /opt/homebrew/bin that are absent when macOS
// launches an app from the Dock or Finder.
//
// We use $SHELL (defaulting to /bin/zsh) rather than /bin/bash so that the
// correct shell config is sourced. For zsh we also pass -i (interactive) so
// that .zshrc is read in addition to .zprofile — tools installed via npm/nvm
// typically add themselves only to .zshrc.
func LoginPath() string {
	inherited := os.Getenv("PATH")
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/zsh"
	}

	args := []string{"-l", "-c", "echo $PATH"}
	if strings.Contains(shell, "zsh") {
		args = []string{"-l", "-i", "-c", "echo $PATH"}
	}

	logger.Debug("LoginPath: resolving", "shell", shell, "args", args, "inherited_path", inherited)

	cmd := exec.Command(shell, args...)
	out, err := cmd.Output()
	if err != nil {
		logger.Warn("LoginPath: shell invocation failed, falling back to inherited PATH",
			"shell", shell, "err", err, "inherited_path", inherited)
		return inherited
	}

	resolved := strings.TrimSpace(string(out))
	logger.Debug("LoginPath: resolved", "path", resolved)
	return resolved
}

func defaults() Settings {
	return Settings{
		CLITimeout:         20,
		CLITimeoutLong:     60,
		AutosaveDebounce:   30,
		Theme:              "sublime",
		MaxHistoryVersions: 200,
	}
}
