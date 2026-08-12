package command

import (
	"strings"
	"testing"

	"sieve/sieve/domain"
)

type fakeSweeper struct {
	result domain.IdentitySweepResult
	calls  int
}

func (f *fakeSweeper) SweepLibrary() domain.IdentitySweepResult {
	f.calls++
	return f.result
}

func TestMigrateIDsCommand_Metadata(t *testing.T) {
	c := NewMigrateIDsCommand(nil)
	if c.Name() != "migrate-ids" {
		t.Fatalf("name = %q", c.Name())
	}
	if c.Family() != FamilyUtil {
		t.Fatalf("family = %q, want %q", c.Family(), FamilyUtil)
	}
	if c.ResultKind() != "command-result" {
		t.Fatalf("result kind = %q", c.ResultKind())
	}
	if c.Description() == "" {
		t.Fatal("no description — the command popup lists it")
	}
}

// No library attached must report, not panic.
func TestMigrateIDsCommand_NilSweeperReportsCleanly(t *testing.T) {
	job, err := NewMigrateIDsCommand(nil).Build("", Context{})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	blk, err := job.Work()
	if err != nil {
		t.Fatalf("work: %v", err)
	}
	if blk.Kind != "command-result" {
		t.Fatalf("kind = %q", blk.Kind)
	}
	if blk.Attrs["status"] != "COMPLETE" {
		t.Fatalf("status = %v", blk.Attrs["status"])
	}
	resp, _ := blk.Attrs["response"].(string)
	if !strings.Contains(resp, "no library attached") {
		t.Fatalf("response did not explain the empty run:\n%s", resp)
	}
}

func TestMigrateIDsCommand_ReportsCounts(t *testing.T) {
	sweeper := &fakeSweeper{result: domain.IdentitySweepResult{
		Scanned: 12, Migrated: 3, BlocksReidentified: 47,
	}}
	job, _ := NewMigrateIDsCommand(sweeper).Build("", Context{})
	blk, err := job.Work()
	if err != nil {
		t.Fatalf("work: %v", err)
	}
	if sweeper.calls != 1 {
		t.Fatalf("sweeper called %d times, want 1", sweeper.calls)
	}
	resp, _ := blk.Attrs["response"].(string)
	for _, want := range []string{"`12`", "`3`", "`47`"} {
		if !strings.Contains(resp, want) {
			t.Fatalf("response missing %s:\n%s", want, resp)
		}
	}
	if got, _ := blk.Attrs["primary"].(string); got != "3/12 documents migrated" {
		t.Fatalf("primary = %q", got)
	}
}

// A clean library must say so rather than reporting a silent row of zeroes.
func TestMigrateIDsCommand_NothingToDoIsExplicit(t *testing.T) {
	sweeper := &fakeSweeper{result: domain.IdentitySweepResult{Scanned: 9}}
	job, _ := NewMigrateIDsCommand(sweeper).Build("", Context{})
	blk, _ := job.Work()
	resp, _ := blk.Attrs["response"].(string)
	if !strings.Contains(resp, "Nothing to do") {
		t.Fatalf("clean sweep not reported as such:\n%s", resp)
	}
}

// Failures must be surfaced, not swallowed — a silently skipped document reads
// as "covered everything" when it was not.
func TestMigrateIDsCommand_SurfacesFailures(t *testing.T) {
	sweeper := &fakeSweeper{result: domain.IdentitySweepResult{
		Scanned: 5, Migrated: 4, BlocksReidentified: 8,
		Failures: []string{"doc-uuid-1: parse: unexpected fence"},
	}}
	job, _ := NewMigrateIDsCommand(sweeper).Build("", Context{})
	blk, _ := job.Work()
	resp, _ := blk.Attrs["response"].(string)
	if !strings.Contains(resp, "doc-uuid-1") || !strings.Contains(resp, "unexpected fence") {
		t.Fatalf("failure not surfaced:\n%s", resp)
	}
}
