//go:build !linux

package main

// startSignalFixer is a no-op on non-Linux platforms. The SIGSEGV/SA_ONSTACK
// workaround it provides on Linux (see signal_linux.go) is only needed because
// WebKit2GTK strips the flag; other platforms' webviews don't have this issue.
func startSignalFixer() {}
