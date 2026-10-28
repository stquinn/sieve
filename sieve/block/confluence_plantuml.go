package block

import (
	"strings"

	"github.com/yuin/goldmark/util"
)

// plantumlWriter writes one PlantUML diagram's source as the element a
// Confluence edition stores it as.
type plantumlWriter interface {
	Macro(source string) string
}

// serverPlantUML writes a diagram as Server and Data Center's plantuml
// structured macro.
type serverPlantUML struct {
	g *ConfluenceGenerator
}

// Macro returns the plantuml structured macro holding source.
func (w serverPlantUML) Macro(source string) string {
	return w.g.structuredMacro("plantuml", "atlassian-macro-output-type", "INLINE", source)
}

// The PlantUML Forge app on Confluence Cloud. A Forge extension key is
// {appId}/{environmentId}/static/{module}, and the app's production environment
// is the same on every site that installs it.
const (
	cloudPlantUMLAppID         = "f0d9b32e-808f-4e58-9330-0346bc051ed9"
	cloudPlantUMLEnvironmentID = "32a28da1-3e65-4244-a865-3244636e10c6"
	cloudPlantUMLExtensionKey  = cloudPlantUMLAppID + "/" + cloudPlantUMLEnvironmentID + "/static/plantuml-diagram"
	cloudPlantUMLExtensionID   = "ari:cloud:ecosystem::extension/" + cloudPlantUMLExtensionKey
	cloudPlantUMLTitle         = "PlantUML Diagram"
	cloudPlantUMLEnvironment   = "PRODUCTION"
)

// cloudPlantUML writes a diagram as the PlantUML app's ADF extension node. The
// node carries no embedded-macro-context: that names the page, space, account
// and site the diagram was saved on, none of which an export knows. mint returns
// a fresh local id for each diagram.
type cloudPlantUML struct {
	mint func() string
}

// Macro returns the ADF extension node holding source as its diagram-code,
// XML-escaped element text with the fence's closing newline dropped. One local id
// is minted per call and written to both local-id slots.
func (w cloudPlantUML) Macro(source string) string {
	localID := w.mint()
	code := string(util.EscapeHTML([]byte(strings.TrimRight(source, "\n"))))
	var b strings.Builder
	b.WriteString("<ac:adf-extension>\n")
	b.WriteString(`  <ac:adf-node type="extension">` + "\n")
	b.WriteString(`    <ac:adf-attribute key="extension-key">` + cloudPlantUMLExtensionKey + "</ac:adf-attribute>\n")
	b.WriteString(`    <ac:adf-attribute key="extension-type">com.atlassian.ecosystem</ac:adf-attribute>` + "\n")
	b.WriteString(`    <ac:adf-attribute key="parameters">` + "\n")
	b.WriteString(`      <ac:adf-parameter key="local-id">` + localID + "</ac:adf-parameter>\n")
	b.WriteString(`      <ac:adf-parameter key="extension-id">` + cloudPlantUMLExtensionID + "</ac:adf-parameter>\n")
	b.WriteString(`      <ac:adf-parameter key="extension-title">` + cloudPlantUMLTitle + "</ac:adf-parameter>\n")
	b.WriteString(`      <ac:adf-parameter key="layout">extension</ac:adf-parameter>` + "\n")
	b.WriteString(`      <ac:adf-parameter key="forge-environment">` + cloudPlantUMLEnvironment + "</ac:adf-parameter>\n")
	b.WriteString(`      <ac:adf-parameter key="guest-params">` + "\n")
	b.WriteString(`        <ac:adf-parameter key="diagram-code">` + code + "</ac:adf-parameter>\n")
	b.WriteString("      </ac:adf-parameter>\n")
	b.WriteString("    </ac:adf-attribute>\n")
	b.WriteString(`    <ac:adf-attribute key="text">` + cloudPlantUMLTitle + "</ac:adf-attribute>\n")
	b.WriteString(`    <ac:adf-attribute key="layout">default</ac:adf-attribute>` + "\n")
	b.WriteString(`    <ac:adf-attribute key="local-id">` + localID + "</ac:adf-attribute>\n")
	b.WriteString("  </ac:adf-node>\n")
	b.WriteString("</ac:adf-extension>")
	return b.String()
}
