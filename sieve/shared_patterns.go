package sieve

import "regexp"

// MermaidFenceRe matches a mermaid code fence block.
// It is shared across DiagramProcessor (to extract it) and SmartImageProcessor (to convert it).
var MermaidFenceRe = regexp.MustCompile("(?s)^```mermaid\n(.+)\n```$")
