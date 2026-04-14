package vault

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"stash/logger"
)

// RunCLI executes the configured CLI using the provided prompt content via STDIN
// or CLI arguments depending on the CLI strategy pattern.
func RunCLI(cli string, prompt string, model string, timeoutSecs int) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSecs)*time.Second)
	defer cancel()

	var cmd *exec.Cmd

	

	var args []string
	switch {
	case strings.Contains(cli, "claude"):
		// --print: non-interactive mode. Prompt is read from stdin when not
		// provided as a positional argument.
		args = []string{"--print", "--no-session-persistence"}
	case strings.Contains(cli, "gemini"):
		// --prompt "": triggers non-interactive mode via stdin.
		// --yolo: auto-accepts tool actions.
		args = []string{"--prompt", "", "--yolo"}
	case strings.Contains(cli, "copilot"):
		// --prompt "": triggers non-interactive mode via stdin.
		// --yolo: auto-accepts tool actions.
		// --silent: ensures clean markdown/JSON response without usage stats.
		args = []string{"--prompt", "", "--yolo", "--silent"}
	}

	if model != "" && len(args) > 0 {
		args = append(args, "--model", model)
	}

	cmd = exec.CommandContext(ctx, cli, args...)
	cmd.Stdin = bytes.NewBufferString(prompt)

	// Inherit the full login shell PATH so the subprocess can find tools
	// installed in /usr/local/bin, /opt/homebrew/bin, etc. when the app is
	// launched from the Dock or Finder with a minimal inherited PATH.
	cmd.Env = append(os.Environ(), "PATH="+LoginPath())

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	logger.Debug("cli exec start", "path", cmd.Path, "args", cmd.Args, "model", model)
	logger.LogPrompt(prompt)
	
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
	logger.LogResponse(out)

	return out, nil
}
