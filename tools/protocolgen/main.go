// Command protocolgen writes the four artifacts that publish Sieve's wire
// contract: docs/API.md, docs/openapi.yaml, docs/asyncapi.yaml and the frontend's
// generated protocol.js.
//
// It is invoked by the go:generate directive in sieve/protocol, and takes no
// input beyond the checkout it runs in — the contract is the code.
//
//	go generate ./sieve/protocol
package main

import (
	"flag"
	"fmt"
	"os"

	"sieve/sieve/protocol/gen"
)

func main() {
	out := flag.String("out", "", "directory to write the artifacts into (default: the module root)")
	flag.Parse()

	if err := run(*out); err != nil {
		fmt.Fprintf(os.Stderr, "protocolgen: %v\n", err)
		os.Exit(1)
	}
}

func run(out string) error {
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	// The module is located rather than assumed, because go:generate runs this
	// from the directory of the package that declares the directive.
	module, err := gen.NewModule(cwd)
	if err != nil {
		return err
	}
	generator, err := gen.New(module)
	if err != nil {
		return err
	}
	if out == "" {
		out = module.Root
	}
	return generator.Generate(out)
}
