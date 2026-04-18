package stash

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

func getGlobalConfigPath() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(configDir, "stash")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}
	return filepath.Join(dir, "config.json"), nil
}

func LoadGlobalConfig() GlobalConfig {
	path, err := getGlobalConfigPath()
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
	path, err := getGlobalConfigPath()
	if err != nil {
		return err
	}

	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(path, data, 0644)
}

// Validate checks if a directory looks like a Stash store without creating any files.
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

// FindBestStorePath attempts to find a valid store path from CLI, environment, or global config.
func FindBestStorePath(cliArg, envVar string) string {
	// 1. CLI Arg
	if cliArg != "" {
		if err := ValidateStore(cliArg); err == nil {
			return cliArg
		}
	}

	// 2. Env Var
	if envVar != "" {
		if err := ValidateStore(envVar); err == nil {
			return envVar
		}
	}

	// 3. Global Config
	config := LoadGlobalConfig()
	if config.LastStorePath != "" {
		if err := ValidateStore(config.LastStorePath); err == nil {
			return config.LastStorePath
		}
	}

	// 4. Fallback: PWD (only if it already contains a store)
	pwd, _ := os.Getwd()
	if err := ValidateStore(pwd); err == nil {
		return pwd
	}

	return ""
}
