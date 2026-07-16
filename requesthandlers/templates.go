package requesthandlers

import (
	"fmt"
	"html/template"
	"io/fs"
	"net/url"
	"sort"
	"strings"
)

// MetaRow is a label/value pair rendered by the meta_row template. The metaRow
// template func constructs it so templates can pass a single value.
type MetaRow struct {
	Label string
	Value string
}

// NewTemplates parses the UI HTML templates from fsys and wires the template
// FuncMap: layout indents, url-encoding, meta rows, and the prompt-variable
// documentation table (see PromptVarDocs). Callers pass the embedded templates
// FS; the composition root owns the embed, this package owns the presentation.
func NewTemplates(fsys fs.FS) (*template.Template, error) {
	tmpl := template.New("").Funcs(template.FuncMap{
		"indent": func(depth int) string {
			return fmt.Sprintf("%.2frem", 0.75+float64(depth)*1.0)
		},
		"fileIndent": func(depth int) string {
			return fmt.Sprintf("%.2frem", 1.5+float64(depth)*1.0)
		},
		"urlenc": url.QueryEscape,
		"metaRow": func(label, value string) MetaRow {
			return MetaRow{Label: label, Value: value}
		},
		"promptVars": PromptVarDocs{}.For,
		"joinArgs": func(args []string) string {
			return strings.Join(args, " ")
		},
		// joinHeaders renders an MCP grant's static headers as the settings-panel
		// form's compact "Key=Value,Key2=Value2" line — the same one-line, simple
		// idiom as joinArgs (chosen over a multi-line textarea for consistency);
		// parseHeaders (settings_handler.go) is its inverse on save. Keys are
		// sorted for a stable, diff-friendly rendering.
		"joinHeaders": func(headers map[string]string) string {
			if len(headers) == 0 {
				return ""
			}
			keys := make([]string, 0, len(headers))
			for k := range headers {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			parts := make([]string, 0, len(keys))
			for _, k := range keys {
				parts = append(parts, k+"="+headers[k])
			}
			return strings.Join(parts, ",")
		},
	})
	tmpl, err := tmpl.ParseFS(fsys, "frontend/src/templates/*.html")
	if err != nil {
		return nil, fmt.Errorf("parse templates: %w", err)
	}
	return tmpl, nil
}
