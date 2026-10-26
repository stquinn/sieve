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
	"sieve/sieve/block"
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
	r.Get("/ui/views/meta", h.handleMeta)
	r.Get("/ui/views/meta/dialog/restore", h.handleRestorePrompt)
	r.Post("/api/meta/restore", h.handleRestore)
	r.Get("/ui/views/meta/dialog/delete-asset", h.handleDeleteAssetPrompt)
	r.Delete("/api/document/{uuid}/asset/{key}", h.handleDeleteAsset)
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
	// InUseHint is why an in-use asset's Delete is disabled.
	InUseHint string
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
	SrcURL string
	// Name is what the tab SHOWS: the name the owning block knows the asset by,
	// falling back to the stored filename when no block claims it.
	Name string
	// Detail is what the block says the asset IS, when that differs from its name
	// — an image's description, an attachment's excerpt.
	Detail string
	// FileName is the name on disk — a uuid stem. Tooltip only: it is what you
	// need when reading the document directory by hand, and nothing else.
	FileName string
	MimeType string
	IsImage  bool
	// InUse reports that a block of this document holds the asset, or that the
	// document's blocks could not be read to say otherwise.
	InUse bool
	// Address is the asset's absolute sieve address.
	Address string
	// HolderID is the id of a block holding the asset whose own view a placement
	// is built from (block.SieveBlock.PlacesHeldAssets). "" when no such block
	// holds it, and a placement sends the asset's address instead.
	HolderID string
}

// assetIndex is what a document's blocks say about its assets, from one walk:
// the label each is known by, and the block holding each. known is false when
// the blocks could not be read, and nothing can then be said to be unused.
type assetIndex struct {
	labels  map[string]assetLabel
	holders map[string]block.SieveBlock
	known   bool
}

// assetLabel is what a block knows about the asset it owns: what to call it, and
// what it is. Two fields because a name and a description are different
// questions — an image answers the second well and the first only if it arrived
// as a file.
type assetLabel struct {
	Name   string
	Detail string
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

	// Reload the open shadow from the just-restored disk so the editor renders the
	// restored BLOCKS (codec-parsed, marker ids intact) via the block-list path —
	// NOT a frontend setContent re-parse, which can't read <!--s:ID--> markers and
	// would re-mint ids, then persist that corruption on save-back. Send only the
	// uuid; the frontend asks its document channel to load again (the fresh shadow).
	_ = h.ServiceProvider.Editor.ReloadFromDisk(doc.UUID())

	trigger, _ := json.Marshal(map[string]interface{}{
		"editor:restore": map[string]string{"uuid": doc.UUID()},
	})
	w.Header().Set("HX-Trigger", string(trigger))
	w.WriteHeader(http.StatusOK)

}

func (h *MetaHandler) handleDeleteAssetPrompt(w http.ResponseWriter, r *http.Request) {
	data := struct {
		UUID string
		Key  string
	}{
		UUID: r.URL.Query().Get("uuid"),
		Key:  r.URL.Query().Get("key"),
	}
	if err := h.Tmpl.ExecuteTemplate(w, "delete_asset.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// handleDeleteAsset removes an asset no block of its document holds. The holder
// check is the server's own, against the blocks the editor holds now, so a panel
// rendered before a placement cannot delete what that placement holds.
func (h *MetaHandler) handleDeleteAsset(w http.ResponseWriter, r *http.Request) {
	uuid := chi.URLParam(r, "uuid")
	key, err := url.PathUnescape(chi.URLParam(r, "key"))
	if err != nil || uuid == "" || key == "" {
		http.Error(w, "missing document or asset", http.StatusBadRequest)
		return
	}
	_, held, err := h.ServiceProvider.Editor.AssetHolder(uuid, key)
	if err != nil {
		http.Error(w, "document not found", http.StatusNotFound)
		return
	}
	if held {
		http.Error(w, assetInUseMessage, http.StatusConflict)
		return
	}
	if err := h.ServiceProvider.Assets.Delete(uuid, key); err != nil {
		http.Error(w, "asset not found", http.StatusNotFound)
		return
	}
	h.EmitNotesChanged()
	w.WriteHeader(http.StatusNoContent)
}

// assetInUseMessage is why an asset a block holds cannot be deleted, and what to
// do instead.
const assetInUseMessage = "Used in this document — delete the block that holds it first"

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
		InUseHint:  assetInUseMessage,
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
		data.Assets = toAssetViews(b.UUID(), b.Storable().Owns(), h.indexAssets(b.UUID()))
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

// indexAssets reads document uuid's current blocks once for both answers the
// Assets tab needs.
//
// A label maps an asset's key, stem, or legacy block id to the name its block
// knows it by: an asset that arrived without a name is keyed by a uuid (or a
// legacy <blockID><ext>), and a named one's key is sanitised and uniquified, so a
// key alone may not say what the asset is. A label attr is read from the block's
// attrs, else from its cached face (where a reference keeps its title).
//
// Kind-agnostic: every block is asked the same questions, so a future kind that
// names or holds an asset is covered without touching this.
func (h *MetaHandler) indexAssets(uuid string) assetIndex {
	if h.ServiceProvider == nil || h.ServiceProvider.Editor == nil {
		return assetIndex{}
	}
	blocks, err := h.ServiceProvider.Editor.Blocks(uuid)
	if err != nil {
		return assetIndex{}
	}
	return h.indexBlocks(uuid, blocks)
}

// indexBlocks is indexAssets over blocks already read.
func (h *MetaHandler) indexBlocks(uuid string, blocks []block.SieveBlock) assetIndex {
	self := domain.NewContainerAddress(uuid)
	idx := assetIndex{
		labels:  make(map[string]assetLabel, len(blocks)),
		holders: make(map[string]block.SieveBlock),
		known:   true,
	}
	for _, blk := range blocks {
		held := blk.HeldAssets(self)
		for _, key := range held {
			if prev, ok := idx.holders[key]; !ok || (!prev.PlacesHeldAssets() && blk.PlacesHeldAssets()) {
				idx.holders[key] = blk
			}
		}
		str := func(key string) string {
			if v := strings.TrimSpace(blk.StringAttr(key)); v != "" {
				return v
			}
			return strings.TrimSpace(blk.FaceString(key))
		}
		label := assetLabel{Name: str("title")}
		for _, key := range []string{"alt", "summary"} {
			if label.Detail = str(key); label.Detail != "" {
				break
			}
		}
		if label.Name == "" && label.Detail == "" {
			continue
		}
		idx.labels[blk.ID] = label
		for _, key := range held {
			idx.labels[key] = label
			if stem := strings.TrimSuffix(key, filepath.Ext(key)); stem != "" {
				idx.labels[stem] = label
			}
		}
	}
	return idx
}

func toAssetViews(uuid string, storables []store.Storable, idx assetIndex) []assetViewData {
	labels := idx.labels
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
			label := labels[name]
			if label.Name == "" && label.Detail == "" {
				label = labels[as.BlkID()]
			}
			shown := label.Name
			if shown == "" {
				// No name, so the description carries the row rather than a uuid.
				shown = label.Detail
			}
			detail := label.Detail
			if shown == "" {
				shown, detail = name, ""
			} else if detail == shown {
				detail = ""
			}
			holder, held := idx.holders[name]
			view := assetViewData{
				SrcURL:   ref,
				Name:     shown,
				Detail:   detail,
				FileName: name,
				MimeType: mt,
				IsImage:  strings.HasPrefix(mt, "image/"),
				InUse:    held || !idx.known,
				Address:  domain.NewLeafAddress(uuid, name).String(),
			}
			if held && holder.PlacesHeldAssets() {
				view.HolderID = holder.ID
			}
			out = append(out, view)
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
