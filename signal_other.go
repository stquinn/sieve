//go:build !linux || !cgo

package main

// startSignalFixer is a no-op on non-Linux platforms and in cgo-off builds. The
// SIGSEGV/SA_ONSTACK workaround it provides (see signal_linux.go, which is built
// only with `linux && cgo`) is needed only when the WebKit2GTK webview runs and
// strips the flag; other platforms' webviews don't have this issue, and cgo-off
// builds (tests/CI) don't run the webview at all. Keeping this no-op for
// `!linux || !cgo` lets the whole module compile and test with CGO_ENABLED=0.
func startSignalFixer() {}
