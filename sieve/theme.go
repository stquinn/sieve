package sieve

import (
	"encoding/json"
	"io/fs"
)

// ThemeVars holds the raw key→value colour/font properties loaded from a theme
// JSON file. Each key becomes a --theme-<key> CSS Custom Property.
type ThemeVars map[string]string

// LoadTheme resolves theme variables for the given theme name.
//
// Search order (first match wins):
//  1. overrideData — caller-supplied bytes (e.g. read from store-local themes dir)
//  2. builtins FS  — embedded defaults passed from main.go
//
// Keys starting with "_" (e.g. "_name", "_description") are stripped as
// metadata. Returns an empty map on total failure — the app still works,
// falling back to :root defaults in App.css.
func LoadTheme(name string, overrideData []byte, builtins fs.FS) ThemeVars {
	if name == "" {
		name = "tokyonight"
	}

	// 1. Caller-provided override bytes (e.g. read from store-local themes dir).
	if len(overrideData) > 0 {
		if vars := parseTheme(overrideData); vars != nil {
			return vars
		}
	}

	// 2. Fall back to embedded built-ins.
	if builtins != nil {
		embeddedPath := "themes/" + name + ".json"
		if data, err := fs.ReadFile(builtins, embeddedPath); err == nil {
			if vars := parseTheme(data); vars != nil {
				return vars
			}
		}
	}

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
