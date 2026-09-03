package services

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sieve/logger"
	"sieve/sieve/domain"
	"sieve/store"
	"strings"
	"sync"
)

// StateService manages application state (session and settings) through the
// Store interface. State items live in the State category (store/{hostname}/config/).
// Create one with NewStateService — do not construct directly.
type StateService struct {
	st             store.Store
	storePath      string // library root; where store-local theme overrides live
	themes         fs.FS  // embedded builtin themes (themes/*.json)
	mu             sync.RWMutex
	cachedSession  *domain.Session
	cachedSettings *domain.Settings
}

// NewStateService creates a StateService backed by st.
// Store returns the underlying Store.
func (ss *StateService) Store() store.Store {
	return ss.st
}

// NewStateService creates a StateService backed by st. storePath locates
// store-local theme overrides ({storePath}/themes/<name>.json) and themes is the
// embedded builtin theme FS — both feed ActiveThemeVars; either may be empty/nil
// (theme resolution then falls through to an empty var set).
func NewStateService(st store.Store, storePath string, themes fs.FS) (*StateService, error) {
	if err := st.PrepareCategory(domain.State); err != nil {
		return nil, err
	}
	return &StateService{st: st, storePath: storePath, themes: themes}, nil
}

// ActiveThemeVars resolves the currently configured theme's variables: a
// store-local override file wins, then the embedded builtins. Mirrors the
// resolution the App does for the frontend, so the backend (diagram render job)
// sees the same theme the user sees.
func (ss *StateService) ActiveThemeVars() domain.ThemeVars {
	name := ss.LoadSettings().Theme
	return domain.LoadTheme(name, ss.loadThemeOverride(name), ss.themes)
}

// loadThemeOverride reads the store-local theme override file for name, if any.
// Returns nil when no override exists or the store path is unset. Mirrors
// App.loadThemeOverride.
func (ss *StateService) loadThemeOverride(name string) []byte {
	if ss.storePath == "" || name == "" {
		return nil
	}
	data, _ := os.ReadFile(filepath.Join(ss.storePath, "themes", name+".json"))
	return data
}

// LoadSession returns the current session. If no session exists in the Store
// yet, sensible defaults are returned.
func (ss *StateService) LoadSession() domain.Session {
	ss.mu.RLock()
	if ss.cachedSession != nil {
		defer ss.mu.RUnlock()
		return *ss.cachedSession
	}
	ss.mu.RUnlock()

	ss.mu.Lock()
	defer ss.mu.Unlock()

	if ss.cachedSession != nil {
		return *ss.cachedSession
	}

	s, err := ss.st.Load(domain.State, "session.json")
	if err != nil {
		parsed := domain.ParseSession(nil)
		ss.cachedSession = &parsed
		return parsed
	}
	parsed := domain.ParseSession(s.Body())
	ss.cachedSession = &parsed
	return parsed
}

// SaveSession persists session to the Store, replacing any existing session.
func (ss *StateService) SaveSession(session domain.Session) error {
	ss.mu.Lock()
	ss.cachedSession = &session
	ss.mu.Unlock()

	data, err := session.Marshal()
	if err != nil {
		return err
	}
	_, err = ss.st.CreateText(domain.State, "session.json", data)
	return err
}

// LoadSettings returns the current settings merged with defaults. If no
// settings file exists yet, defaults are written to the Store so the user can
// inspect and edit them.
func (ss *StateService) LoadSettings() domain.Settings {
	ss.mu.RLock()
	if ss.cachedSettings != nil {
		defer ss.mu.RUnlock()
		return *ss.cachedSettings
	}
	ss.mu.RUnlock()

	ss.mu.Lock()
	defer ss.mu.Unlock()

	if ss.cachedSettings != nil {
		return *ss.cachedSettings
	}

	s, err := ss.st.Load(domain.State, "settings.json")
	if err != nil {
		if errors.Is(err, os.ErrNotExist) || strings.Contains(err.Error(), "not found") {
			// First run — write defaults so the user can see all available options.
			defaults := domain.DefaultSettings()
			if data, e := defaults.Marshal(); e == nil {
				if _, e2 := ss.st.CreateText(domain.State, "settings.json", data); e2 != nil {
					logger.Warn("StateService: could not write default settings", "err", e2)
				}
			}
			return defaults
		}
		logger.Error("StateService: failed to load settings", "err", err)
		return domain.DefaultSettings()
	}
	temp := domain.ParseSettings(s.Body())
	ss.cachedSettings = &temp
	return *ss.cachedSettings
}

// userDictionaryFile is where the words the user taught the spell checker live.
// A LINE-PER-WORD text file beside settings.json rather than a settings key: it
// is a growing body of data the user may want to paste into, not a knob, and
// settings.json is rewritten wholesale by the settings panel.
const userDictionaryFile = "spell-dictionary.txt"

// LoadUserDictionary returns the words the user has taught the spell checker.
// Blank lines are skipped and a missing file is an empty dictionary, not an
// error: never having taught it anything is the ordinary case.
func (ss *StateService) LoadUserDictionary() []string {
	item, err := ss.st.Load(domain.State, userDictionaryFile)
	if err != nil {
		return nil
	}
	var words []string
	for _, line := range strings.Split(string(item.Body()), "\n") {
		if word := strings.TrimSpace(line); word != "" {
			words = append(words, word)
		}
	}
	return words
}

// SaveUserDictionary replaces the file with words, one per line. The caller
// owns the set and its order — this writes what it is given.
func (ss *StateService) SaveUserDictionary(words []string) error {
	body := ""
	if len(words) > 0 {
		body = strings.Join(words, "\n") + "\n"
	}
	_, err := ss.st.CreateText(domain.State, userDictionaryFile, []byte(body))
	return err
}

// SaveSettings persists settings to the Store, replacing any existing file. The
// cache is invalidated rather than filled: what a load answers is the PARSED
// file merged with the defaults, and settings handed in here need be neither.
func (ss *StateService) SaveSettings(settings domain.Settings) error {
	data, err := settings.Marshal()
	if err != nil {
		return err
	}
	_, err = ss.st.CreateText(domain.State, "settings.json", data)
	ss.mu.Lock()
	ss.cachedSettings = nil
	ss.mu.Unlock()
	return err
}
