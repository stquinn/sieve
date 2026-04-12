package vault

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"stash/logger"
)

// RunCLI executes the configured CLI using the provided prompt content via STDIN
// or CLI arguments depending on the CLI strategy pattern.
func RunCLI(cli string, prompt string, timeoutSecs int) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSecs)*time.Second)
	defer cancel()

	var cmd *exec.Cmd

	// Basic Strategy Pattern for CLI Tools.
	// Always pass the prompt via stdin where possible — never via sh -c.
	// Using sh -c with a double-quoted string causes the shell to interpret
	// backticks as command substitution, silently stripping fenced code block
	// content from the prompt. Stdin has no size or escaping limitations.
	if strings.Contains(cli, "claude") {
		// --print: non-interactive mode. Prompt is read from stdin when not
		// provided as a positional argument. Never use sh -c — backticks in
		// fenced code blocks get interpreted as shell command substitution.
		cmd = exec.CommandContext(ctx, cli, "--print", "--no-session-persistence")
		cmd.Stdin = bytes.NewBufferString(prompt)
	} else if strings.Contains(cli, "gemini") {
		// --prompt "": triggers non-interactive (headless) mode. The empty string
		// is appended to stdin content per the CLI spec, so the full prompt
		// travels via stdin — same stdin-safe strategy as Claude, avoiding any
		// shell interpretation of backticks or special characters in the prompt.
		// --yolo: auto-accepts tool actions so MCP servers / extensions the user
		// has configured never block the call with an approval prompt.
		cmd = exec.CommandContext(ctx, cli, "--prompt", "", "--yolo")
		cmd.Stdin = bytes.NewBufferString(prompt)
	} else if strings.Contains(cli, "copilot") {
		cmd = exec.CommandContext(ctx, "gh", "copilot", "explain", prompt)
	} else {
		cmd = exec.CommandContext(ctx, cli)
		cmd.Stdin = bytes.NewBufferString(prompt)
	}

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	logger.Debug("cli exec start", "path", cmd.Path, "args", cmd.Args, "prompt_len", len(prompt))

	err := cmd.Run()
	
	if ctx.Err() == context.DeadlineExceeded {
		logger.Error("cli timeout", "timeout_secs", timeoutSecs)
		return "", fmt.Errorf("cli timeout after %d seconds", timeoutSecs)
	}
	if err != nil {
		logger.Error("cli execution error", "err", err, "stderr", stderr.String())
		return "", fmt.Errorf("cli execution error: %v (stderr: %s)", err, stderr.String())
	}

	out := stdout.String()
	logger.Debug("cli exec complete", "stdout_len", len(out), "response", out)

	return out, nil
}
