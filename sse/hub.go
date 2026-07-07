// Package sse implements the server-sent-events fan-out hub that pushes
// live UI events (notes:changed, session:changed, …) to connected clients.
package sse

import (
	"fmt"
	"net/http"
	"sync"
)

// Hub is a server-sent-events fan-out: clients subscribe over /sse and
// receive every broadcast message.
type Hub struct {
	mu      sync.RWMutex
	clients map[chan string]struct{}
}

// NewHub returns a ready-to-use SSE Hub.
func NewHub() *Hub {
	return &Hub{clients: make(map[chan string]struct{})}
}

func (h *Hub) subscribe() chan string {
	ch := make(chan string, 32)
	h.mu.Lock()
	h.clients[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

func (h *Hub) unsubscribe(ch chan string) {
	h.mu.Lock()
	delete(h.clients, ch)
	h.mu.Unlock()
	close(ch)
}

// Broadcast delivers an SSE event to every subscribed client. Slow clients
// are skipped rather than blocking the caller.
func (h *Hub) Broadcast(event, data string) {
	msg := fmt.Sprintf("event: %s\ndata: %s\n\n", event, data)
	h.mu.RLock()
	defer h.mu.RUnlock()
	for ch := range h.clients {
		select {
		case ch <- msg:
		default: // slow client; drop rather than block
		}
	}
}

// ServeHTTP streams events to a single subscribed client until the request
// context is cancelled.
func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	origin := r.Header.Get("Origin")
	if origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Credentials", "true")
	} else {
		w.Header().Set("Access-Control-Allow-Origin", "*")
	}
	w.WriteHeader(http.StatusOK)

	ch := h.subscribe()
	defer h.unsubscribe(ch)

	fmt.Fprintf(w, ": connected\n\n")
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}

	for {
		select {
		case msg, ok := <-ch:
			if !ok {
				return
			}
			fmt.Fprint(w, msg)
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		case <-r.Context().Done():
			return
		}
	}
}
