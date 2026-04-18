package stash

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// ThemeVars holds the raw key→value colour/font properties loaded from a theme
// JSON file. Each key becomes a --theme-<key> CSS Custom Property.
type ThemeVars map[string]string

// LoadTheme reads the theme JSON file for the given theme name.
//
// Search order (first match wins):
//  1. <storeRoot>/themes/<name>.json  — user-overridable store-local themes
//  2. builtins FS                     — embedded defaults passed from main.go
//
// Keys starting with "_" (e.g. "_name", "_description") are stripped as
// metadata. Returns an empty map on total failure — the app still works,
// falling back to :root defaults in App.css.
func LoadTheme(storeRoot, name string, builtins fs.FS) ThemeVars {
	if name == "" {
		name = "tokyonight"
	}

	// 1. Store-local override takes priority
	storePath := filepath.Join(storeRoot, "themes", name+".json")
	if data, err := os.ReadFile(storePath); err == nil {
		if vars := parseTheme(data); vars != nil {
			fmt.Printf("[stash] theme: loaded from store: %s\n", storePath)
			return vars
		}
	}

	// 2. Try project/local themes folder (helpful for development)
	localPath := filepath.Join("themes", name+".json")
	if data, err := os.ReadFile(localPath); err == nil {
		if vars := parseTheme(data); vars != nil {
			fmt.Printf("[stash] theme: loaded from local: %s\n", localPath)
			return vars
		}
	}

	// 3. Fall back to embedded built-ins (passed from main.go)
	if builtins != nil {
		embeddedPath := "themes/" + name + ".json"
		if data, err := fs.ReadFile(builtins, embeddedPath); err == nil {
			if vars := parseTheme(data); vars != nil {
				fmt.Printf("[stash] theme: loaded from embedded: %s\n", embeddedPath)
				return vars
			}
		}
	}

	fmt.Printf("[stash] theme: failed to load %s (using empty defaults)\n", name)
	return ThemeVars{}
}

func parseTheme(data []byte) ThemeVars {
	var raw map[string]string
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil
	}
	result := make(ThemeVars, len(raw))
	for k, v := range raw {
		if len(k) > 0 && k[0] == '_' {
			continue // skip metadata keys like _name, _description
		}
		result[k] = v
	}
	return result
}
