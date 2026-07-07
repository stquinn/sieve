// Package watcher watches the store's notes directory tree for filesystem
// changes (e.g. external edits or sync) and fires a debounced callback.
package watcher

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"sieve/logger"

	"github.com/fsnotify/fsnotify"
)

// NotesWatcher watches a directory tree for filesystem changes and calls
// notify (debounced) whenever a relevant change occurs.
type NotesWatcher struct {
	fw     *fsnotify.Watcher
	mu     sync.Mutex
	timer  *time.Timer
	notify func()
	done   chan struct{}
}

// New starts a NotesWatcher rooted at root, invoking notify (debounced) on
// every relevant filesystem change.
func New(root string, notify func()) (*NotesWatcher, error) {
	fw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}

	w := &NotesWatcher{
		fw:     fw,
		notify: notify,
		done:   make(chan struct{}),
	}

	// Add root and all existing subdirectories
	if err := w.addRecursive(root); err != nil {
		fw.Close()
		return nil, err
	}

	go w.run()
	logger.Info("notes watcher started", "root", root)
	return w, nil
}

func (w *NotesWatcher) addRecursive(root string) error {
	return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // skip unreadable entries, keep walking
		}
		if d.IsDir() {
			if path != root && strings.HasPrefix(d.Name(), ".") {
				return filepath.SkipDir
			}
			if addErr := w.fw.Add(path); addErr != nil {
				logger.Warn("notes watcher: could not watch dir", "path", path, "err", addErr)
			}
		}
		return nil
	})
}

func (w *NotesWatcher) run() {
	defer close(w.done)
	for {
		select {
		case event, ok := <-w.fw.Events:
			if !ok {
				return
			}
			// If a new directory was created, start watching it too
			if event.Has(fsnotify.Create) {
				if info, err := os.Stat(event.Name); err == nil && info.IsDir() {
					_ = w.addRecursive(event.Name)
				}
			}
			w.schedule()

		case err, ok := <-w.fw.Errors:
			if !ok {
				return
			}
			logger.Warn("notes watcher error", "err", err)
		}
	}
}

// schedule debounces the notify call — coalesces rapid bursts of events
// (e.g. an editor writing multiple temp files) into a single callback.
func (w *NotesWatcher) schedule() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.timer != nil {
		w.timer.Reset(350 * time.Millisecond)
		return
	}
	w.timer = time.AfterFunc(350*time.Millisecond, func() {
		w.mu.Lock()
		w.timer = nil
		w.mu.Unlock()
		w.notify()
	})
}

func (w *NotesWatcher) Close() {
	w.fw.Close()
	<-w.done
}
