package requesthandlers

import (
	"encoding/json"
	"net/http"
	"sieve/sieve"

	"github.com/go-chi/chi/v5"
)

type AiHandler struct {
	ServiceProvider *sieve.ServiceProvider
}

func (h *AiHandler) RegisterPaths(r chi.Router) {
	r.Post("/api/ai/smartFile/{id}", h.handleAiSmartFile)
	r.Post("/api/ai/smartMetadata/{id}", h.handleAiSmartMetadata)
	r.Post("/api/ai/keepAndFile/{uuid}", h.handleAiKeepAndFile)
}

func (h *AiHandler) handleAiSmartFile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	h.evaluateAndFile(w, id, true, true)
}

func (h *AiHandler) handleAiSmartMetadata(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	h.evaluateAndFile(w, id, false, false)
}

func (h *AiHandler) handleAiKeepAndFile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "uuid")

	buffers := *h.ServiceProvider.Buffers
	notes := *h.ServiceProvider.Notes

	if buf, err := buffers.LoadByUUID(id); err == nil {
		intent := "keep"
		buf.Meta().SetUserIntent(&intent)
		if _, err := buffers.Save(buf); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	} else if note, err := notes.LoadByUUID(id); err == nil {
		intent := "keep"
		note.Meta().SetUserIntent(&intent)
		if _, err := notes.Save(note); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	} else {
		http.Error(w, "document not found", http.StatusNotFound)
		return
	}

	h.evaluateAndFile(w, id, true, false)
}

func (h *AiHandler) evaluateAndFile(w http.ResponseWriter, id string, fileAfter bool, allowDiscard bool) {

	var path string
	if buf, err := h.ServiceProvider.Buffers.LoadByUUID(id); err == nil {
		path = buf.Path()
	} else if note, err := h.ServiceProvider.Notes.LoadByUUID(id); err == nil {
		path = note.Path()
	} else {
		http.Error(w, "document not found", http.StatusNotFound)
		return
	}

	prompt, _ := h.ServiceProvider.Prompts.GetPromptContent("file")

	entries, _ := h.ServiceProvider.Notes.List()
	var folders []string
	for _, e := range entries {
		if e.IsDir {
			folders = append(folders, e.Name)
		}
	}

	//TODO settings hsould be cached.  we should not be calling LoadSettings() every time
	outcome, err := sieve.EvaluateAndFileDoc(path, h.ServiceProvider.Buffers, h.ServiceProvider.Notes, h.ServiceProvider.State.LoadSettings(), folders, prompt, fileAfter, allowDiscard)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	type EvaluateAndFileResult struct {
		Discarded bool        `json:"discarded"`
		Doc       interface{} `json:"doc"`
	}

	var doc interface{}
	if outcome.Buffer != nil {
		doc = map[string]interface{}{
			"kind":     "buffer",
			"uuid":     outcome.Buffer.UUID(),
			"path":     outcome.Buffer.Path(),
			"slug":     outcome.Buffer.Slug(),
			"body":     string(outcome.Buffer.Body()),
			"meta":     outcome.Buffer.Meta().All(),
			"versions": outcome.Buffer.Versions(),
		}
	} else if outcome.Note != nil {
		doc = map[string]interface{}{
			"kind":     "note",
			"uuid":     outcome.Note.UUID(),
			"path":     outcome.Note.Path(),
			"slug":     outcome.Note.Slug(),
			"body":     string(outcome.Note.Body()),
			"meta":     outcome.Note.Meta().All(),
			"versions": outcome.Note.Versions(),
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(EvaluateAndFileResult{
		Discarded: outcome.Discarded,
		Doc:       doc,
	})
}
