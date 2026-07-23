package block

import "regexp"

// MermaidFenceRe matches a mermaid code fence block.
// It is shared across DiagramProcessor (to extract it) and SmartImageProcessor (to convert it).
// The fence may be 3 or more backticks: the editor sizes fences longer than any
// backtick run in the content, so nested-fence blocks arrive with 4+ ticks.
var MermaidFenceRe = regexp.MustCompile("(?s)^`{3,}mermaid\n(.+)\n`{3,}$")

// PlantumlFenceRe matches a plantuml code fence block.
// It is shared across DiagramProcessor (to extract it) and SmartImageProcessor (to convert it).
// The fence may be 3 or more backticks: the editor sizes fences longer than any
// backtick run in the content, so nested-fence blocks arrive with 4+ ticks.
var PlantumlFenceRe = regexp.MustCompile("(?s)^`{3,}plantuml\n(.+)\n`{3,}$")
