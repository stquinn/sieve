package requesthandlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"sieve/sieve/protocol"
)

// requestBody reads one request's parameters in EITHER costume the same
// resource is addressed in: the registered JSON body a typed client sends, and
// the urlencoded body an HTMX dialog form sends under the same names. It is one
// contract in two encodings, not two doors — refusing the form would mean a
// second route for every dialog, which is the duplication this epic removes.
//
// The form half also covers query parameters: net/http folds the URL query into
// r.Form, so ?name=… and a submitted field arrive the same way.
type requestBody struct{ r *http.Request }

// isJSON reports whether the caller declared a JSON body.
func (b requestBody) isJSON() bool {
	return strings.HasPrefix(b.r.Header.Get("Content-Type"), "application/json")
}

// notePatch reads what a note PATCH changes.
func (b requestBody) notePatch() (protocol.NotePatchRequest, error) {
	var req protocol.NotePatchRequest
	if b.isJSON() {
		err := json.NewDecoder(b.r.Body).Decode(&req)
		return req, err
	}
	req.Name = b.r.FormValue("name")
	return req, nil
}

// folderPatch reads what a folder PATCH changes. Both fields are pointers
// because absent must stay distinguishable from empty-or-false: a rename that
// carried no `open` must not collapse the folder.
func (b requestBody) folderPatch() (protocol.FolderPatchRequest, error) {
	var req protocol.FolderPatchRequest
	if b.isJSON() {
		err := json.NewDecoder(b.r.Body).Decode(&req)
		return req, err
	}
	if err := b.r.ParseForm(); err != nil {
		return req, err
	}
	if b.r.Form.Has("name") {
		name := b.r.FormValue("name")
		req.Name = &name
	}
	if b.r.Form.Has("open") {
		open, err := strconv.ParseBool(b.r.FormValue("open"))
		if err != nil {
			return req, err
		}
		req.Open = &open
	}
	return req, nil
}

// folderCreate reads the new folder's name.
func (b requestBody) folderCreate() (protocol.FolderCreateRequest, error) {
	var req protocol.FolderCreateRequest
	if b.isJSON() {
		err := json.NewDecoder(b.r.Body).Decode(&req)
		return req, err
	}
	req.Name = b.r.FormValue("name")
	return req, nil
}
