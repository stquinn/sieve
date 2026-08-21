package main

import (
	"embed"
	"fmt"
	"net"
	"net/http"
	"os"
	"path"
	goruntime "runtime"
	"strings"

	"sieve/config"
	"sieve/logger"
	"sieve/requesthandlers"
	"sieve/sieve"
	"sieve/sieve/services"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/menu/keys"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/linux"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// version is the release version shown in the About dialog. It defaults to
// "dev" for local builds and is overridden at build time via the release
// workflow with -ldflags "-X main.version=<git tag>".
var version = "dev"

// aboutMessage is the license/copyright line shared by both About surfaces:
// the macOS AboutInfo panel and the Linux/Windows Help > About dialog.
const aboutMessage = "Apache-2.0 · © 2026 Stephen Quinn\ngithub.com/stquinn/sieve\n\nOpen-source credits: Help → Open Source Licenses"

//go:embed all:frontend/src
var assets embed.FS

//go:embed themes/*.json
var themes embed.FS

//go:embed build/appicon.png
var icon []byte

// localhostBridge is the handler on the loopback TCP listener. It fronts the
// one assembled router with an allow-list, because that listener is reachable
// by the contained AI CLI subprocess (#83) and must expose only what the app
// genuinely cannot serve any other way:
//
//   - /mcp — the CLI's whole reason for being given the URL (app.go points the
//     MCP base URL at this listener).
//   - the two WebSocket wires. Wails serves the app through a custom URI scheme
//     on Linux/WebKitGTK, which cannot carry a WebSocket upgrade, so both wires
//     dial loopback instead (see index.html's __sieveDevServerPort).
//
// Everything else — every view, every operation, every byte — is served only
// through the Wails asset server, where the CLI cannot reach it.
//
// The wires are matched EXACTLY, not by a "/api/ws/" prefix: an unrouted path
// under that prefix falls through chi's NotFound to handleIndex, which answers
// 200 with the whole app shell — the store root, the session, the command
// surface — on the one listener the contained CLI can reach. A third wire is
// therefore a deliberate line here, which is the point.
type localhostBridge struct{ api http.Handler }

func (b localhostBridge) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Match on the cleaned path so "/mcp/../api/settings" cannot be smuggled
	// past the allow-list: neither net/http nor chi normalises a path for us.
	// chi mounts no normalisation either, so a raw path that ISN'T already
	// clean (a trailing slash, "/mcp/../mcp", a doubled slash, ...) would
	// pass the allow-list check here yet match no chi route, falling through
	// to handleIndex — a 200 with the full app shell. Refuse those too.
	clean := path.Clean(r.URL.Path)
	if clean != r.URL.Path {
		logger.Debug("localhost bridge: refused (unnormalised path)", "method", r.Method, "path", r.URL.Path)
		http.NotFound(w, r)
		return
	}
	// The document wire's uuid is the only variable segment on the whole
	// allow-list. A bare "/api/ws/document/" cannot reach the prefix test —
	// path.Clean strips the trailing slash, so the normalisation gate above
	// already refused it — which leaves the prefix matching a non-empty segment
	// only, and chi never sees an empty {uuid}.
	if clean == "/mcp" || clean == "/api/ws/workspace" || strings.HasPrefix(clean, "/api/ws/document/") {
		b.api.ServeHTTP(w, r)
		return
	}
	logger.Debug("localhost bridge: refused", "method", r.Method, "path", r.URL.Path)
	http.NotFound(w, r)
}

func buildMenu(app *App) *menu.Menu {
	js := func(script string) func(*menu.CallbackData) {
		return func(_ *menu.CallbackData) {
			logger.Debug("Menu Action: executing JS", "script", script)
			wailsruntime.WindowExecJS(app.ctx, script)
		}
	}

	isMac := goruntime.GOOS == "darwin"
	openSettings := js("htmx.ajax('GET','/ui/views/settings',{target:'#settings-dialog-content',swap:'innerHTML'}).then(function(){document.getElementById('settings-dialog').showModal()})")

	appMenu := menu.NewMenu()

	if isMac {
		// macOS: AppMenu role provides "Sieve > About, Services, Hide, Quit"
		// EditMenu role provides a proper "Edit" menu with Cut/Copy/Paste/Undo
		appMenu.Append(menu.AppMenu())
	}

	file := appMenu.AddSubmenu("File")
	file.AddText("New Note", keys.CmdOrCtrl("n"), js("window.sieveWorkspace?.newNote()"))
	file.AddText("Save", keys.CmdOrCtrl("s"), js("window.sieveWorkspace?.activeTab?.editor?.flushSave()"))
	file.AddText("Close Tab", keys.CmdOrCtrl("w"), js("window.sieveWorkspace?.closeActiveTab()"))
	// Export submenu — a home for future export targets (file, PDF, …); only the
	// clipboard target ships today. No accelerator; calls the workspace component
	// API, which fetches the clean export and copies it to the clipboard.
	exportMenu := file.AddSubmenu("Export")
	exportMenu.AddText("Clipboard (Markdown)", nil, js("window.sieveWorkspace?.copyDocumentAsMarkdown()"))
	file.AddSeparator()
	file.AddText("Open Library…", keys.Combo("o", keys.CmdOrCtrlKey, keys.ShiftKey),
		js("window.sieveSelectLibrary()"))
	recentMenu := file.AddSubmenu("Open Recent")
	var recents []services.Library
	if app.ServiceProvider != nil && app.ServiceProvider.Library != nil {
		recents = app.ServiceProvider.Library.Recent()
	} else {
		recents = app.library.Recent()
	}
	for _, entry := range recents {
		entryID := entry.Ref
		entryName := entry.Name
		recentMenu.AddText(entryName, nil, func(_ *menu.CallbackData) {
			wailsruntime.WindowExecJS(app.ctx, fmt.Sprintf(`window.sieveSwitchLibrary(%q)`, entryID))
		})
	}
	file.AddText("Create New Library…", nil,
		js("window.go.main.App.CreateVault().then(function(p){ if(p) location.reload() })"))
	//this shuld be Preferences in App menu
	file.AddSeparator()
	settingsLabel := "Settings"
	if isMac {
		settingsLabel = "Preferences"
	}
	file.AddText(settingsLabel, keys.CmdOrCtrl(","), openSettings)
	file.AddSeparator()
	if !isMac {
		// On macOS: Settings lives in Sieve > Preferences (injected by AppMenu role),
		file.AddText("Quit", keys.CmdOrCtrl("q"), func(_ *menu.CallbackData) {
			wailsruntime.Quit(app.ctx)
		})
	}

	// Find/Replace belongs with the editing verbs, not with View (View is for what
	// you look at, not what you operate on). Where the Find submenu hangs is forced
	// by a Wails v2 limitation, so it differs per platform:
	//
	//   - menu.EditMenu() is a bare *role marker* with a nil SubMenu — the native
	//     backend expands it, so nothing can be appended to it.
	//   - The individual role helpers (Undo/Cut/Copy/Paste/SelectAll) and their
	//     Role constants are COMMENTED OUT in v2.12.0's pkg/menu/menuroles.go, and
	//     no backend reads Role at all — so a hand-built Edit menu cannot supply
	//     native editing items either.
	//
	// macOS therefore keeps the role Edit menu (native Undo/Cut/Copy/Paste) and
	// gets Find as its own top-level menu — a normal idiom for Mac text editors
	// (Sublime Text, BBEdit). Linux/Windows have no role Edit menu at all today,
	// so they get the conventional Edit ▸ Find.
	var find *menu.Menu
	if isMac {
		appMenu.Append(menu.EditMenu())
		find = appMenu.AddSubmenu("Find")
	} else {
		find = appMenu.AddSubmenu("Edit").AddSubmenu("Find")
	}
	// One accelerator per row, chosen by platform, rather than parallel rows for
	// both conventions: F3/Shift+F3 is the Windows/Linux idiom, Mod+G/Mod+Shift+G
	// the macOS one, and on Windows/Linux Ctrl+G conventionally means "go to line".
	// (A MenuItem carries exactly one Accelerator, and Hidden=true short-circuits
	// before accelerator registration on every backend — so a hidden duplicate row
	// would silently never bind its chord.)
	find.AddText("Find…", keys.CmdOrCtrl("f"), js("window.sieveWorkspace?.toggleSearch()"))
	if isMac {
		find.AddText("Find Next", keys.CmdOrCtrl("g"), js("window.sieveWorkspace?.searchNext()"))
		find.AddText("Find Previous", keys.Combo("g", keys.CmdOrCtrlKey, keys.ShiftKey), js("window.sieveWorkspace?.searchPrev()"))
	} else {
		find.AddText("Find Next", keys.Key("f3"), js("window.sieveWorkspace?.searchNext()"))
		find.AddText("Find Previous", keys.Shift("f3"), js("window.sieveWorkspace?.searchPrev()"))
	}
	// Replace… slots in here when #61 lands.
	find.AddSeparator()
	find.AddText("Find in Notes…", keys.Combo("f", keys.CmdOrCtrlKey, keys.ShiftKey), js("window.sieveSidebarSearch?.()"))

	view := appMenu.AddSubmenu("View")
	view.AddText("Toggle Sidebar", keys.CmdOrCtrl("\\"), js("htmx.ajax('POST','/api/session/toggle/sidebar',{swap:'none'})"))
	view.AddText("Toggle Meta Panel", keys.Combo("i", keys.CmdOrCtrlKey, keys.ShiftKey), js("htmx.ajax('POST','/api/session/toggle/meta',{swap:'none'})"))
	view.AddText("Toggle Ask Panel", nil, js("htmx.ajax('POST','/api/session/toggle/askpanel',{swap:'none'})"))
	view.AddText("Toggle Prompts", keys.Combo("p", keys.CmdOrCtrlKey, keys.ShiftKey), js("htmx.ajax('POST','/api/session/toggle/prompts',{swap:'none'})"))
	view.AddText("Toggle Line Numbers", nil, js("htmx.ajax('POST','/api/session/toggle/linenumbers',{swap:'none'})"))
	view.AddText("Toggle Editor Mode", keys.Combo("m", keys.CmdOrCtrlKey, keys.ShiftKey), js("window.sieveWorkspace?.activeTab?.editor?.toggleMode()"))
	view.AddSeparator()
	view.AddText("Toggle AI Blocks", keys.CmdOrCtrl("j"), js("window.sieveWorkspace?.activeTab?.editor?.toggleAiBlocks()"))
	view.AddText("Quick Switcher", keys.CmdOrCtrl("p"), js("htmx.ajax('GET','/ui/views/search/dialog',{target:'#quickswitcher-dialog-content',swap:'innerHTML'}).then(function(){document.getElementById('quickswitcher-dialog').showModal()})"))
	view.AddSeparator()
	view.AddText("Show Toolbar", keys.Combo("t", keys.CmdOrCtrlKey, keys.ShiftKey),
		js("htmx.ajax('POST','/api/session/toggle/toolbar',{swap:'none'})"))
	view.AddSeparator()
	// Editor-scale stepping (LookAndFeel.EditorScaleSteps). This is a settings
	// mutation, not a transient zoom: the endpoint persists via SaveSettings so
	// the size survives a restart, then fires the same HX-Trigger:settings:changed
	// the settings-panel save uses, which busts the /ui/theme.css cache-buster link
	// (see index.html's settings:changed listener) so the change is visible
	// immediately. A MenuItem carries exactly one Accelerator (see the Find
	// comment above), so "Mod+=" is the sole chord for increase — the same key
	// browsers use for zoom-in, chosen so Shift isn't required on a US layout.
	view.AddText("Increase Editor Font", keys.CmdOrCtrl("="),
		js("htmx.ajax('POST','/api/settings/editor-scale/step?dir=up',{swap:'none'})"))
	view.AddText("Decrease Editor Font", keys.CmdOrCtrl("-"),
		js("htmx.ajax('POST','/api/settings/editor-scale/step?dir=down',{swap:'none'})"))
	view.AddText("Reset Editor Font", keys.CmdOrCtrl("0"),
		js("htmx.ajax('POST','/api/settings/editor-scale/step?dir=reset',{swap:'none'})"))

	tools := appMenu.AddSubmenu("Tools")
	tools.AddText("Smart Metadata", keys.Combo("m", keys.CmdOrCtrlKey, keys.OptionOrAltKey),
		js("window.SieveAI?.smartMetadata()"))
	tools.AddSeparator()
	tools.AddText("Smart File", keys.Combo("e", keys.CmdOrCtrlKey, keys.ShiftKey), js("window.SieveAI?.smartFile()"))
	tools.AddText("Keep & Smart File", keys.Combo("return", keys.CmdOrCtrlKey, keys.ShiftKey), js("window.SieveAI?.keepAndSmartFile()"))
	tools.AddSeparator()
	// Block-insertion chords. The native menu is the single owner of these
	// app-level accelerators (see docs/editor-interaction-contract.md → App-Level
	// Chords); each calls the component API directly — workspace chrome methods
	// for the insert dialogs, editor.createBlock for the direct insert.
	tools.AddText("Insert WebClip", keys.Combo("w", keys.CmdOrCtrlKey, keys.ShiftKey),
		js("window.sieveWorkspace?.openWebClipDialog()"))
	tools.AddText("Insert URL Card", keys.Combo("l", keys.CmdOrCtrlKey, keys.ShiftKey),
		js("window.sieveWorkspace?.openUrlCardDialog()"))
	tools.AddText("Insert Diagram", keys.Combo("d", keys.CmdOrCtrlKey, keys.ShiftKey),
		js("window.sieveWorkspace?.activeTab?.editor?.createBlock('diagram', {})"))

	help := appMenu.AddSubmenu("Help")
	help.AddText("Shortcuts", keys.CmdOrCtrl("/"), js("htmx.ajax('GET','/ui/views/help',{target:'#help-dialog-content',swap:'innerHTML'}).then(function(){document.getElementById('help-dialog').showModal()})"))
	// Dedicated licenses dialog (licenses.html into the shared #help-dialog
	// container) — the native About box is plain text and cannot hold the
	// license list, so this is the discoverable route to it.
	help.AddText("Open Source Licenses", nil, js("htmx.ajax('GET','/ui/views/licenses',{target:'#help-dialog-content',swap:'innerHTML'}).then(function(){document.getElementById('help-dialog').showModal()})"))
	if !isMac {
		// On Linux/Windows: About belongs in Help
		help.AddText("About", nil, func(_ *menu.CallbackData) {
			wailsruntime.MessageDialog(app.ctx, wailsruntime.MessageDialogOptions{
				Type:    wailsruntime.InfoDialog,
				Title:   "About Sieve",
				Message: "Sieve " + version + "\n\n" + aboutMessage,
			})
		})
	}

	return appMenu
}

func main() {
	// On Linux, WebKit2GTK reinstalls its SIGSEGV handler without SA_ONSTACK
	// after certain internal operations. This fixer goroutine re-adds the flag
	// every 20ms so Go's signal trampoline keeps working as a chained handler.
	startSignalFixer()

	cliArg := ""
	if len(os.Args) > 1 {
		cliArg = os.Args[1]
	}
	recorder := config.Recorder{}
	libSvc := services.NewLibraryService(recorder, recorder.ValidateStore)
	storePath := libSvc.BestOnStartup(cliArg, os.Getenv("SIEVE_STORE"))

	// The job tracker is built first because the broadcast needs it as a
	// constructor argument (jobsFrame reads it from socket goroutines, so it is
	// wired once here rather than exposed as a settable field). Its Notify is
	// wired right after: a method value naming broadcast.PushJobs, taken now
	// that broadcast exists.
	jobTracker := services.NewJobTracker()
	// The workspace push, held by everything with news: the app, the request
	// handlers, the job tracker. It outlives every socket that joins it.
	broadcast := requesthandlers.NewWorkspaceBroadcast(jobTracker)
	jobTracker.Notify = broadcast.PushJobs
	serviceProvider := &sieve.ServiceProvider{Jobs: jobTracker}
	app := NewApp(storePath, themes, broadcast, serviceProvider, libSvc)
	api, err := newAPIHandler(app, broadcast, serviceProvider)
	if err != nil {
		logger.Error("failed to init API handler", "err", err)
		os.Exit(1)
	}

	// Loopback listener carrying the two things the Wails asset server cannot:
	// the MCP endpoint the contained CLI dials, and the WebSocket wires. See
	// localhostBridge for why the surface is an allow-list.
	devPort := os.Getenv("SIEVE_DEV_PORT")
	if devPort == "" {
		devPort = "0"
	}
	ln, err := net.Listen("tcp", "127.0.0.1:"+devPort)
	if err != nil {
		logger.Warn("failed to start loopback listener", "err", err)
	} else {
		app.DevServerPort = ln.Addr().(*net.TCPAddr).Port
		logger.Info("Loopback listener started", "addr", ln.Addr().String(), "port", app.DevServerPort)
		go func() {
			if err := http.Serve(ln, localhostBridge{api: api}); err != nil && err != http.ErrServerClosed {
				logger.Error("loopback listener error", "err", err)
			}
		}()
	}

	err = wails.Run(&options.App{
		Title:                    "Sieve",
		Menu:                     buildMenu(app),
		Width:                    1200,
		Height:                   800,
		MinWidth:                 800,
		MinHeight:                500,
		EnableDefaultContextMenu: true,
		BackgroundColour:         &options.RGBA{R: 26, G: 27, B: 38, A: 1},
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId: "sieve-app-6f3a2b1c",
			OnSecondInstanceLaunch: func(_ options.SecondInstanceData) {
				// bring existing window to front
			},
		},
		AssetServer: &assetserver.Options{
			Assets:  assets,
			Handler: api,
			// The embedded FS would answer /index.html with the raw template, so
			// the app shell is routed to the handler that executes it instead.
			Middleware: func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.URL.Path == "/" || r.URL.Path == "/index.html" {
						api.ServeHTTP(w, r)
						return
					}
					next.ServeHTTP(w, r)
				})
			},
		},
		OnStartup:     app.startup,
		OnBeforeClose: app.beforeClose,
		Bind: []interface{}{
			app,
		},

		Linux: &linux.Options{
			Icon:                icon,
			WindowIsTranslucent: false,
			WebviewGpuPolicy:    linux.WebviewGpuPolicyAlways,
			ProgramName:         "Sieve",
		},
		Mac: &mac.Options{
			TitleBar: &mac.TitleBar{
				TitlebarAppearsTransparent: false,
				HideTitle:                  false,
				HideTitleBar:               false,
				FullSizeContent:            false,
				UseToolbar:                 false,
				HideToolbarSeparator:       true,
			},
			Appearance:           mac.NSAppearanceNameDarkAqua,
			WebviewIsTransparent: true,
			WindowIsTranslucent:  false,
			ContentProtection:    false,
			// macOS specifies About differently: no Help > About item; the
			// "Sieve > About Sieve" entry injected by the AppMenu role renders
			// this panel. Keep the message in sync with the Linux/Windows
			// MessageDialog in buildMenu.
			About: &mac.AboutInfo{
				Title:   "Sieve " + version,
				Message: aboutMessage,
				Icon:    icon,
			},
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
