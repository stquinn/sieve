package domain

import (
	"encoding/json"
	"os"
	"os/exec"
	"strings"

	"sieve/logger"
)

// Tier represents the capability level of the app based on CLI availability.
type Tier int

const (
	TierDumb  Tier = 1 // no CLI configured or not on PATH
	TierSmart Tier = 2 // CLI configured and available
)

// CustomLogParser defines a user-provided regex for log parsing.
type CustomLogParser struct {
	Name    string `json:"name"`
	Pattern string `json:"pattern"`
}

// Settings mirrors store/{hostname}/settings.json.
// All fields are optional — missing keys fall back to defaults.
type Settings struct {
	CLI                string            `json:"cli,omitempty"`
	Model              string            `json:"model,omitempty"`
	CLITimeoutLong     int               `json:"cli_timeout_long,omitempty"`
	AutosaveDebounce   int               `json:"autosave_debounce,omitempty"`
	Debug              bool              `json:"debug,omitempty"`
	Theme              string            `json:"theme,omitempty"`
	MaxHistoryVersions int               `json:"max_history_versions,omitempty"`
	CustomLogParsers   []CustomLogParser `json:"custom_log_parsers,omitempty"`
	WorkerPools        map[string]int    `json:"worker_pools,omitempty"`
	// PromptTimeouts overrides the CLI timeout (seconds) per prompt name. A
	// zero or absent entry falls back to CLITimeoutLong.
	PromptTimeouts map[string]int `json:"prompt_timeouts,omitempty"`
	AI             AISettings     `json:"ai,omitempty"`
}

// AISettings groups AI-subsystem settings under a nested "ai" object.
type AISettings struct {
	// Containment is always the FULL profile in memory (defaults + user
	// additions overlaid — see LoadContainmentProfile); ContainmentProfile.
	// WithoutBaseline is applied only at serialisation time (Settings.Marshal),
	// so settings.json holds just the user's additions on top of code defaults.
	Containment ContainmentProfile `json:"containment"`
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
	for _, name := range []string{"claude", "agy", "copilot"} {
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

// ParseSettings decodes settings JSON bytes and merges with defaults.
// Nil/empty data or a corrupt payload returns defaults without error.
func ParseSettings(data []byte) Settings {
	s := DefaultSettings()
	if len(data) == 0 {
		return s
	}

	var loaded Settings
	if err := json.Unmarshal(data, &loaded); err != nil {
		logger.Warn("ParseSettings: corrupt settings, using defaults", "err", err)
		return s
	}

	// Overlay loaded values, keeping defaults for zero values.
	if loaded.CLI != "" {
		s.CLI = loaded.CLI
	}
	if loaded.Model != "" {
		s.Model = loaded.Model
	}
	if loaded.CLITimeoutLong > 0 {
		s.CLITimeoutLong = loaded.CLITimeoutLong
	}
	if loaded.AutosaveDebounce > 0 {
		s.AutosaveDebounce = loaded.AutosaveDebounce
	}
	s.Debug = loaded.Debug
	if loaded.Theme != "" {
		s.Theme = loaded.Theme
	}
	if loaded.MaxHistoryVersions > 0 {
		s.MaxHistoryVersions = loaded.MaxHistoryVersions
	}
	if len(loaded.CustomLogParsers) > 0 {
		s.CustomLogParsers = loaded.CustomLogParsers
	}
	if len(loaded.WorkerPools) > 0 {
		s.WorkerPools = loaded.WorkerPools
	}
	if len(loaded.PromptTimeouts) > 0 {
		s.PromptTimeouts = loaded.PromptTimeouts
	}
	// Overlay persisted containment overrides onto the default profile so the
	// in-memory settings always carry the full profile (defaults + additions).
	s.AI.Containment = LoadContainmentProfile(loaded.AI.Containment)

	if pretty, err := json.MarshalIndent(s, "", "  "); err == nil {
		logger.Debug("ParseSettings: loaded", "settings", string(pretty))
	}

	return s
}

// Marshal serialises settings to indented JSON. Baseline containment entries
// are dropped before writing — settings.json holds only user additions, the
// baseline capability floor is reconstructed from code on load.
func (s Settings) Marshal() ([]byte, error) {
	s.AI.Containment = s.AI.Containment.WithoutBaseline()
	return json.MarshalIndent(s, "", "  ")
}

// DefaultSettings returns the out-of-the-box settings with sensible defaults.
func DefaultSettings() Settings {
	return Settings{
		CLITimeoutLong:     60,
		AutosaveDebounce:   30,
		Theme:              "sublime",
		MaxHistoryVersions: 200,
		WorkerPools:        map[string]int{}, // empty ⇒ every category uses the engine's defaultN
		AI:                 AISettings{Containment: DefaultContainmentProfile()},
	}
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
