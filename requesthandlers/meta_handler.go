package requesthandlers

import (
	"fmt"
	"encoding/json"
	"html/template"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"sieve/sieve"
	"sieve/store"

	"github.com/go-chi/chi/v5"
)

type MetaHandler struct {
	Buffers **sieve.BufferService
	Notes   **sieve.NoteService
	Tmpl    *template.Template
}

func (h *MetaHandler) RegisterPaths(r chi.Router) {
	r.Get("/api/meta", h.handleMeta)
	r.Post("/api/meta/restore", h.handleRestore)
}

type metaPanelData struct {
	Path       string
	FileName   string
	Tab        string
	Meta       *metaViewData
	Versions   []versionViewData
	Assets     []assetViewData
	IsPrompt   bool
	PromptType string
	Now        string
	HasAssets  bool
}

type metaViewData struct {
	Status             string
	Version            int
	FocusCount         int
	UserIntent         string
	AiEval             string
	AiLastEvaluated    string
	AiFolderSuggestion string
	UserSuggestedName  string
	DisplayName        string
	Filename           string
	Summary            string
	Tags               []string
	AiJustification    string
	DensitySignals     []string
	Created            string
	Modified           string
	CLI                string
	AiKeepStr          string
	UUID               string
}

type versionViewData struct {
	ID         string
	Created    string
	SizeKB     int64
	PathEnc    string
	VersionEnc string
}

type assetViewData struct {
	ExternalRef string
	Name        string
	Encoding    string
}

func (h *MetaHandler) handleMeta(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	uuid := r.URL.Query().Get("uuid")
	tab := r.URL.Query().Get("tab")
	if tab == "" {
		tab = "meta"
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	// Resolve path from UUID if only uuid was given
	if path == "" && uuid != "" {
		if strings.HasPrefix(uuid, "prompt:") {
			path = uuid
		} else {
			path = h.findPathByUUID(uuid)
		}
	}
	if path == "" {
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, `<div class="meta-panel__empty">No note selected</div>`)
		return
	}
	data := h.buildMetaPanelData(path, tab)
	if err := h.Tmpl.ExecuteTemplate(w, "meta_panel.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// findPathByUUID looks up a document's store path by its UUID frontmatter field.
func (h *MetaHandler) findPathByUUID(uuid string) string {
	if buffers := *h.Buffers; buffers != nil {
		if b, err := buffers.LoadByUUID(uuid); err == nil {
			return b.Path()
		}
	}
	if notes := *h.Notes; notes != nil {
		if n, err := notes.LoadByUUID(uuid); err == nil {
			return n.Path()
		}
	}
	return ""
}

func (h *MetaHandler) handleRestore(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	versionID := r.URL.Query().Get("version")
	if path == "" || versionID == "" {
		http.Error(w, "missing path or version", http.StatusBadRequest)
		return
	}

	vref := store.VersionRef{ID: versionID}
	var body string
	var found bool

	buffers := *h.Buffers
	notes := *h.Notes

	if buffers != nil {
		if b, err := buffers.Load(path); err == nil {
			if v, err := buffers.RetrieveVersion(b, vref); err == nil {
				body = string(v.Body)
				found = true
			}
		}
	}
	if !found && notes != nil {
		if n, err := notes.Load(path); err == nil {
			if v, err := notes.RetrieveVersion(n, vref); err == nil {
				body = string(v.Body)
				found = true
			}
		}
	}
	if !found {
		http.Error(w, "version not found", http.StatusNotFound)
		return
	}

	trigger, _ := json.Marshal(map[string]interface{}{
		"editor:restore": map[string]string{"body": body, "path": path},
	})
	w.Header().Set("HX-Trigger", string(trigger))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
}

func (h *MetaHandler) buildMetaPanelData(path, tab string) metaPanelData {
	isPrompt := strings.HasPrefix(path, "prompt:")
	promptType := ""
	if isPrompt {
		promptType = strings.TrimPrefix(path, "prompt:")
	}

	data := metaPanelData{
		Path:       path,
		FileName:   filepath.Base(path),
		Tab:        tab,
		IsPrompt:   isPrompt,
		PromptType: promptType,
		Now:        metaFmtTime(time.Now()),
	}
	if isPrompt {
		return data
	}

	pathEnc := url.QueryEscape(path)
	buffers := *h.Buffers
	notes := *h.Notes

	if buffers != nil {
		if b, err := buffers.Load(path); err == nil {
			data.Meta = toMetaView(b.Meta())
			data.Versions = toVersionViews(b.Versions(), pathEnc)
			data.Assets = toAssetViews(b.Storable().Owns())
			data.HasAssets = len(data.Assets) > 0
			return data
		}
	}
	if notes != nil {
		if n, err := notes.Load(path); err == nil {
			data.Meta = toMetaView(n.Meta())
			data.Versions = toVersionViews(n.Versions(), pathEnc)
			data.Assets = toAssetViews(n.Storable().Owns())
			data.HasAssets = len(data.Assets) > 0
			return data
		}
	}
	return data
}

func toMetaView(m sieve.DocumentMeta) *metaViewData {
	mv := &metaViewData{
		Status:         m.Status(),
		Version:        m.Version(),
		FocusCount:     m.FocusCount(),
		AiEval:         m.AiEval(),
		DisplayName:    m.DisplayName(),
		Created:        metaFmtTime(m.Created()),
		Modified:       metaFmtTime(m.Modified()),
		Tags:           m.Tags(),
		DensitySignals: m.DensitySignals(),
		UUID:           m.All()["uuid"],
	}
	if v := m.UserIntent(); v != nil {
		mv.UserIntent = *v
	}
	if v := m.AiLastEvaluated(); v != nil {
		mv.AiLastEvaluated = metaFmtTimeStr(*v)
	}
	if v := m.AiFolderSuggestion(); v != nil {
		mv.AiFolderSuggestion = *v
	}
	if v := m.UserSuggestedName(); v != nil {
		mv.UserSuggestedName = *v
	}
	if v := m.Filename(); v != nil {
		mv.Filename = *v
	}
	if v := m.Summary(); v != nil {
		mv.Summary = *v
	}
	if v := m.AiJustification(); v != nil {
		mv.AiJustification = *v
	}
	if v := m.CLI(); v != nil {
		mv.CLI = *v
	}
	if v := m.AiKeep(); v != nil {
		if *v {
			mv.AiKeepStr = "keep"
		} else {
			mv.AiKeepStr = "discard"
		}
	}
	return mv
}

func toVersionViews(refs []store.VersionRef, pathEnc string) []versionViewData {
	out := make([]versionViewData, len(refs))
	for i, r := range refs {
		out[i] = versionViewData{
			ID:         r.ID,
			Created:    r.Created.Format("Jan 2, 2006, 3:04 PM"),
			SizeKB:     r.Size / 1024,
			PathEnc:    pathEnc,
			VersionEnc: url.QueryEscape(r.ID),
		}
	}
	return out
}

func toAssetViews(storables []store.Storable) []assetViewData {
	var out []assetViewData
	for _, s := range storables {
		if as, ok := s.(store.AssetStorable); ok {
			ref := as.ExternalRef()
			out = append(out, assetViewData{
				ExternalRef: ref,
				Name:        filepath.Base(ref),
				Encoding:    as.Encoding().String(),
			})
		}
	}
	return out
}

func metaFmtTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format("Jan 2, 2006, 3:04 PM")
}

func metaFmtTimeStr(s string) string {
	t, err := time.Parse("2006-01-02T15:04:05", s)
	if err != nil {
		return s
	}
	return metaFmtTime(t)
}
