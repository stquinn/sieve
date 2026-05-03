package main

import (
	"strconv"
	"strings"
	"time"

	"sieve/sieve"
	"sieve/store"
)

// ── DTOs — serialised across the Wails bridge as JSON ─────────────────────────
//
// All field names use camelCase json tags — standard JSON convention.
// The frontmatter snake_case keys are a FileStore implementation detail.
//
// Read-only fields (status, version, created, modified) are never written back
// by the frontend. The Go bridge applies the typed writable fields from the
// inbound DTO and ignores the read-only ones.

// DocumentMetaDTO is the typed projection of a document's frontmatter.
// The All map carries every key including unknowns so custom fields round-trip.
type DocumentMetaDTO struct {
	Status             string            `json:"status"`              // read-only pass-through
	Version            int               `json:"version"`             // read-only, Store-owned
	FocusCount         int               `json:"focusCount"`
	UserIntent         *string           `json:"userIntent"`
	AiEval             string            `json:"aiEval"`
	AiLastEvaluated    *string           `json:"aiLastEvaluated"`
	AiFolderSuggestion *string           `json:"aiFolderSuggestion"`
	UserSuggestedName  *string           `json:"userSuggestedName"`
	DisplayName        string            `json:"displayName"`
	Filename           *string           `json:"filename"`            // frontmatter "filename" field
	Summary            *string           `json:"summary"`
	Tags               []string          `json:"tags"`
	AiJustification    *string           `json:"aiJustification"`
	DensitySignals     []string          `json:"densitySignals"`
	Created            string            `json:"created"`             // read-only, Store-owned
	Modified           string            `json:"modified"`            // read-only, Store-owned
	CLI                *string           `json:"cli"`
	AiKeep             *bool             `json:"aiKeep"`
	Scroll             int               `json:"scroll"`
	Assets             []map[string]string `json:"assets"`
	All                map[string]string `json:"all"` // full raw map — every key including unknowns
}

// BufferDTO is a working-copy document as seen by the frontend.
// Path is the store-relative ExternalRef (e.g. "{hostname}/buffers/buf-xxx.md").
// Slug is the key-derived short identifier without extension (e.g. "buf-20240102-1504").
type BufferDTO struct {
	Kind     string          `json:"kind"`
	UUID     string          `json:"uuid"`
	Slug     string          `json:"slug"`
	Body     string          `json:"body"`
	Meta     DocumentMetaDTO `json:"meta"`
	Versions []VersionRefDTO `json:"versions"`
}

// NoteDTO is a filed Library document as seen by the frontend.
type NoteDTO struct {
	Kind     string          `json:"kind"`
	UUID     string          `json:"uuid"`
	Slug     string          `json:"slug"`
	Body     string          `json:"body"`
	Meta     DocumentMetaDTO `json:"meta"`
	Versions []VersionRefDTO `json:"versions"`
}

// EvaluateAndFileResult is the return value of the EvaluateAndFile bridge call.
type EvaluateAndFileResult struct {
	Discarded bool      `json:"discarded"`
	Doc       BufferDTO `json:"doc"`
}

// AssetDTO carries the ExternalRef the frontend inserts directly into markdown.
type AssetDTO struct {
	ExternalRef string `json:"externalRef"`
	Encoding    string `json:"encoding"`
}

// VersionRefDTO is a lightweight history reference.
type VersionRefDTO struct {
	ID      string `json:"id"`
	Created string `json:"created"`
	Size    int64  `json:"size"`
}

// VersionedStorableDTO is a point-in-time snapshot. Untyped by design — a
// document that moved from Buffer to Note has history spanning both states.
type VersionedStorableDTO struct {
	Ref  VersionRefDTO   `json:"ref"`
	Body string          `json:"body"`
	Meta DocumentMetaDTO `json:"meta"`
}

// ── Business-type → DTO ───────────────────────────────────────────────────────

func toDocumentMetaDTO(m sieve.DocumentMeta, owns []store.Storable) DocumentMetaDTO {
	tags := m.Tags()
	if tags == nil {
		tags = []string{}
	}
	ds := m.DensitySignals()
	if ds == nil {
		ds = []string{}
	}

	assets := []map[string]string{}
	if owns != nil {
		for _, s := range owns {
			if as, ok := s.(store.AssetStorable); ok {
				assets = append(assets, map[string]string{
					"externalRef": as.ExternalRef(),
					"encoding":    as.Encoding().String(),
				})
			}
		}
	} else if assetsStr := m.All()["assets"]; assetsStr != "" {
		// Fallback for snapshots: parse the frontmatter shorthand
		for _, p := range rawList(assetsStr) {
			assets = append(assets, map[string]string{"externalRef": p})
		}
	}

	created := ""
	if t := m.Created(); !t.IsZero() {
		created = t.Format("2006-01-02T15:04:05")
	}
	modified := ""
	if t := m.Modified(); !t.IsZero() {
		modified = t.Format("2006-01-02T15:04:05")
	}
	return DocumentMetaDTO{
		Status:             m.Status(),
		Version:            m.Version(),
		FocusCount:         m.FocusCount(),
		UserIntent:         m.UserIntent(),
		AiEval:             m.AiEval(),
		AiLastEvaluated:    m.AiLastEvaluated(),
		AiFolderSuggestion: m.AiFolderSuggestion(),
		UserSuggestedName:  m.UserSuggestedName(),
		DisplayName:        m.DisplayName(),
		Filename:           m.Filename(),
		Summary:            m.Summary(),
		Tags:               tags,
		AiJustification:    m.AiJustification(),
		DensitySignals:     ds,
		Created:            created,
		Modified:           modified,
		CLI:                m.CLI(),
		AiKeep:             m.AiKeep(),
		Scroll:             m.Scroll(),
		Assets:             assets,
		All:                m.All(),
	}
}

func toVersionRefDTO(v store.VersionRef) VersionRefDTO {
	return VersionRefDTO{
		ID:      v.ID,
		Created: v.Created.Format(time.RFC3339),
		Size:    v.Size,
	}
}

func toVersionRefDTOs(refs []store.VersionRef) []VersionRefDTO {
	if len(refs) == 0 {
		return []VersionRefDTO{}
	}
	out := make([]VersionRefDTO, len(refs))
	for i, r := range refs {
		out[i] = toVersionRefDTO(r)
	}
	return out
}

func toBufferDTO(b *sieve.Buffer) BufferDTO {
	return BufferDTO{
		Kind:     "buffer",
		UUID:     b.UUID(),
		Slug:     b.Slug(),
		Body:     string(b.Body()),
		Meta:     toDocumentMetaDTO(b.Meta(), b.Storable().Owns()),
		Versions: toVersionRefDTOs(b.Versions()),
	}
}

// toNoteBufferDTO converts a Note to a BufferDTO so the frontend can use a
// single LoadBuffer/SaveBuffer API regardless of category.
func toNoteBufferDTO(n *sieve.Note) BufferDTO {
	return BufferDTO{
		Kind:     "note",
		UUID:     n.UUID(),
		Slug:     n.Slug(),
		Body:     string(n.Body()),
		Meta:     toDocumentMetaDTO(n.Meta(), n.Storable().Owns()),
		Versions: toVersionRefDTOs(n.Versions()),
	}
}

func toNoteDTO(n *sieve.Note) NoteDTO {
	return NoteDTO{
		Kind:     "note",
		UUID:     n.UUID(),
		Slug:     n.Slug(),
		Body:     string(n.Body()),
		Meta:     toDocumentMetaDTO(n.Meta(), n.Storable().Owns()),
		Versions: toVersionRefDTOs(n.Versions()),
	}
}

func toAssetDTO(a *sieve.ImageAsset) AssetDTO {
	return AssetDTO{
		ExternalRef: a.ExternalRef(),
		Encoding:    encodingName(a.Encoding()),
	}
}

func encodingName(e store.Encoding) string {
	switch e {
	case store.Base64:
		return "base64"
	case store.LZCompressed:
		return "lz-compressed"
	case store.Zipped:
		return "zipped"
	default:
		return "raw"
	}
}

func toVersionedStorableDTO(v store.VersionedStorable) VersionedStorableDTO {
	return VersionedStorableDTO{
		Ref:  toVersionRefDTO(v.Ref),
		Body: string(v.Body),
		Meta: rawMapToMetaDTO(v.Meta),
	}
}

// rawMapToMetaDTO builds a DocumentMetaDTO directly from a raw meta map.
// Used for VersionedStorable which does not go through the business types.
func rawMapToMetaDTO(m map[string]string) DocumentMetaDTO {
	if m == nil {
		return DocumentMetaDTO{Tags: []string{}, DensitySignals: []string{}, Assets: []map[string]string{}}
	}

	assets := []map[string]string{}
	if assetsStr := m["assets"]; assetsStr != "" {
		for _, p := range rawList(assetsStr) {
			assets = append(assets, map[string]string{"externalRef": p})
		}
	}

	return DocumentMetaDTO{
		Status:             m["status"],
		Version:            rawInt(m, "version"),
		FocusCount:         rawInt(m, "focus_count"),
		UserIntent:         rawNullableStr(m["user_intent"]),
		AiEval:             rawDefault(m["ai_eval"], "none"),
		AiLastEvaluated:    rawNullableStr(m["ai_last_evaluated"]),
		AiFolderSuggestion: rawNullableStr(m["ai_folder_suggestion"]),
		UserSuggestedName:  rawNullableStr(m["user_suggested_name"]),
		DisplayName:        m["display_name"],
		Filename:           rawNullableStr(m["filename"]),
		Summary:            rawNullableStr(m["summary"]),
		Tags:               rawList(m["tags"]),
		AiJustification:    rawNullableStr(m["ai_justification"]),
		DensitySignals:     rawList(m["density_signals"]),
		Created:            m["created"],
		Modified:           m["modified"],
		CLI:                rawNullableStr(m["cli"]),
		AiKeep:             rawNullableBool(m["ai_keep"]),
		Scroll:             rawInt(m, "scroll"),
		Assets:             assets,
		All:                m,
	}
}

// applyDTOToMeta writes every writable field from dto back to m.
// Read-only fields (Status, Version, Created, Modified) are skipped.
// Called by SaveBuffer and SaveNote on the inbound DTO path.
func applyDTOToMeta(dto DocumentMetaDTO, m sieve.DocumentMeta) {
	m.SetFocusCount(dto.FocusCount)
	m.SetUserIntent(dto.UserIntent)
	m.SetAiEval(dto.AiEval)
	m.SetAiLastEvaluated(dto.AiLastEvaluated)
	m.SetAiFolderSuggestion(dto.AiFolderSuggestion)
	m.SetUserSuggestedName(dto.UserSuggestedName)
	m.SetDisplayName(dto.DisplayName)
	m.SetFilename(dto.Filename)
	m.SetSummary(dto.Summary)
	m.SetTags(dto.Tags)
	m.SetAiJustification(dto.AiJustification)
	m.SetDensitySignals(dto.DensitySignals)
	m.SetCLI(dto.CLI)
	m.SetAiKeep(dto.AiKeep)
	m.SetScroll(dto.Scroll)
}

// ── Raw map helpers ───────────────────────────────────────────────────────────

func rawInt(m map[string]string, key string) int {
	n, _ := strconv.Atoi(m[key])
	return n
}

func rawDefault(s, def string) string {
	if s == "" || s == "null" {
		return def
	}
	return s
}

func rawNullableStr(s string) *string {
	if s == "" || s == "null" {
		return nil
	}
	v := s
	return &v
}

func rawNullableBool(s string) *bool {
	switch s {
	case "true":
		b := true
		return &b
	case "false":
		b := false
		return &b
	}
	return nil
}

func rawList(s string) []string {
	s = strings.TrimSpace(s)
	if s == "" || s == "null" || s == "[]" {
		return []string{}
	}
	if strings.HasPrefix(s, "[") && strings.HasSuffix(s, "]") {
		inner := s[1 : len(s)-1]
		parts := strings.Split(inner, ",")
		result := make([]string, 0, len(parts))
		for _, p := range parts {
			if t := strings.TrimSpace(p); t != "" {
				result = append(result, t)
			}
		}
		return result
	}
	return []string{s}
}

// fromVersionRefDTO converts an inbound VersionRefDTO back to a store.VersionRef.
func fromVersionRefDTO(dto VersionRefDTO) store.VersionRef {
	t, _ := time.Parse(time.RFC3339, dto.Created)
	return store.VersionRef{
		ID:      dto.ID,
		Created: t,
		Size:    dto.Size,
	}
}
