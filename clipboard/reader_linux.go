//go:build linux && cgo

// Package clipboard reads the OS clipboard in the UI process, through GTK.
//
// It exists because WebKitGTK hands the page a paste event whose DataTransfer is
// COMPLETELY EMPTY for a screenshot copied by an ordinary desktop tool — no
// types, no items, no files (#87) — while any normal GTK process reads the same
// offer fine. The webview reads the clipboard in a sandboxed web process and
// proxies it; this reads it directly and side-steps that proxy. Wails' own
// runtime clipboard is text-only, which is why this is cgo rather than a call.
package clipboard

/*
#cgo pkg-config: gtk+-3.0

#include <stdint.h>
#include <string.h>
#include <gtk/gtk.h>

// Declared here, DEFINED in Go (callbacks_linux.go). cgo forbids a file that uses
// //export from DEFINING anything in its preamble, so the C helpers and the Go
// callback they call live in separate files and meet at this declaration.
extern void sieveClipboardOffer(uint64_t id, char *mime, void *data, int length);

// The image flavours worth taking, best first. Every one is handed to Go BYTE FOR
// BYTE, which is the whole reason the list is of encoded formats.
//
// TRAP: do NOT reach for gtk_clipboard_request_image and GdkPixbuf here. Decoding
// to a pixbuf and re-encoding needs gdk-pixbuf's LOADER MODULES, and a Nix-built
// app inherits a GDK_PIXBUF_MODULE_FILE cache that has no PNG loader at all — the
// decode silently answers NULL and every screenshot paste does nothing, which is
// the exact bug this package exists to fix. Passing the offer through costs no
// loaders, no re-encode, and no quality.
static const char *sieve_clip_image_targets[] = {"image/png", "image/jpeg", "image/webp", "image/gif"};
static const int sieve_clip_image_target_count = 4;

// One in-flight read. Heap-allocated because it outlives the call that starts it:
// the GTK callbacks it travels through fire later, on the main loop.
typedef struct {
    uint64_t id;
    char     mime[32]; // the image flavour the offer turned out to have
} sieve_clip_req;

static void sieve_clip_finish(sieve_clip_req *req, char *mime, void *data, int length) {
    sieveClipboardOffer(req->id, mime, data, length);
    g_free(req);
}

// uris is owned by GTK — request_uris_received_func g_strfreev()s it as soon as
// this returns — so it is read, never freed here.
static void sieve_clip_on_uris(GtkClipboard *clip, gchar **uris, gpointer user) {
    sieve_clip_req *req = (sieve_clip_req *)user;
    if (uris == NULL || uris[0] == NULL) {
        sieve_clip_finish(req, NULL, NULL, 0);
        return;
    }
    // Rebuilt as a text/uri-list body (RFC 2483 §5) so the offer reaches Go in the
    // one shape the native-file ingestion already parses.
    gchar *joined = g_strjoinv("\r\n", uris);
    sieve_clip_finish(req, "text/uri-list", joined, (int)strlen(joined));
    g_free(joined);
}

// The selection data is owned by GTK for the duration of this call, so the bytes
// are handed to Go before returning and never retained.
static void sieve_clip_on_image(GtkClipboard *clip, GtkSelectionData *sel, gpointer user) {
    sieve_clip_req *req = (sieve_clip_req *)user;
    gint length = 0;
    const guchar *data = sel == NULL ? NULL : gtk_selection_data_get_data_with_length(sel, &length);
    if (data == NULL || length <= 0) {
        // The owner advertised this flavour and then served nothing. Not a case to
        // retry: fall through to the file-copy question, which is the other thing a
        // clipboard can usefully hold.
        gtk_clipboard_request_uris(clip, sieve_clip_on_uris, req);
        return;
    }
    sieve_clip_finish(req, req->mime, (void *)data, (int)length);
}

static void sieve_clip_on_targets(GtkClipboard *clip, GdkAtom *atoms, gint count, gpointer user) {
    sieve_clip_req *req = (sieve_clip_req *)user;
    // The TARGET LIST is asked for first so the flavours are probed in ONE round
    // trip. Requesting each candidate in turn would be a separate selection
    // transfer per miss, against an owner that may be slow or gone.
    int best = sieve_clip_image_target_count;
    for (gint i = 0; i < count; i++) {
        gchar *name = gdk_atom_name(atoms[i]);
        if (name == NULL) continue;
        for (int t = 0; t < best; t++) {
            if (strcmp(name, sieve_clip_image_targets[t]) == 0) {
                best = t;
                break;
            }
        }
        g_free(name);
    }
    if (best == sieve_clip_image_target_count) {
        gtk_clipboard_request_uris(clip, sieve_clip_on_uris, req);
        return;
    }
    g_strlcpy(req->mime, sieve_clip_image_targets[best], sizeof(req->mime));
    gtk_clipboard_request_contents(clip,
        gdk_atom_intern(sieve_clip_image_targets[best], FALSE), sieve_clip_on_image, req);
}

static gboolean sieve_clip_probe(gpointer user) {
    sieve_clip_req *req = (sieve_clip_req *)user;
    GtkClipboard *clip = gtk_clipboard_get(GDK_SELECTION_CLIPBOARD);
    if (clip == NULL) {
        sieve_clip_finish(req, NULL, NULL, 0);
        return G_SOURCE_REMOVE;
    }
    // ASYNC on purpose. The gtk_clipboard_wait_* family spins a RECURSIVE main
    // loop, so calling one from this idle callback would re-enter the loop that is
    // running it and a wedged clipboard owner would stall the whole UI. The
    // request_* family returns immediately and calls back on this same loop.
    gtk_clipboard_request_targets(clip, sieve_clip_on_targets, req);
    return G_SOURCE_REMOVE;
}

// Schedules a read on the GTK main loop. GTK is MAIN-THREAD-ONLY and the caller
// is a WS handler goroutine on some arbitrary thread, so nothing here touches a
// GtkClipboard directly — g_main_context_invoke hands the work to the thread that
// owns the default context and returns at once.
static void sieve_clipboard_read(uint64_t id) {
    sieve_clip_req *req = g_new0(sieve_clip_req, 1);
    req->id = id;
    g_main_context_invoke(NULL, sieve_clip_probe, req);
}
*/
import "C"

import (
	"encoding/base64"
	"strings"
	"sync"
	"time"
	"unsafe"

	"sieve/logger"
	"sieve/sieve/block"
)

// readTimeout caps how long a clipboard read may take. A clipboard offer is
// served by the process that made it, so a wedged or exiting owner can leave the
// request unanswered forever — and the caller is a WS handler that must not hang
// with it. Two seconds is far longer than a real read (milliseconds) and short
// enough that a user pressing Ctrl+V sees the paste give up rather than freeze.
const readTimeout = 2 * time.Second

// Reader reads the OS clipboard through GTK. Safe for concurrent use: each read
// is an independent request keyed by its own id.
type Reader struct {
	timeout time.Duration
}

// New builds a Reader over the default clipboard selection.
func New() *Reader { return &Reader{timeout: readTimeout} }

// Entries returns at most ONE content view of the clipboard, probed in priority
// order: an image (verbatim, in a data URI), else a file-copy's uri-list, else
// nothing. Nothing on the clipboard, an unreadable offer and a timed-out read all
// answer no entries and no error — none of them is a failure, and every one of
// them means the same thing to a paste: there was nothing here to make a block of.
//
// WAYLAND: a client is only offered the selection while it holds keyboard focus,
// so a read from an UNFOCUSED window answers nothing at all — instantly, not by
// timing out. That is the protocol, not a fault, and it costs this caller nothing:
// the only thing that asks is a paste gesture in the focused window.
func (r *Reader) Entries() ([]block.ContentEntry, error) {
	id, answer := pendingReads.begin()
	C.sieve_clipboard_read(C.uint64_t(id))
	select {
	case offer := <-answer:
		return offer.entries(), nil
	case <-time.After(r.timeout):
		pendingReads.abandon(id)
		logger.Warn("clipboard: read timed out", "after", r.timeout)
		return nil, nil
	}
}

// clipboardOffer is what one read found: a mime type and its bytes, or a zero
// value for a clipboard holding nothing this reader can use.
type clipboardOffer struct {
	mime string
	data []byte
}

// entries renders the offer as the paste pipeline's content views. An image is a
// data URI because that is the shape smart-image's paste matcher demands (BOTH
// the mime type and the content have to say image/*); a uri-list is its own text,
// which the native-file ingestion already knows how to read.
func (o clipboardOffer) entries() []block.ContentEntry {
	switch {
	case strings.HasPrefix(o.mime, "image/"):
		return []block.ContentEntry{{
			MIMEType: o.mime,
			Content:  "data:" + o.mime + ";base64," + base64.StdEncoding.EncodeToString(o.data),
		}}
	case o.mime == "text/uri-list":
		return []block.ContentEntry{{MIMEType: o.mime, Content: string(o.data)}}
	}
	return nil
}

// pendingReads is package-level because the GTK main loop calls back into a cgo
// //export function, which can only be a package-level func — it has no Reader to
// call a method on.
var pendingReads = &readRegistry{answers: map[uint64]chan clipboardOffer{}}

// readRegistry holds the reads waiting on a GTK callback, keyed by an id C can
// carry. It exists so a LATE callback — one whose read already timed out — finds
// nothing and is dropped, rather than sending on a channel nobody reads or
// panicking on a freed handle.
type readRegistry struct {
	mu      sync.Mutex
	next    uint64
	answers map[uint64]chan clipboardOffer
}

// begin registers a read and returns its id and the channel its answer lands on.
// The channel is buffered so the main loop never blocks delivering to a caller
// that has already given up.
func (r *readRegistry) begin() (uint64, chan clipboardOffer) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.next++
	answer := make(chan clipboardOffer, 1)
	r.answers[r.next] = answer
	return r.next, answer
}

// complete delivers an answer, if anyone is still waiting for it.
func (r *readRegistry) complete(id uint64, offer clipboardOffer) {
	r.mu.Lock()
	answer, ok := r.answers[id]
	delete(r.answers, id)
	r.mu.Unlock()
	if ok {
		answer <- offer
	}
}

// abandon forgets a read whose caller stopped waiting.
func (r *readRegistry) abandon(id uint64) {
	r.mu.Lock()
	delete(r.answers, id)
	r.mu.Unlock()
}

// offer copies a C-side result into Go memory and hands it to the waiting read.
// Split out of the //export function only because that function's file may hold
// no C definitions; this is where the copying rule lives: the bytes belong to GTK
// and are freed the moment the callback returns.
func (r *readRegistry) offer(id uint64, mime *C.char, data unsafe.Pointer, length C.int) {
	if mime == nil {
		r.complete(id, clipboardOffer{})
		return
	}
	r.complete(id, clipboardOffer{
		mime: C.GoString(mime),
		data: C.GoBytes(data, length),
	})
}
