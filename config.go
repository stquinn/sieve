package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// GlobalConfig stores application-level settings that are not store-specific.
type GlobalConfig struct {
	LastStorePath string `json:"lastStorePath"`
}

func globalConfigPath() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(configDir, "stash")
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

// ValidateStore checks if a directory looks like a Stash store without
// creating any files.
func ValidateStore(path string) error {
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

// FindBestStorePath attempts to find a valid store path from CLI arg,
// environment variable, or the global config's last-used path.
func FindBestStorePath(cliArg, envVar string) string {
	if cliArg != "" {
		// If the user explicitly provides a CLI argument, we trust it and pass it directly.
		// startup() handles checking if it is a valid store, an empty directory, or invalid.
		return cliArg
	}
	if envVar != "" {
		if err := ValidateStore(envVar); err == nil {
			return envVar
		}
	}
	config := LoadGlobalConfig()
	if config.LastStorePath != "" {
		if err := ValidateStore(config.LastStorePath); err == nil {
			return config.LastStorePath
		} else {
			fmt.Printf("[stash] FindBestStorePath: LastStorePath rejected: %v\n", err)
		}
	}
	pwd, _ := os.Getwd()
	if err := ValidateStore(pwd); err == nil {
		return pwd
	}
	return ""
}
