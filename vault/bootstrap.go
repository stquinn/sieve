package vault

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// GlobalConfig stores application-level settings that are not vault-specific.
type GlobalConfig struct {
	LastVaultPath string `json:"lastVaultPath"`
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

// Validate checks if a directory looks like a Stash vault without creating any files.
func ValidateVault(path string) error {
	notesPath := filepath.Join(path, "notes")
	info, err := os.Stat(notesPath)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("not a vault: missing /notes directory")
		}
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("not a vault: /notes is not a directory")
	}
	return nil
}

// FindBestVaultPath attempts to find a valid vault path from CLI, environment, or global config.
func FindBestVaultPath(cliArg, envVar string) string {
	// 1. CLI Arg
	if cliArg != "" {
		if err := ValidateVault(cliArg); err == nil {
			return cliArg
		}
	}

	// 2. Env Var
	if envVar != "" {
		if err := ValidateVault(envVar); err == nil {
			return envVar
		}
	}

	// 3. Global Config
	config := LoadGlobalConfig()
	if config.LastVaultPath != "" {
		if err := ValidateVault(config.LastVaultPath); err == nil {
			return config.LastVaultPath
		}
	}

	// 4. Fallback: PWD (only if it already contains a vault)
	pwd, _ := os.Getwd()
	if err := ValidateVault(pwd); err == nil {
		return pwd
	}

	return ""
}
