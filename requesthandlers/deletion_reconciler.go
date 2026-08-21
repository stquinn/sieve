package requesthandlers

import (
	"fmt"
	"html/template"
	"net/http"
	"sieve/sieve"
	"sieve/sieve/domain"
)

// deletionReconciler is the half of a deletion that is the same whichever
// handler performed it: the server-side session sweep, and the workspace
// fragment the client re-mounts from.
//
// Two handlers can destroy an open document — a note's own delete, and a folder
// delete that takes every document beneath it — and past the store call the two
// requests are one event. The session must stop naming documents that no longer
// exist, and the response must carry a live editor mount, because the workspace
// reconciliation the broadcast triggers tears the mounted editor down and
// nothing else puts one back. A folder delete that answered with the sidebar
// alone therefore left a blank editor over a dead uuid.
type deletionReconciler struct {
	sp                 *sieve.ServiceProvider
	tmpl               *template.Template
	emitSessionChanged func()
	emitNotesChanged   func()
}

// reconcile finishes a deletion whose documents are already gone from the store:
// it prunes the session of every deleted uuid, announces the two subjects the
// deletion changed, and writes the workspace — the tab strip as the body, with
// the sidebar and the new active tab's editor riding along out-of-band.
//
// It is terminal: the response is written here, so a template failure is
// reported and nothing follows.
func (d deletionReconciler) reconcile(w http.ResponseWriter, deleted ...string) {
	session := d.pruneSession(deleted)

	if d.emitSessionChanged != nil {
		d.emitSessionChanged()
	}
	if d.emitNotesChanged != nil {
		d.emitNotesChanged()
	}

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("HX-Trigger", "notes:changed")

	if err := d.tmpl.ExecuteTemplate(w, "tabbar.html", session); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// The sidebar rides back as an INNERHTML out-of-band swap, never outerHTML:
	// #htmx-sidebar is declared once in index.html carrying its layout style and
	// its whole refresh-trigger set, and replacing that host with a div spelled
	// here would strip both for the rest of the session. The wrapper below is
	// discarded by htmx — only its children land — so the host survives and the
	// tree is already fresh, with no follow-up request. (RenderSidebar re-sets
	// the same two headers this response already carries; they are no-ops now
	// that the tab strip is written, and they agree.)
	fmt.Fprint(w, `<div hx-swap-oob="innerHTML:#htmx-sidebar">`)
	RenderSidebar(w, d.sp.Documents, d.sp.State, d.tmpl)
	fmt.Fprint(w, `</div>`)

	activeTab := session.Tabs[session.ActiveIdx]
	if err := d.tmpl.ExecuteTemplate(w, "editor.html", editorSwap{UUID: activeTab.ID, Mode: activeTab.Mode}); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
}

// pruneSession drops every deleted uuid from the tab strip, saves, and returns
// the session the response renders. It always returns at least one tab: a
// workspace with none has no editor to mount, so an emptied strip is given a
// fresh note rather than a blank window.
//
// The active tab is re-pointed by counting the survivors BEFORE it rather than
// by clamping its index. A deletion can take any number of tabs from anywhere
// in the strip, so an index left untouched names whichever note slid into the
// slot: the count is what keeps the tab the user was reading active, and when
// that tab is itself one of the dead the same count lands on the one the strip
// closes up onto.
func (d deletionReconciler) pruneSession(deleted []string) domain.Session {
	session := d.sp.State.LoadSession()

	gone := make(map[string]bool, len(deleted))
	for _, uuid := range deleted {
		gone[uuid] = true
	}

	kept := []domain.Tab{}
	slot := 0
	for i, t := range session.Tabs {
		if gone[t.ID] {
			continue
		}
		if i < session.ActiveIdx {
			slot++
		}
		kept = append(kept, t)
	}
	session.Tabs = kept

	session.ActiveIdx = slot
	if session.ActiveIdx > len(kept)-1 {
		session.ActiveIdx = len(kept) - 1
	}
	if session.ActiveIdx < 0 {
		session.ActiveIdx = 0
	}

	if len(session.Tabs) == 0 {
		newNote, _ := d.sp.Documents.New()
		session.Tabs = []domain.Tab{{
			ID:          newNote.UUID(),
			Mode:        "wysiwyg",
			DisplayName: newNote.Meta().DisplayName(),
			Status:      "unfiled",
		}}
		session.ActiveIdx = 0
	}

	_ = d.sp.State.SaveSession(session)
	return session
}
