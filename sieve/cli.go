package sieve

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"sieve/logger"
	"sieve/sieve/domain"
)

// RunCLI executes the configured CLI using the provided prompt content via STDIN.
// cwd sets the working directory for the subprocess — pass the note/buffer's
// directory so relative asset paths in markdown resolve correctly. Pass "" to
// inherit the process's working directory.
func RunCLI(cli string, prompt string, model string, timeoutSecs int, cwd string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSecs)*time.Second)
	defer cancel()

	args := buildBaseArgs(cli, model)

	cmd := exec.CommandContext(ctx, cli, args...)
	cmd.Stdin = bytes.NewBufferString(prompt)
	if cwd != "" {
		cmd.Dir = cwd
	}

	// Inherit the full login shell PATH so the subprocess can find tools
	// installed in /usr/local/bin, /opt/homebrew/bin, etc. when the app is
	// launched from the Dock or Finder with a minimal inherited PATH.
	cmd.Env = append(os.Environ(), "PATH="+domain.LoginPath())

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	logger.Debug("cli exec start", "path", cmd.Path, "args", cmd.Args, "model", model, "cwd", cwd)
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

func buildBaseArgs(cli string, model string) []string {
	var args []string
	switch {
	case strings.Contains(cli, "claude"):
		args = []string{"--print", "--no-session-persistence"}
	case strings.Contains(cli, "gemini"):
		args = []string{"--prompt", "", "--yolo", "--skip-trust"}
	case strings.Contains(cli, "copilot"):
		args = []string{"--prompt", "", "--yolo", "--silent"}
	}

	if model != "" && len(args) > 0 {
		args = append(args, "--model", model)
	}
	return args
}
