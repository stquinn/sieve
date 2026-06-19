package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"sieve/logger"
	"sieve/sieve"
)

// GlobalConfig stores machine-level settings that are not specific to any one
// library. It is persisted to the OS config directory (~/.config/sieve/).
type GlobalConfig struct {
	LastStorePath   string          `json:"lastStorePath"`
	RecentLibraries []sieve.Library `json:"recentLibraries,omitempty"`
}

func globalConfigPath() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(configDir, "sieve")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return filepath.Join(dir, "config.json"), nil
}

func LoadGlobalConfig() GlobalConfig {
	path, err := globalConfigPath()
	if err != nil {
		return GlobalConfig{}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return GlobalConfig{}
	}
	var config GlobalConfig
	if err := json.Unmarshal(data, &config); err != nil {
		return GlobalConfig{}
	}
	return config
}

func (c GlobalConfig) Save() error {
	path, err := globalConfigPath()
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// configRecorder implements sieve.LibraryRecorder backed by GlobalConfig.
// It is stateless — each method reads and writes the config file fresh.
type configRecorder struct{}

func (configRecorder) Recent() []sieve.Library {
	return LoadGlobalConfig().RecentLibraries
}

func (configRecorder) LastUsed() string {
	return LoadGlobalConfig().LastStorePath
}

func (configRecorder) SetLastUsed(id string) {
	c := LoadGlobalConfig()
	c.LastStorePath = id
	_ = c.Save()
}

func (configRecorder) AddRecent(lib sieve.Library) {
	c := LoadGlobalConfig()
	filtered := make([]sieve.Library, 0, len(c.RecentLibraries))
	for _, e := range c.RecentLibraries {
		if e.Ref != lib.Ref {
			filtered = append(filtered, e)
		}
	}
	c.RecentLibraries = append([]sieve.Library{lib}, filtered...)
	if len(c.RecentLibraries) > 8 {
		c.RecentLibraries = c.RecentLibraries[:8]
	}
	_ = c.Save()
}

// ValidateStore checks if a directory looks like a Sieve store without
// creating any files. Passed to LibraryService as the validate function.
func ValidateStore(path string) error {
	localDevDirectory := filepath.Join(path, "main.go")
	if _, err := os.Stat(localDevDirectory); err == nil {
		logger.Warn("config: store path looks like source directory", "path", path)
		return fmt.Errorf("looks like the dev directory, not a store")
	}
	storePath := filepath.Join(path, "store")
	info, err := os.Stat(storePath)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("not a store: missing /store directory")
		}
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("not a store: /store is not a directory")
	}
	return nil
}
