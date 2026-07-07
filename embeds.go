package main

import "embed"

// Frontend embeds. go:embed paths are resolved relative to the declaring
// file's directory and cannot climb above it, so these MUST be declared at
// the project root. The embedded values are consumed by newAPIHandler.

//go:embed frontend/src/templates
var uiTemplates embed.FS

//go:embed frontend/src/static
var uiStatic embed.FS

//go:embed frontend/src/index.html
var uiIndexHTML string
