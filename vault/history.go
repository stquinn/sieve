package vault

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
)

func (v *Vault) HistoryDir() string {
	return filepath.Join(v.HostDir, ".history")
}

// SaveVersionSnapshot writes {uuid}.{version}.md to the history dir.
// content is the full fm+body that was just saved to the live file.
func (v *Vault) SaveVersionSnapshot(uuid string, version int, content string) error {
	if err := os.MkdirAll(v.HistoryDir(), 0o755); err != nil {
		return err
	}
	name := fmt.Sprintf("%s.%d.md", uuid, version)
	return os.WriteFile(filepath.Join(v.HistoryDir(), name), []byte(content), 0o644)
}

// PruneHistory deletes the oldest snapshot files for a UUID,
// keeping only the newest maxVersions entries.
func (v *Vault) PruneHistory(uuid string, maxVersions int) error {
	if maxVersions <= 0 {
		return nil
	}
	pattern := filepath.Join(v.HistoryDir(), uuid+".*.md")
	matches, err := filepath.Glob(pattern)
	if err != nil || len(matches) <= maxVersions {
		return err
	}
	// Sort by version number ascending so we delete the oldest first
	sort.Slice(matches, func(i, j int) bool {
		return versionFromName(matches[i]) < versionFromName(matches[j])
	})
	for _, f := range matches[:len(matches)-maxVersions] {
		os.Remove(f)
	}
	return nil
}

// DeleteHistory removes all snapshot files for a UUID (called on DiscardBuffer).
func (v *Vault) DeleteHistory(uuid string) error {
	pattern := filepath.Join(v.HistoryDir(), uuid+".*.md")
	matches, _ := filepath.Glob(pattern)
	for _, f := range matches {
		os.Remove(f)
	}
	return nil
}

var versionRe = regexp.MustCompile(`\.(\d+)\.md$`)

func versionFromName(path string) int {
	base := filepath.Base(path)
	if m := versionRe.FindStringSubmatch(base); m != nil {
		n, _ := strconv.Atoi(m[1])
		return n
	}
	return 0
}
