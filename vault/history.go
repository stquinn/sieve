package vault

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
)

func (v *Vault) HostHistoryDir() string {
	return filepath.Join(v.HostDir, ".history")
}

func (v *Vault) VaultHistoryDir() string {
	return filepath.Join(v.Root, ".history")
}

// SaveVersionSnapshot writes {uuid}.{version}.md to the history dir.
// content is the full fm+body that was just saved to the live file.
func (v *Vault) SaveVersionSnapshot(uuid string, version int, content string) error {
	isFiled := regexp.MustCompile(`(?m)^status:\s*filed`).MatchString(content)
	dir := v.HostHistoryDir()
	if isFiled {
		dir = v.VaultHistoryDir()
	}

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	name := fmt.Sprintf("%s.%d.md", uuid, version)
	return os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644)
}

// PruneHistory deletes the oldest snapshot files for a UUID,
// keeping only the newest maxVersions entries across all history dirs.
func (v *Vault) PruneHistory(uuid string, maxVersions int) error {
	if maxVersions <= 0 {
		return nil
	}
	p1 := filepath.Join(v.HostHistoryDir(), uuid+".*.md")
	p2 := filepath.Join(v.VaultHistoryDir(), uuid+".*.md")
	m1, _ := filepath.Glob(p1)
	m2, _ := filepath.Glob(p2)
	matches := append(m1, m2...)

	if len(matches) <= maxVersions {
		return nil
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
	p1 := filepath.Join(v.HostHistoryDir(), uuid+".*.md")
	p2 := filepath.Join(v.VaultHistoryDir(), uuid+".*.md")
	m1, _ := filepath.Glob(p1)
	m2, _ := filepath.Glob(p2)
	for _, f := range append(m1, m2...) {
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
