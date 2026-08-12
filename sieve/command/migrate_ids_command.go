package command

import (
	"fmt"
	"strings"
	"time"

	"sieve/sieve/domain"
)

// ─── /migrate-ids ────────────────────────────────────────────────────────────

// IdentitySweeper is the port /migrate-ids drives. The concrete sweep lives in
// editor/ (the only package that can see both the block codec and the document
// service); this package cannot import block/ at all, because block → ai →
// command is an existing edge. The result type lives in domain/, the leaf both
// sides already share.
type IdentitySweeper interface {
	SweepLibrary() domain.IdentitySweepResult
}

// MigrateIDsCommand upgrades every document in the attached library to UUID block
// ids. Migration is otherwise lazy — a document is upgraded when it is OPENED —
// so documents nobody has opened keep legacy short handles, which are still valid
// ids but not globally unique. Until they are upgraded their blocks cannot be
// addressed from outside the document, which is the whole point of #75.
type MigrateIDsCommand struct {
	sweeper IdentitySweeper
}

func NewMigrateIDsCommand(sweeper IdentitySweeper) *MigrateIDsCommand {
	return &MigrateIDsCommand{sweeper: sweeper}
}

func (c *MigrateIDsCommand) Name() string { return "migrate-ids" }
func (c *MigrateIDsCommand) Description() string {
	return "Upgrade every document's block ids to UUIDs so blocks are addressable"
}
func (c *MigrateIDsCommand) Family() string     { return FamilyUtil }
func (c *MigrateIDsCommand) ResultKind() string { return "command-result" }

func (c *MigrateIDsCommand) Build(_ string, _ Context) (Job, error) {
	createdAt := time.Now().UTC().Format(time.RFC3339)

	return Job{
		Label:   "/migrate-ids",
		Pending: nil,
		Work: func() (Block, error) {
			if c.sweeper == nil {
				return c.result(createdAt, domain.IdentitySweepResult{
					Failures: []string{"no library attached"},
				}), nil
			}
			return c.result(createdAt, c.sweeper.SweepLibrary()), nil
		},
	}, nil
}

// result renders the sweep report as a command-result block.
func (c *MigrateIDsCommand) result(createdAt string, r domain.IdentitySweepResult) Block {
	lines := []string{
		"| Metric | Count |",
		"| :--- | :--- |",
		fmt.Sprintf("| **Documents scanned** | `%d` |", r.Scanned),
		fmt.Sprintf("| **Documents migrated** | `%d` |", r.Migrated),
		fmt.Sprintf("| **Blocks re-identified** | `%d` |", r.BlocksReidentified),
	}
	if len(r.Failures) > 0 {
		lines = append(lines, fmt.Sprintf("| **Failed** | `%d` |", len(r.Failures)), "")
		lines = append(lines, "**Skipped:**", "")
		for _, f := range r.Failures {
			lines = append(lines, "- "+f)
		}
	} else if r.Migrated == 0 {
		lines = append(lines, "", "*Nothing to do — every document already uses UUID block ids.*")
	}

	return Block{Kind: "command-result", Attrs: map[string]interface{}{
		"cmd":         "migrate-ids",
		"status":      "COMPLETE",
		"title":       "🔑 Block Identity Migration",
		"response":    strings.Join(lines, "\n"),
		"primary":     fmt.Sprintf("%d/%d documents migrated", r.Migrated, r.Scanned),
		"createdAt":   createdAt,
		"completedAt": time.Now().UTC().Format(time.RFC3339),
	}}
}
