package stash

import "path/filepath"

func (v *Store) HostHistoryDir() string {
	return filepath.Join(v.HostDir, ".history")
}

func (v *Store) StoreHistoryDir() string {
	return filepath.Join(v.StorePath(), ".history")
}
