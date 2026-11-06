package requesthandlers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"sieve/logger"
	"sieve/sieve/ink"
	"sieve/sieve/protocol"

	"github.com/go-chi/chi/v5"
)

// InkPageDrawer is ink.PageDrawer over the workspace wire: the workspace client asked draws the
// page and answers with its PNG.
type InkPageDrawer struct {
	requests *WorkspaceRequests
}

var _ ink.PageDrawer = (*InkPageDrawer)(nil)

// NewInkPageDrawer draws pages through requests.
func NewInkPageDrawer(requests *WorkspaceRequests) *InkPageDrawer {
	return &InkPageDrawer{requests: requests}
}

// DrawPage asks a workspace client to draw page. No client connected wraps ink.ErrNoDrawer; a
// client that does not answer in time is ErrNoWorkspaceAnswer.
func (d *InkPageDrawer) DrawPage(ctx context.Context, page ink.PageDrawing) ([]byte, error) {
	var export protocol.InkPageExport
	if err := json.Unmarshal(page.Export, &export); err != nil {
		return nil, fmt.Errorf("reading the export of page %s: %w", page.Page, err)
	}
	answer, err := d.requests.Ask(ctx, func(id string) interface{} {
		return protocol.NewInkDrawPageFrame(id, page.Container, page.Page.String(), page.Key, page.Bounds.String(), export)
	})
	if errors.Is(err, ErrNoWorkspaceClient) {
		return nil, fmt.Errorf("%w: %w", ink.ErrNoDrawer, err)
	}
	if err != nil {
		return nil, err
	}
	drawn, ok := answer.(protocol.InkPageDrawnFrame)
	if !ok {
		return nil, fmt.Errorf("the answer to %s is a %T", protocol.TypeInkDrawPage, answer)
	}
	if drawn.Error != "" {
		return nil, fmt.Errorf("the window could not draw the page: %s", drawn.Error)
	}
	return base64.StdEncoding.DecodeString(drawn.PNG)
}

// handleInkPageDrawn hands a drawn page to the request waiting for it.
func (h *WsHandler) handleInkPageDrawn(f inboundFrame) {
	var msg protocol.InkPageDrawnFrame
	if err := json.Unmarshal(f.raw, &msg); err != nil {
		h.refuse(f, protocol.TypeInkPageDrawn, err)
		return
	}
	if !h.broadcast.requests.answer(f.conn, msg.CorrelationID, msg) {
		logger.Warn("ws: a drawn page nothing is waiting for", "correlationId", msg.CorrelationID)
	}
}

// handleImage serves a synced note's page as a PNG, drawing it when no image of the page as it
// stands is kept.
func (h *InkHandler) handleImage(w http.ResponseWriter, r *http.Request) {
	images := h.ServiceProvider.InkImages
	if images == nil {
		http.Error(w, "ink unavailable", http.StatusServiceUnavailable)
		return
	}
	page, err := strconv.Atoi(chi.URLParam(r, "page"))
	if err != nil {
		http.Error(w, "a page is its index", http.StatusNotFound)
		return
	}
	img, err := images.Image(r.Context(), chi.URLParam(r, "uuid"), page)
	switch {
	case errors.Is(err, ink.ErrNoSuchPage):
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	case errors.Is(err, ink.ErrNoDrawer):
		http.Error(w, "no window is open to draw the page", http.StatusServiceUnavailable)
		return
	case errors.Is(err, ErrNoWorkspaceAnswer):
		http.Error(w, err.Error(), http.StatusGatewayTimeout)
		return
	case err != nil:
		logger.Error("ink: drawing a page image", "err", err.Error())
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set(protocol.InkPageKeyHeader, img.Key)
	_, _ = w.Write(img.Asset.Body())
}
