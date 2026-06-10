//go:build linux

package main

// WebKit2GTK reinstalls its SIGSEGV handler without SA_ONSTACK after certain
// internal operations (JIT compilation, rendering). Without SA_ONSTACK the kernel
// delivers the signal on the thread's regular stack instead of the signal stack.
// When Go's signal trampoline then runs as a chained handler it finds sp outside
// the expected signal-stack range and panics: "non-Go code set up signal handler
// without SA_ONSTACK flag".
//
// This file installs a lightweight CGO goroutine that runs every 20ms and adds
// SA_ONSTACK back to the SIGSEGV handler if WebKit has stripped it. It does not
// change the handler function — only the flag — so WebKit's own handling is
// unaffected; it just now runs on the signal stack where Go expects it.

/*
#include <signal.h>
#include <string.h>

// Reads the current SIGSEGV sigaction and ORs in SA_ONSTACK if absent.
// No-op if the flag is already set. Thread-safe: sigaction is a syscall.
static void ensure_sigsegv_sa_onstack() {
    struct sigaction sa;
    if (sigaction(SIGSEGV, NULL, &sa) != 0) return;
    if (sa.sa_flags & SA_ONSTACK) return;
    sa.sa_flags |= SA_ONSTACK;
    sigaction(SIGSEGV, &sa, NULL);
}
*/
import "C"
import "time"

// startSignalFixer starts a background goroutine that periodically ensures the
// SIGSEGV signal handler has SA_ONSTACK set. Call once from main().
func startSignalFixer() {
	go func() {
		for {
			time.Sleep(20 * time.Millisecond)
			C.ensure_sigsegv_sa_onstack()
		}
	}()
}
