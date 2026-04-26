package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"html/template"
	"io/fs"
	"net/http"
	"net/url"
	"sieve/logger"
	"sieve/requesthandlers"
	"sieve/sieve"
	"strconv"

	"github.com/go-chi/chi/v5"
)

//go:embed ui/templates
var uiTemplates embed.FS

//go:embed ui/static
var uiStatic embed.FS

//go:embed ui/index.html
var uiIndexHTML string

// apiHandler owns the chi router, templates, SSE hub, and static files.
type apiHandler struct {
	app    *App
	hub    *sseHub
	tmpl   *template.Template
	static http.Handler
	routes *chi.Mux
}

type metaRowData struct {
	Label string
	Value string
}

type promptVarDef struct {
	Name string
	Desc string
}

func promptVarsForType(t string) []promptVarDef {
	m := map[string][]promptVarDef{
		"file": {
			{"{content}", "Note body text"},
			{"{folder_list}", "Existing store folders"},
			{"{version}", "Doc version number"},
			{"{focus_count}", "Open frequency"},
			{"{created}", "Creation timestamp"},
			{"{modified}", "Last modified timestamp"},
			{"{now}", "Current timestamp"},
		},
		"explain": {
			{"{type}", "Detected content type"},
			{"{history}", "Relevant conversation context"},
			{"{content}", "Target text to explain"},
			{"{images}", "List of relevant asset names"},
		},
		"ask": {
			{"{type}", "Detected content type"},
			{"{content}", "Context document text"},
			{"{history}", "Conversation history"},
			{"{question}", "User question"},
			{"{images}", "List of relevant asset names"},
		},
		"refine": {
			{"{content}", "The code block text to identify"},
		},
		"image": {
			{"{image_filename}", "The original filename of the image"},
		},
	}
	return m[t]
}

func newAPIHandler(app *App, hub *sseHub) (*apiHandler, error) {
	tmpl := template.New("").Funcs(template.FuncMap{
		"indent": func(depth int) string {
			return fmt.Sprintf("%.2frem", 0.75+float64(depth)*1.0)
		},
		"fileIndent": func(depth int) string {
			return fmt.Sprintf("%.2frem", 1.5+float64(depth)*1.0)
		},
		"urlenc": url.QueryEscape,
		"metaRow": func(label, value string) metaRowData {
			return metaRowData{Label: label, Value: value}
		},
		"promptVars": promptVarsForType,
	})
	var err error
	tmpl, err = tmpl.ParseFS(uiTemplates, "ui/templates/*.html")
	if err != nil {
		return nil, fmt.Errorf("parse templates: %w", err)
	}

	staticFS, err := fs.Sub(uiStatic, "ui/static")
	if err != nil {
		return nil, err
	}

	h := &apiHandler{
		app:    app,
		hub:    hub,
		tmpl:   tmpl,
		static: http.FileServer(http.FS(staticFS)),
	}
	requestHandlers := []requesthandlers.RequestHandler{
		&requesthandlers.SideBarHandler{Notes: &app.notes, State: &app.state, Tmpl: tmpl},
		&requesthandlers.TabHandler{State: &app.state, Tmpl: tmpl},
		&requesthandlers.ContextMenuHandler{
			Notes: &app.notes,
			State: &app.state,
			Tmpl:  tmpl,
			DeleteNote: func(uuid string) error {
				return app.DeleteNote(uuid)
			},
			DeleteFolder: func(id string) error {
				return app.DeleteFolder(id)
			},
			RenameNote: func(uuid, name string) error {
				_, err := app.RenameNote(uuid, name)
				return err
			},
			RenameFolder: func(id, name string) error {
				_, err := app.RenameFolder(id, name)
				return err
			},
		},
		&requesthandlers.MetaHandler{Buffers: &app.buffers, Notes: &app.notes, Tmpl: tmpl},
		&requesthandlers.EditorHandler{Buffers: &app.buffers, Notes: &app.notes, Prompts: &app.prompts, Tmpl: tmpl},
		&requesthandlers.SettingsHandler{State: &app.state, Tmpl: tmpl},
		&requesthandlers.HelpHandler{Tmpl: tmpl},
		&requesthandlers.SearchHandler{Notes: &app.notes, State: &app.state, Tmpl: tmpl},
	}
	r := chi.NewRouter()
	for _, requestHandler := range requestHandlers {
		requestHandler.RegisterPaths(r)
	}
	r.Get("/sse", h.hub.ServeHTTP)
	r.Handle("/static/*", http.StripPrefix("/static", h.static))
	r.Get("/", h.handleIndex)
	r.Get("/api/prompts", h.handlePrompts)
	
	// Note & Tab operations
	r.Post("/api/note/open/{id}", h.handleNoteOpen)
	r.Post("/api/note/new", h.handleNoteNew)
	r.Post("/api/tabs/close/{id}", h.handleTabsClose)
	r.Post("/api/tabs/closeAll", h.handleTabsCloseAll)
	r.Post("/api/tabs/reorder", h.handleTabsReorder)
	r.Delete("/api/note/{id}", h.handleNoteDelete)
	
	// Session & Layout operations
	r.Post("/api/session/sidebar/toggle", h.handleSidebarToggle)
	r.Post("/api/session/meta/toggle", h.handleMetaToggle)
	r.Post("/api/session/prompts/toggle", h.handlePromptsToggle)
	r.Post("/api/session/layout", h.handleSessionLayout)
	r.Post("/api/session/refresh", h.handleSessionRefresh)
	
	// AI operations
	r.Post("/api/ai/smartFile/{id}", h.handleAiSmartFile)
	r.Post("/api/ai/smartMetadata/{id}", h.handleAiSmartMetadata)
	r.Post("/api/ai/keepAndFile/{uuid}", h.handleAiKeepAndFile)

	r.NotFound(h.handleIndex)
	h.routes = r

	return h, nil
}

func (h *apiHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.routes.ServeHTTP(w, r)
}

func (h *apiHandler) handleIndex(w http.ResponseWriter, r *http.Request) {
	info := h.app.GetStoreInfo()
	session := h.app.GetSession()

	activeUUID := ""
	if session.ActiveIdx >= 0 && session.ActiveIdx < len(session.Tabs) {
		activeUUID = session.Tabs[session.ActiveIdx].ID
	}

	tierStr := "dumb"
	if info.Tier == 2 { // TierSmart
		tierStr = "smart"
	}

	data := struct {
		ThemeName     string
		Tier          string
		SidebarWidth  int
		MetaWidth     int
		ShowSidebar   bool
		ShowMeta      bool
		ShowPrompts   bool
		PromptsHeight int
		ActiveUUID    string
	}{
		ThemeName:     info.ThemeName,
		Tier:          tierStr,
		SidebarWidth:  session.SidebarWidth,
		MetaWidth:     session.MetaWidth,
		ShowSidebar:   session.ShowSidebar,
		ShowMeta:      session.ShowMeta,
		ShowPrompts:   session.ShowPrompts,
		PromptsHeight: session.PromptsHeight,
		ActiveUUID:    activeUUID,
	}

	tmpl, err := template.New("index").Parse(uiIndexHTML)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := tmpl.Execute(w, data); err != nil {
		logger.Error("failed to execute index template", "err", err)
	}
}

// ── Note & Tab Operations ───────────────────────────────────────────────────

func (h *apiHandler) handleNoteOpen(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	session := h.app.GetSession()

	exists := false
	for i, t := range session.Tabs {
		if t.ID == id {
			session.ActiveIdx = i
			exists = true
			break
		}
	}

	if !exists {
		session.Tabs = append(session.Tabs, sieve.Tab{ID: id, Mode: "wysiwyg"})
		session.ActiveIdx = len(session.Tabs) - 1
	}

	_ = h.app.SaveSession(session)

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	
	if err := h.tmpl.ExecuteTemplate(w, "tabbar.html", session); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	
	fmt.Fprintf(w, `<div id="htmx-editor" hx-swap-oob="true" class="editor-wrapper" style="flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column;">
		<div id="tiptap-mount" data-uuid="%s" data-mode="wysiwyg" style="flex: 1; min-height: 0; height: 100%; display: flex; flex-direction: column;"></div>
	</div>`, id)
}

func (h *apiHandler) handlePrompts(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	prompts := h.app.GetPrompts()
	if err := h.tmpl.ExecuteTemplate(w, "prompts.html", prompts); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (h *apiHandler) handleNoteNew(w http.ResponseWriter, r *http.Request) {
	dto, err := h.app.NewBuffer()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	session := h.app.GetSession()
	session.Tabs = append(session.Tabs, sieve.Tab{ID: dto.UUID, Mode: "wysiwyg"})
	session.ActiveIdx = len(session.Tabs) - 1
	_ = h.app.SaveSession(session)

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	
	if err := h.tmpl.ExecuteTemplate(w, "tabbar.html", session); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	
	fmt.Fprintf(w, `<div id="htmx-editor" hx-swap-oob="true" class="editor-wrapper" style="flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column;">
		<div id="tiptap-mount" data-uuid="%s" data-mode="wysiwyg" style="flex: 1; min-height: 0; height: 100%; display: flex; flex-direction: column;"></div>
	</div>`, dto.UUID)
}

func (h *apiHandler) handleTabsCloseAll(w http.ResponseWriter, r *http.Request) {
	dto, err := h.app.NewBuffer()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	session := h.app.GetSession()
	session.Tabs = []sieve.Tab{{ID: dto.UUID, Mode: "wysiwyg"}}
	session.ActiveIdx = 0
	_ = h.app.SaveSession(session)

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	
	if err := h.tmpl.ExecuteTemplate(w, "tabbar.html", session); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	
	fmt.Fprintf(w, `<div id="htmx-editor" hx-swap-oob="true" class="editor-wrapper" style="flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column;">
		<div id="tiptap-mount" data-uuid="%s" data-mode="wysiwyg" style="flex: 1; min-height: 0; height: 100%; display: flex; flex-direction: column;"></div>
	</div>`, dto.UUID)
}

func (h *apiHandler) handleTabsClose(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	session := h.app.GetSession()
	
	newTabs := []sieve.Tab{}
	for _, t := range session.Tabs {
		if t.ID != id {
			newTabs = append(newTabs, t)
		}
	}
	session.Tabs = newTabs
	if session.ActiveIdx >= len(session.Tabs) {
		session.ActiveIdx = len(session.Tabs) - 1
	}
	if session.ActiveIdx < 0 && len(session.Tabs) > 0 {
		session.ActiveIdx = 0
	}
	
	if len(session.Tabs) == 0 {
		dto, _ := h.app.NewBuffer()
		session.Tabs = []sieve.Tab{{ID: dto.UUID, Mode: "wysiwyg"}}
		session.ActiveIdx = 0
	}
	
	_ = h.app.SaveSession(session)

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	
	if err := h.tmpl.ExecuteTemplate(w, "tabbar.html", session); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	
	activeID := session.Tabs[session.ActiveIdx].ID
	fmt.Fprintf(w, `<div id="htmx-editor" hx-swap-oob="true" class="editor-wrapper" style="flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column;">
		<div id="tiptap-mount" data-uuid="%s" data-mode="wysiwyg" style="flex: 1; min-height: 0; height: 100%; display: flex; flex-direction: column;"></div>
	</div>`, activeID)
}

func (h *apiHandler) handleTabsReorder(w http.ResponseWriter, r *http.Request) {
	fromStr := r.FormValue("from")
	toStr := r.FormValue("to")
	
	fromIdx, _ := strconv.Atoi(fromStr)
	toIdx, _ := strconv.Atoi(toStr)
	
	session := h.app.GetSession()
	if fromIdx < 0 || fromIdx >= len(session.Tabs) || toIdx < 0 || toIdx > len(session.Tabs) {
		http.Error(w, "invalid indices", http.StatusBadRequest)
		return
	}
	
	tabs := session.Tabs
	moved := tabs[fromIdx]
	
	tabs = append(tabs[:fromIdx], tabs[fromIdx+1:]...)
	
	if toIdx > fromIdx {
		toIdx--
	}
	
	tabs = append(tabs[:toIdx], append([]sieve.Tab{moved}, tabs[toIdx:]...)...)
	session.Tabs = tabs
	
	activeIdx := session.ActiveIdx
	if activeIdx == fromIdx {
		activeIdx = toIdx
	} else if activeIdx > fromIdx && activeIdx <= toIdx {
		activeIdx--
	} else if activeIdx < fromIdx && activeIdx >= toIdx {
		activeIdx++
	}
	session.ActiveIdx = activeIdx
	
	_ = h.app.SaveSession(session)
	
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := h.tmpl.ExecuteTemplate(w, "tabbar.html", session); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (h *apiHandler) handleNoteDelete(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	
	if err := h.app.DeleteNote(id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	session := h.app.GetSession()
	
	newTabs := []sieve.Tab{}
	for _, t := range session.Tabs {
		if t.ID != id {
			newTabs = append(newTabs, t)
		}
	}
	session.Tabs = newTabs
	if session.ActiveIdx >= len(session.Tabs) {
		session.ActiveIdx = len(session.Tabs) - 1
	}
	if session.ActiveIdx < 0 && len(session.Tabs) > 0 {
		session.ActiveIdx = 0
	}
	
	if len(session.Tabs) == 0 {
		dto, _ := h.app.NewBuffer()
		session.Tabs = []sieve.Tab{{ID: dto.UUID, Mode: "wysiwyg"}}
		session.ActiveIdx = 0
	}
	
	_ = h.app.SaveSession(session)

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	
	if err := h.tmpl.ExecuteTemplate(w, "tabbar.html", session); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	
	fmt.Fprint(w, `<div id="htmx-sidebar" hx-swap-oob="true" class="sidebar" hx-get="/api/sidebar" hx-trigger="load"></div>`)
	
	activeID := session.Tabs[session.ActiveIdx].ID
	fmt.Fprintf(w, `<div id="htmx-editor" hx-swap-oob="true" class="editor-wrapper" style="flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column;">
		<div id="tiptap-mount" data-uuid="%s" data-mode="wysiwyg" style="flex: 1; min-height: 0; height: 100%; display: flex; flex-direction: column;"></div>
	</div>`, activeID)
}

// ── Session & Layout Operations ───────────────────────────────────────────────

func (h *apiHandler) handleSidebarToggle(w http.ResponseWriter, r *http.Request) {
	session := h.app.GetSession()
	session.ShowSidebar = !session.ShowSidebar
	_ = h.app.SaveSession(session)
	
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<style id="layout-overrides" hx-swap-oob="true">
		#app-root {
			--sidebar-w: %dpx;
		}
		#htmx-sidebar {
			display: %s;
		}
	</style>`, map[bool]int{true: session.SidebarWidth, false: 0}[session.ShowSidebar],
		map[bool]string{true: "block", false: "none"}[session.ShowSidebar])
}

func (h *apiHandler) handleMetaToggle(w http.ResponseWriter, r *http.Request) {
	session := h.app.GetSession()
	session.ShowMeta = !session.ShowMeta
	_ = h.app.SaveSession(session)
	
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<style id="layout-overrides" hx-swap-oob="true">
		#app-root {
			--meta-w: %dpx;
		}
		#htmx-meta-panel {
			display: %s;
		}
	</style>`, map[bool]int{true: session.MetaWidth, false: 0}[session.ShowMeta],
		map[bool]string{true: "flex", false: "none"}[session.ShowMeta])
}

func (h *apiHandler) handlePromptsToggle(w http.ResponseWriter, r *http.Request) {
	session := h.app.GetSession()
	session.ShowPrompts = !session.ShowPrompts
	_ = h.app.SaveSession(session)
	
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<style id="layout-overrides" hx-swap-oob="true">
		#prompts-panel {
			display: %s;
		}
	</style>`, map[bool]string{true: "block", false: "none"}[session.ShowPrompts])
}

func (h *apiHandler) handleSessionLayout(w http.ResponseWriter, r *http.Request) {
	session := h.app.GetSession()
	
	if wStr := r.FormValue("sidebarWidth"); wStr != "" {
		if wInt, err := strconv.Atoi(wStr); err == nil {
			session.SidebarWidth = wInt
		}
	}
	if wStr := r.FormValue("metaWidth"); wStr != "" {
		if wInt, err := strconv.Atoi(wStr); err == nil {
			session.MetaWidth = wInt
		}
	}
	if hStr := r.FormValue("promptsHeight"); hStr != "" {
		if hInt, err := strconv.Atoi(hStr); err == nil {
			session.PromptsHeight = hInt
		}
	}
	
	_ = h.app.SaveSession(session)
	w.WriteHeader(http.StatusNoContent)
}

func (h *apiHandler) handleSessionRefresh(w http.ResponseWriter, r *http.Request) {
	info := h.app.GetStoreInfo()
	
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<script hx-swap-oob="true">
		var root = document.documentElement;
		var themeName = "%s";
		root.className = root.className.replace(/theme-\S+/, 'theme-' + themeName);
	</script>`, info.ThemeName)
}

// ── AI Operations ────────────────────────────────────────────────────────────

func (h *apiHandler) handleAiSmartFile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	dto, err := h.app.LoadByUUID(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	var path string
	switch d := dto.(type) {
	case BufferDTO:
		path = d.Path
	case NoteDTO:
		path = d.Path
	default:
		http.Error(w, "invalid document type", http.StatusBadRequest)
		return
	}

	result, err := h.app.EvaluateAndFile(path, true, true)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

func (h *apiHandler) handleAiSmartMetadata(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	dto, err := h.app.LoadByUUID(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	var path string
	switch d := dto.(type) {
	case BufferDTO:
		path = d.Path
	case NoteDTO:
		path = d.Path
	default:
		http.Error(w, "invalid document type", http.StatusBadRequest)
		return
	}

	result, err := h.app.EvaluateAndFile(path, false, false)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

func (h *apiHandler) handleAiKeepAndFile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "uuid")
	dto, err := h.app.LoadByUUID(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	var path string
	switch d := dto.(type) {
	case BufferDTO:
		path = d.Path
		intent := "keep"
		d.Meta.UserIntent = &intent
		if _, err := h.app.SaveBuffer(d); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	case NoteDTO:
		path = d.Path
		intent := "keep"
		d.Meta.UserIntent = &intent
		bufDto := BufferDTO{
			Kind: "note",
			UUID: d.UUID,
			Path: d.Path,
			Slug: d.Slug,
			Body: d.Body,
			Meta: d.Meta,
			Versions: d.Versions,
		}
		if _, err := h.app.SaveBuffer(bufDto); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	default:
		http.Error(w, "invalid document type", http.StatusBadRequest)
		return
	}

	result, err := h.app.EvaluateAndFile(path, true, false)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}
