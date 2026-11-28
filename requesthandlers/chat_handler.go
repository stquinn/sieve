package requesthandlers

import (
	"errors"
	"html/template"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"sieve/logger"
	"sieve/sieve"
	"sieve/sieve/domain"
	"sieve/sieve/editor"
)

// ChatHandler is the chat's own lifecycle: creating one, which opens it in a tab,
// naming one by hand or now, and deleting one with its files and its tab. A chat
// is a resource of its own, never a note, so nothing here loads a document.
type ChatHandler struct {
	ServiceProvider *sieve.ServiceProvider
	Tmpl            *template.Template
	// EmitContainerDeleted announces an accomplished deletion by uuid, the only
	// signal that reaches a client holding the chat open.
	EmitContainerDeleted func(uuid string)
	EmitSessionChanged   func()
	// EmitChatsChanged announces that the set of chats changed.
	EmitChatsChanged func()
}

// RegisterPaths mounts the chat's lifecycle.
func (h *ChatHandler) RegisterPaths(r chi.Router) {
	r.Post("/api/chat", h.handleCreate)
	r.Post("/api/chat/{id}/rename", h.handleRename)
	r.Post("/api/chat/{id}/describe", h.handleDescribe)
	r.Delete("/api/chat/{id}", h.handleDelete)
}

// handleRename names a chat by hand as protocol.ChatRenameRequest says, the form's
// name or the JSON body's alike, and answers 204, or 404 for no chat.
func (h *ChatHandler) handleRename(w http.ResponseWriter, r *http.Request) {
	namer := h.ServiceProvider.ChatNamer
	if namer == nil {
		http.Error(w, "Chats are unavailable.", http.StatusServiceUnavailable)
		return
	}
	req, err := requestBody{r}.chatRename()
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	switch err := namer.Rename(chi.URLParam(r, "id"), req.Name); {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, domain.ErrNotChat):
		http.Error(w, "No such chat.", http.StatusNotFound)
	default:
		logger.Error("chat: renaming", "err", err.Error())
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// handleDescribe names a chat now as protocol.ChatDescribeRequest says, answering
// 204 once its job is submitted or with why not in words.
func (h *ChatHandler) handleDescribe(w http.ResponseWriter, r *http.Request) {
	namer := h.ServiceProvider.ChatNamer
	if namer == nil {
		http.Error(w, "Chats are unavailable.", http.StatusServiceUnavailable)
		return
	}
	switch err := namer.NameNow(chi.URLParam(r, "id")); {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, domain.ErrNotChat):
		http.Error(w, namer.Refusal(err), http.StatusNotFound)
	case errors.Is(err, editor.ErrChatNamingUnavailable), errors.Is(err, editor.ErrNothingToName):
		http.Error(w, namer.Refusal(err), http.StatusConflict)
	default:
		logger.Error("chat: naming now", "err", err.Error())
		http.Error(w, namer.Refusal(err), http.StatusInternalServerError)
	}
}

// handleCreate makes an untitled chat with no exchanges, opens it in a tab made
// the active one, and answers with the tab strip and the editor mount, as a
// note's creation does.
func (h *ChatHandler) handleCreate(w http.ResponseWriter, r *http.Request) {
	if h.ServiceProvider.Chats == nil {
		http.Error(w, "Chats are unavailable.", http.StatusServiceUnavailable)
		return
	}
	chat, err := h.ServiceProvider.Chats.Create("")
	if err != nil {
		logger.Error("chat: creating", "err", err.Error())
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	session := h.ServiceProvider.State.LoadSession()
	session.Tabs = append(session.Tabs, domain.Tab{ID: chat.UUID(), Kind: domain.ChatKind, DisplayName: chat.Name()})
	session.Activate(len(session.Tabs)-1, time.Now())
	_ = h.ServiceProvider.State.SaveSession(session)
	if h.EmitSessionChanged != nil {
		h.EmitSessionChanged()
	}
	if h.EmitChatsChanged != nil {
		h.EmitChatsChanged()
	}

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := h.Tmpl.ExecuteTemplate(w, "tabbar.html", session); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := h.Tmpl.ExecuteTemplate(w, "editor.html", editorSwap{UUID: chat.UUID(), Kind: domain.ChatKind}); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// handleDelete deletes a chat, its history and its files, and answers with the
// workspace as a note's delete does, its tab gone. What is no chat is 404.
func (h *ChatHandler) handleDelete(w http.ResponseWriter, r *http.Request) {
	if h.ServiceProvider.Chats == nil {
		http.Error(w, "Chats are unavailable.", http.StatusServiceUnavailable)
		return
	}
	id := chi.URLParam(r, "id")
	if _, err := h.ServiceProvider.Chats.Load(id); errors.Is(err, domain.ErrNotChat) {
		http.Error(w, "No such chat.", http.StatusNotFound)
		return
	}
	// The open session ends first: closing saves the chat, and a save after the
	// delete would find nothing to write to. The chat is read again because that
	// save makes the first read stale.
	h.ServiceProvider.Editor.Close(id)
	chat, err := h.ServiceProvider.Chats.Load(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := h.ServiceProvider.Chats.Delete(chat); err != nil {
		logger.Error("chat: deleting", "uuid", id, "err", err.Error())
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if h.EmitContainerDeleted != nil {
		h.EmitContainerDeleted(id)
	}
	if h.EmitChatsChanged != nil {
		h.EmitChatsChanged()
	}
	deletionReconciler{
		sp: h.ServiceProvider, tmpl: h.Tmpl, emitSessionChanged: h.EmitSessionChanged,
	}.reconcile(w, id)
}
