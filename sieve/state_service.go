package sieve

import (
	"sync"
	"sieve/logger"
	"sieve/store"
)

// StateService manages application state (session and settings) through the
// Store interface. State items live in the State category (store/{hostname}/config/).
// Create one with NewStateService — do not construct directly.
type StateService struct {
	st            store.Store
	mu            sync.RWMutex
	cachedSession *Session
}

// NewStateService creates a StateService backed by st.
// Store returns the underlying Store.
func (ss *StateService) Store() store.Store {
	return ss.st
}

func NewStateService(st store.Store) (*StateService, error) {
	if err := st.PrepareCategory(State); err != nil {
		return nil, err
	}
	return &StateService{st: st}, nil
}

// LoadSession returns the current session. If no session exists in the Store
// yet, sensible defaults are returned.
func (ss *StateService) LoadSession() Session {
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

	s, err := ss.st.Load(State, "session.json")
	if err != nil {
		parsed := ParseSession(nil)
		ss.cachedSession = &parsed
		return parsed
	}
	parsed := ParseSession(s.Body())
	ss.cachedSession = &parsed
	return parsed
}

// SaveSession persists session to the Store, replacing any existing session.
func (ss *StateService) SaveSession(session Session) error {
	ss.mu.Lock()
	ss.cachedSession = &session
	ss.mu.Unlock()

	data, err := session.Marshal()
	if err != nil {
		return err
	}
	_, err = ss.st.CreateText(State, "session.json", data)
	return err
}

// LoadSettings returns the current settings merged with defaults. If no
// settings file exists yet, defaults are written to the Store so the user can
// inspect and edit them.
func (ss *StateService) LoadSettings() Settings {
	s, err := ss.st.Load(State, "settings.json")
	if err != nil {
		// First run — write defaults so the user can see all available options.
		defaults := DefaultSettings()
		if data, e := defaults.Marshal(); e == nil {
			if _, e2 := ss.st.CreateText(State, "settings.json", data); e2 != nil {
				logger.Warn("StateService: could not write default settings", "err", e2)
			}
		}
		return defaults
	}
	return ParseSettings(s.Body())
}

// SaveSettings persists settings to the Store, replacing any existing file.
func (ss *StateService) SaveSettings(settings Settings) error {
	data, err := settings.Marshal()
	if err != nil {
		return err
	}
	_, err = ss.st.CreateText(State, "settings.json", data)
	return err
}
