package main

import (
	"fmt"
	"os"
	"path/filepath"
	"stash/stash"
	"stash/store/filestore"
)

func main() {
	root := "test-store"
	hostname := "test-host"
	os.RemoveAll(root)
	defer os.RemoveAll(root)

	fs, err := filestore.NewFileStore(root, hostname)
	if err != nil {
		panic(err)
	}

	if err := fs.PrepareCategory(stash.Prompts); err != nil {
		panic(err)
	}

	name := "file"
	content := "test prompt content"

	fmt.Printf("Saving prompt %s...\n", name)
	_, err = fs.CreateText(stash.Prompts, name+".md", []byte(content))
	if err != nil {
		panic(err)
	}

	// Verify file exists
	expectedPath := filepath.Join(root, hostname, "prompts", name+".md")
	if _, err := os.Stat(expectedPath); err != nil {
		fmt.Printf("FAIL: file not found at %s\n", expectedPath)
	} else {
		fmt.Printf("SUCCESS: file found at %s\n", expectedPath)
	}

	// Verify load
	fmt.Printf("Loading prompt %s...\n", name)
	s, err := fs.Load(stash.Prompts, name+".md")
	if err != nil {
		fmt.Printf("FAIL: load failed: %v\n", err)
	} else if string(s.Body()) != content {
		fmt.Printf("FAIL: content mismatch: got %q, want %q\n", string(s.Body()), content)
	} else {
		fmt.Printf("SUCCESS: load matched content\n")
	}
}
