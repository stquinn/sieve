package requesthandlers

import (
	"encoding/json"
	"fmt"
	"html/template"
	"mime"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	"sieve/sieve"
	"sieve/sieve/domain"
	"sieve/store"

	"github.com/go-chi/chi/v5"
)

type MetaHandler struct {
	ServiceProvider  *sieve.ServiceProvider
	Tmpl             *template.Template
	EmitNotesChanged func()
}

func (h *MetaHandler) RegisterPaths(r chi.Router) {
	r.Get("/api/meta", h.handleMeta)
	r.Get("/api/meta/restore-prompt", h.handleRestorePrompt)
	r.Post("/api/meta/restore", h.handleRestore)
}

type metaPanelData struct {
	UUID       string
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
	Size       string
	UUIDEnc    string
	VersionEnc string
	IsCurrent  bool
}

type assetViewData struct {
	SrcURL   string
	Name     string
	MimeType string
	IsImage  bool
}

func (h *MetaHandler) handleMeta(w http.ResponseWriter, r *http.Request) {
	uuid := r.URL.Query().Get("uuid")
	tab := r.URL.Query().Get("tab")
	if tab == "" {
		tab = "meta"
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	// Resolve active note from session if no path/uuid provided
	if uuid == "" {
		if h.ServiceProvider.State == nil {
			w.WriteHeader(http.StatusOK)
			fmt.Fprint(w, `<div class="meta-panel__empty">No note selected</div>`)
			return
		}
		session := h.ServiceProvider.State.LoadSession()
		if len(session.Tabs) > 0 && session.ActiveIdx >= 0 && session.ActiveIdx < len(session.Tabs) {
			uuid = session.Tabs[session.ActiveIdx].ID
		}
	}

	if uuid == "" {
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, `<div class="meta-panel__empty">No note selected</div>`)
		return
	}
	data := h.buildMetaPanelData(uuid, tab)
	if err := h.Tmpl.ExecuteTemplate(w, "meta_panel.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (h *MetaHandler) handleRestorePrompt(w http.ResponseWriter, r *http.Request) {
	uuid := r.URL.Query().Get("uuid")
	versionID := r.URL.Query().Get("version")

	data := struct {
		UUID      string
		VersionID string
	}{
		UUID:      uuid,
		VersionID: versionID,
	}

	if err := h.Tmpl.ExecuteTemplate(w, "restore.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (h *MetaHandler) handleRestore(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("uuid")
	versionID := r.URL.Query().Get("version")
	if path == "" || versionID == "" {
		http.Error(w, "missing path or version", http.StatusBadRequest)
		return
	}

	vref := store.VersionRef{ID: versionID}
	doc, err := h.ServiceProvider.Documents.LoadByUUID(path)
	if err != nil {
		http.Error(w, "document not found", http.StatusNotFound)
		return
	}
	doc, err = h.ServiceProvider.Documents.ReplaceWithVersion(doc, vref)
	if err != nil {
		http.Error(w, "restore failed", http.StatusInternalServerError)
		return
	}
	h.EmitNotesChanged()

	trigger, _ := json.Marshal(map[string]interface{}{
		"editor:restore": map[string]string{"body": string(doc.Body()), "uuid": doc.UUID()},
	})
	w.Header().Set("HX-Trigger", string(trigger))
	w.WriteHeader(http.StatusOK)

}

func (h *MetaHandler) buildMetaPanelData(uuidOrPromptName, tab string) metaPanelData {
	isPrompt := strings.HasPrefix(uuidOrPromptName, "prompt:")
	promptType := ""
	if isPrompt {
		promptType = strings.TrimPrefix(uuidOrPromptName, "prompt:")
	}

	data := metaPanelData{
		UUID:       uuidOrPromptName,
		Tab:        tab,
		IsPrompt:   isPrompt,
		PromptType: promptType,
		Now:        metaFmtTime(time.Now()),
	}
	if isPrompt {
		return data
	}
	if b, err := h.ServiceProvider.Documents.LoadByUUID(uuidOrPromptName); err == nil {
		data.UUID = b.UUID()
		if fname := b.Meta().Filename(); fname != nil {
			data.FileName = *fname
		}
		if data.FileName == "" {
			data.FileName = "Untitled"
		}
		data.Meta = toMetaView(b)
		data.Versions = toVersionViews(b.Versions(), b.UUID())
		data.Assets = toAssetViews(b.Storable().Owns())
		data.HasAssets = len(data.Assets) > 0
		return data
	}
	return data
}

func toMetaView(d domain.Document) *metaViewData {
	m := d.Meta()
	status := "unfiled"
	if d.Kind() == domain.KindNote {
		status = "filed"
	}
	mv := &metaViewData{
		Status:         status,
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

func humanSize(b int64) string {
	switch {
	case b < 1024:
		return fmt.Sprintf("%d B", b)
	case b < 1024*1024:
		return fmt.Sprintf("%d KB", b/1024)
	default:
		return fmt.Sprintf("%.1f MB", float64(b)/(1024*1024))
	}
}

func toVersionViews(refs []store.VersionRef, uuidEnc string) []versionViewData {
	out := make([]versionViewData, len(refs))
	for i, r := range refs {
		out[i] = versionViewData{
			ID:         r.ID,
			Created:    r.Created.Format("2/1/06 @ 15:04"),
			Size:       humanSize(r.Size),
			UUIDEnc:    uuidEnc,
			VersionEnc: url.QueryEscape(r.ID),
			IsCurrent:  i == 0,
		}
	}
	return out
}

func toAssetViews(storables []store.Storable) []assetViewData {
	var out []assetViewData
	for _, s := range storables {
		if as, ok := s.(store.AssetStorable); ok {
			ref := as.ExternalRef()
			name := filepath.Base(ref)
			mt := mime.TypeByExtension(filepath.Ext(name))
			// .bin is our legacy unknown-type extension. Sniff the content to
			// detect SVG — the same check the asset server uses when serving.
			if mt == "" || filepath.Ext(name) == ".bin" {
				if isSVGBytes(as.Body()) {
					mt = "image/svg+xml"
				} else if mt == "" {
					mt = "application/octet-stream"
				}
			}
			out = append(out, assetViewData{
				SrcURL:   ref,
				Name:     name,
				MimeType: mt,
				IsImage:  strings.HasPrefix(mt, "image/"),
			})
		}
	}
	return out
}

// isSVGBytes returns true when b begins with an SVG document.
// http.DetectContentType does not reliably detect SVG so we check bytes directly.
func isSVGBytes(b []byte) bool {
	// Trim leading whitespace then check for <svg or <?xml
	for i, c := range b {
		if c == ' ' || c == '\t' || c == '\r' || c == '\n' {
			continue
		}
		rest := b[i:]
		return len(rest) >= 4 && (string(rest[:4]) == "<svg" || (len(rest) >= 5 && string(rest[:5]) == "<?xml"))
	}
	return false
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
