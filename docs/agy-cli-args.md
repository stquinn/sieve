# agy CLI args (captured 2026-07-16)

> Peer to `copilot-cli-args.md`. **agy IS Antigravity.** Its config home is `~/.gemini/` — the **legacy directory name Antigravity reuses**; the `gemini` CLI itself is **retired** (sign-in fails → migrate to Antigravity), so do **not** rely on the `gemini` binary or `gemini mcp`. agy-CLI-specific config: `~/.gemini/antigravity-cli/` (`settings.json`, `mcp_config.json`); MCP OAuth tokens in `~/.gemini/mcp-oauth-tokens-v2.json`. Manage agy's MCP servers by **writing `mcp_config.json` directly**, not via any gemini tooling. Captured from `agy --help`; headless run verified (`agy --print "…"` → response; `--print` takes the prompt as its arg, not stdin).

| Option | Purpose |
|---|---|
| `--add-dir` | Add a directory to the workspace (repeatable) |
| `--agent` | Agent for the current CLI session |
| `-c`, `--continue` | Continue the most recent conversation |
| `--conversation` | Resume a previous conversation by ID |
| `--dangerously-skip-permissions` | Auto-approve all tool permission requests without prompting |
| `-i`, `--prompt-interactive` | Run an initial prompt interactively and continue the session |
| `--log-file` | Override CLI log file path |
| `--mode` | Agent execution mode: `accept-edits`, `plan` |
| `--model` | Model for the current CLI session |
| `--new-project` | Create a new project for this session |
| `-p`, `--print`, `--prompt` | Run a single prompt non-interactively and print the response |
| `--print-timeout` | Timeout for print mode wait (default 5m0s) |
| `--project` | Project ID for the current CLI session |
| `--sandbox` | Run in a sandbox with terminal restrictions enabled |

Subcommands: `agent(s)`, `changelog`, `help`, `install`, `models`, `plugin(s)` (install/uninstall/list/enable/disable), `update`.

## Containment-relevant reality (see `design/specs/2026-07-16-ai-cli-containment-and-sieve-mcp-design.md`)

- **Path confinement:** ✅ `--add-dir` (repeatable) + dropping `--dangerously-skip-permissions`.
- **Coarse read-only:** `--mode plan` and/or `--sandbox`.
- **Per-tool allow/deny:** ❌ no flag (no `--allowedTools`/`--deny-tool` equivalent). Containment of tools is coarse (`--mode`/`--sandbox`), not per-tool.
- **MCP servers:** ✅ *supported*, but via **config file** (`~/.gemini/antigravity-cli/mcp_config.json`, managed by `gemini mcp`) — ❌ **no per-invocation `--mcp-config` inject flag.** So the user's own agy MCP servers work (inherited from that file); the **Sieve MCP cannot be injected ephemerally per call** the way it can on claude/copilot.
- **Consequence for the `ContainmentProfile`:**
  - Default: renders **directories only** under coarse read-only; **per-tool allowlist and ephemeral MCP injection are not expressible** → those grants fail closed (dropped, surfaced in UI).
  - Optional (if agy library access is wanted): Sieve **writes/regenerates the Sieve server into `~/.gemini/antigravity-cli/mcp_config.json` at app startup** (machine-local, *not* the synced library — so the earlier "don't write CLI config files" objection is weaker here; the URL+token staleness is handled by regenerating each launch). This is the one documented exception to "args only", justified because agy has no inject flag. Decide per follow-up.
