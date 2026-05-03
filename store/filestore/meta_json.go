package filestore

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// nameEntry records a single friendly name and the timestamp it was assigned.
type nameEntry struct {
	Name string `json:"name"`
	From string `json:"from"`
}

// docMeta is the on-disk JSON structure written to every document's .meta file.
type docMeta struct {
	UUID               string            `json:"uuid"`
	Type               string            `json:"type"`
	Status             string            `json:"status,omitempty"`
	Version            int               `json:"version"`
	FocusCount         int               `json:"focus_count,omitempty"`
	UserIntent         string            `json:"user_intent,omitempty"`
	AIEval             string            `json:"ai_eval,omitempty"`
	AILastEvaluated    string            `json:"ai_last_evaluated,omitempty"`
	AIFolderSuggestion string            `json:"ai_folder_suggestion,omitempty"`
	UserSuggestedName  string            `json:"user_suggested_name,omitempty"`
	DisplayName        string            `json:"display_name,omitempty"`
	Filename           string            `json:"filename,omitempty"`
	Summary            string            `json:"summary,omitempty"`
	Tags               []string          `json:"tags"`
	AIJustification    string            `json:"ai_justification,omitempty"`
	AIKeep             string            `json:"ai_keep,omitempty"`
	DensitySignals     []string          `json:"density_signals,omitempty"`
	Scroll             string            `json:"scroll,omitempty"`
	Created            string            `json:"created"`
	Modified           string            `json:"modified"`
	CLI                string            `json:"cli,omitempty"`
	Names              []nameEntry       `json:"names"`
	Extra              map[string]string `json:"extra,omitempty"`
}

// folderMeta is the on-disk JSON structure for folder .meta files.
type folderMeta struct {
	UUID    string `json:"uuid"`
	Type    string `json:"type"`
	Created string `json:"created"`
}

func readMetaJSONFromPath(path string) (*docMeta, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var dm docMeta
	if err := json.Unmarshal(data, &dm); err != nil {
		return nil, fmt.Errorf("filestore: parse .meta at %s: %w", path, err)
	}
	return &dm, nil
}

func readFolderMetaJSONFromPath(path string) (*folderMeta, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var fm folderMeta
	if err := json.Unmarshal(data, &fm); err != nil {
		return nil, fmt.Errorf("filestore: parse folder .meta at %s: %w", path, err)
	}
	return &fm, nil
}

func writeMetaJSONToPath(path string, dm *docMeta) error {
	data, err := json.MarshalIndent(dm, "", "  ")
	if err != nil {
		return fmt.Errorf("filestore: marshal .meta: %w", err)
	}
	return writeAtomic(path, data)
}

func writeFolderMetaToPath(path string, fm *folderMeta) error {
	data, err := json.MarshalIndent(fm, "", "  ")
	if err != nil {
		return fmt.Errorf("filestore: marshal folder .meta: %w", err)
	}
	return writeAtomic(path, data)
}

// readMetaType reads just the "type" field from a .meta file without fully
// parsing it.
func readMetaType(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	var t struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &t); err != nil {
		return "", err
	}
	return t.Type, nil
}

// knownMetaFields lists all map keys handled by docMetaToMap / mapToDocMeta.
// Any key not in this set is stored in docMeta.Extra for round-trip fidelity.
var knownMetaFields = map[string]bool{
	"uuid": true, "type": true, "version": true, "created": true, "modified": true,
	"status": true, "focus_count": true,
	"user_intent": true, "ai_eval": true, "ai_last_evaluated": true,
	"ai_folder_suggestion": true, "user_suggested_name": true,
	"display_name": true, "filename": true, "summary": true,
	"tags": true, "ai_justification": true, "ai_keep": true,
	"density_signals": true, "scroll": true, "cli": true,
	// legacy-only fields that are intentionally dropped in the new format:
	"assets": true, "_recovery": true,
}

// docMetaToMap converts a docMeta to the map[string]string used by the
// service layer. Nullable fields use "null" when absent (matching the YAML
// frontmatter convention that existing callers depend on).
func docMetaToMap(dm *docMeta) map[string]string {
	m := map[string]string{
		"uuid":     dm.UUID,
		"type":     dm.Type,
		"version":  strconv.Itoa(dm.Version),
		"created":  dm.Created,
		"modified": dm.Modified,
	}
	if dm.Status != "" {
		m["status"] = dm.Status
	}
	if dm.FocusCount != 0 {
		m["focus_count"] = strconv.Itoa(dm.FocusCount)
	}
	setNullable(m, "user_intent", dm.UserIntent)
	setNullable(m, "ai_eval", dm.AIEval)
	setNullable(m, "ai_last_evaluated", dm.AILastEvaluated)
	setNullable(m, "ai_folder_suggestion", dm.AIFolderSuggestion)
	setNullable(m, "user_suggested_name", dm.UserSuggestedName)
	setNullable(m, "display_name", dm.DisplayName)
	setNullable(m, "filename", dm.Filename)
	setNullable(m, "summary", dm.Summary)
	setNullable(m, "ai_justification", dm.AIJustification)
	setNullable(m, "cli", dm.CLI)
	if dm.AIKeep != "" {
		m["ai_keep"] = dm.AIKeep
	}
	if dm.Scroll != "" {
		m["scroll"] = dm.Scroll
	}
	if len(dm.Tags) > 0 {
		parts := make([]string, len(dm.Tags))
		copy(parts, dm.Tags)
		m["tags"] = "[" + strings.Join(parts, ", ") + "]"
	} else {
		m["tags"] = "[]"
	}
	if len(dm.DensitySignals) > 0 {
		parts := make([]string, len(dm.DensitySignals))
		copy(parts, dm.DensitySignals)
		m["density_signals"] = "[" + strings.Join(parts, ", ") + "]"
	} else {
		m["density_signals"] = "[]"
	}
	// Restore extra fields for round-trip fidelity.
	for k, v := range dm.Extra {
		m[k] = v
	}
	return m
}

func setNullable(m map[string]string, key, val string) {
	if val == "" {
		m[key] = "null"
	} else {
		m[key] = val
	}
}

// mapToDocMeta converts a service-layer map[string]string back to a docMeta.
// The names array is NOT populated here — callers must preserve it separately.
// Unknown fields are stored in Extra for round-trip fidelity.
func mapToDocMeta(m map[string]string) *docMeta {
	dm := &docMeta{
		UUID:               m["uuid"],
		Type:               m["type"],
		Created:            m["created"],
		Modified:           m["modified"],
		Status:             m["status"],
		UserIntent:         nullableToStr(m["user_intent"]),
		AIEval:             nullableToStr(m["ai_eval"]),
		AILastEvaluated:    nullableToStr(m["ai_last_evaluated"]),
		AIFolderSuggestion: nullableToStr(m["ai_folder_suggestion"]),
		UserSuggestedName:  nullableToStr(m["user_suggested_name"]),
		DisplayName:        nullableToStr(m["display_name"]),
		Filename:           nullableToStr(m["filename"]),
		Summary:            nullableToStr(m["summary"]),
		AIJustification:    nullableToStr(m["ai_justification"]),
		AIKeep:             m["ai_keep"],
		Scroll:             m["scroll"],
		CLI:                nullableToStr(m["cli"]),
	}
	dm.Version, _ = strconv.Atoi(m["version"])
	dm.FocusCount, _ = strconv.Atoi(m["focus_count"])
	dm.Tags = parseInlineList(m["tags"])
	dm.DensitySignals = parseInlineList(m["density_signals"])
	// Preserve unknown fields in Extra.
	for k, v := range m {
		if !knownMetaFields[k] {
			if dm.Extra == nil {
				dm.Extra = make(map[string]string)
			}
			dm.Extra[k] = v
		}
	}
	return dm
}

// nullableToStr converts the "null" sentinel to empty string for struct storage.
func nullableToStr(v string) string {
	if v == "null" {
		return ""
	}
	return v
}

// parseInlineList parses "[a, b, c]" YAML inline list notation into a slice.
func parseInlineList(s string) []string {
	s = strings.TrimSpace(s)
	if s == "" || s == "[]" || s == "null" {
		return nil
	}
	s = strings.TrimPrefix(s, "[")
	s = strings.TrimSuffix(s, "]")
	var result []string
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part != "" {
			result = append(result, part)
		}
	}
	return result
}
