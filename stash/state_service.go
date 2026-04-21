package stash

import (
	"stash/logger"
	"stash/store"
)

// StateService manages application state (session and settings) through the
// Store interface. State items live in the State category (store/{hostname}/config/).
// Create one with NewStateService — do not construct directly.
type StateService struct {
	st store.Store
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
	s, err := ss.st.Load(State, "session.json")
	if err != nil {
		return ParseSession(nil)
	}
	return ParseSession(s.Body())
}

// SaveSession persists session to the Store, replacing any existing session.
func (ss *StateService) SaveSession(session Session) error {
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
