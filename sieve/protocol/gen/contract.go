package gen

import (
	"fmt"
	"net/http"
	"reflect"
	"sort"
	"strings"

	"sieve/requesthandlers"
	"sieve/sieve"
	"sieve/sieve/protocol"
	"sieve/store"

	"github.com/go-chi/chi/v5"
)

// Route is one mounted HTTP route: the pair chi routes on.
type Route struct {
	Method  string
	Pattern string
}

// CommandWord is one registered slash command as the frontend must spell it.
type CommandWord struct {
	Family      string
	Name        string
	Description string
}

// Contract is everything the emitters render, gathered from its sources and put
// in the order it will be written: the Registry's vocabulary, the router's route
// table, and the command words the workspace wire carries as data rather than as
// frame types.
//
// It exists so the emitters take an INPUT rather than reaching for globals —
// which is what lets each of them be golden-tested against a small fixture
// instead of against the whole app.
type Contract struct {
	Frames    []protocol.FrameEntry
	Endpoints []protocol.EndpointEntry
	Topics    []protocol.Topic
	Routes    []Route
	Commands  []CommandWord
	// AssetURLPrefix is the served-asset route prefix the store mints. The JS
	// module builds asset URLs from it, so the concatenation Go serves and the one
	// the browser requests come from one constant.
	AssetURLPrefix string
	// WSSubprotocol is the subprotocol both wires negotiate. The browser half
	// dials with it, so it is published for the same reason the frame words are:
	// a client that spells it as a literal has re-declared a contract Go owns.
	WSSubprotocol string
	// DeclaredIn is the import path whose package godoc opens the artifacts and
	// whose constants name the topics. It is resolved by reflection rather than
	// spelled out, so moving the package cannot leave the artifacts quoting a path
	// nothing lives at.
	DeclaredIn string
}

// NewContract gathers the live contract: the target registry, the real route
// table, and the filing family's verbs.
func NewContract() (Contract, error) {
	registry := protocol.NewRegistry()
	c := Contract{
		Frames:         registry.Frames(),
		Endpoints:      registry.Endpoints(),
		Topics:         registry.Topics(),
		AssetURLPrefix: store.AssetURLPrefix,
		WSSubprotocol:  protocol.WSSubprotocol,
		DeclaredIn:     reflect.TypeOf(protocol.PingFrame{}).PkgPath(),
	}
	if err := c.walkRoutes(); err != nil {
		return Contract{}, err
	}
	c.readCommands()
	return c, nil
}

// walkRoutes reads the app's real router. The route table is assembled in
// exactly one place — requesthandlers.Registry.Mount — so this is the app's
// surface and not a second description of it; the handlers are stubs because a
// walk reads patterns, never behaviour.
func (c *Contract) walkRoutes() error {
	r := chi.NewRouter()
	stub := http.NotFoundHandler()
	requesthandlers.Registry{
		ServiceProvider: &sieve.ServiceProvider{},
		Broadcast:       requesthandlers.NewWorkspaceBroadcast(nil),
		MCP:             stub,
		Static:          stub,
		Index:           stub,
	}.Mount(r)

	err := chi.Walk(r, func(method, pattern string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		c.Routes = append(c.Routes, Route{Method: method, Pattern: pattern})
		return nil
	})
	if err != nil {
		return fmt.Errorf("walk routes: %w", err)
	}
	sort.Slice(c.Routes, func(i, j int) bool {
		if c.Routes[i].Method != c.Routes[j].Method {
			return c.Routes[i].Method < c.Routes[j].Method
		}
		return c.Routes[i].Pattern < c.Routes[j].Pattern
	})
	return nil
}

// readCommands enumerates every slash command the app registers, off the SAME
// list the composition root registers from — ServiceProvider.CommandSet. Sharing
// the list is what closes the drift: a verb the app dispatches but the artifacts
// never mention would have to be registered outside the one registration site.
//
// The set is built on a zero ServiceProvider and each verb is asked its own
// name, family and description. That reads metadata only; no command's Build is
// ever called, so no behaviour runs and no service is touched.
func (c *Contract) readCommands() {
	for _, cmd := range (&sieve.ServiceProvider{}).CommandSet() {
		c.Commands = append(c.Commands, CommandWord{
			Family:      cmd.Family(),
			Name:        cmd.Name(),
			Description: cmd.Description(),
		})
	}
	// Family first so the artifacts group a family's verbs together, then name so
	// a new verb inserts one row rather than reshuffling the table.
	sort.Slice(c.Commands, func(i, j int) bool {
		if c.Commands[i].Family != c.Commands[j].Family {
			return c.Commands[i].Family < c.Commands[j].Family
		}
		return c.Commands[i].Name < c.Commands[j].Name
	})
}

// CommandFamilies returns each distinct family once, in the order the sorted
// command list meets them.
func (c Contract) CommandFamilies() []string {
	seen := map[string]bool{}
	var out []string
	for _, cmd := range c.Commands {
		if !seen[cmd.Family] {
			seen[cmd.Family] = true
			out = append(out, cmd.Family)
		}
	}
	return out
}

// CommandsIn returns one family's verbs, in the contract's order.
func (c Contract) CommandsIn(family string) []CommandWord {
	var out []CommandWord
	for _, cmd := range c.Commands {
		if cmd.Family == family {
			out = append(out, cmd)
		}
	}
	return out
}

// FramesFor returns one channel's frames travelling one way, sorted by type
// word. Sorting rather than keeping registration order is what makes the
// artifacts stable: adding a frame inserts one row instead of reshuffling the
// table beneath it.
func (c Contract) FramesFor(channel protocol.Channel, direction protocol.Direction) []protocol.FrameEntry {
	var out []protocol.FrameEntry
	for _, f := range c.Frames {
		if f.Channel == channel && f.Direction == direction {
			out = append(out, f)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Type < out[j].Type })
	return out
}

// Channels returns the wires in the order the artifacts document them.
func (c Contract) Channels() []protocol.Channel {
	return []protocol.Channel{protocol.ChannelDocument, protocol.ChannelWorkspace}
}

// Directions returns inbound before outbound: a reader follows a request to its
// reply, not the other way round.
func (c Contract) Directions() []protocol.Direction {
	return []protocol.Direction{protocol.Inbound, protocol.Outbound}
}

// SortedEndpoints returns the typed endpoints by path then method, so the
// operations on one resource sit together.
func (c Contract) SortedEndpoints() []protocol.EndpointEntry {
	out := append([]protocol.EndpointEntry(nil), c.Endpoints...)
	sort.Slice(out, func(i, j int) bool {
		if out[i].Path != out[j].Path {
			return out[i].Path < out[j].Path
		}
		return out[i].Method < out[j].Method
	})
	return out
}

// ChannelAddress returns the route a channel is dialled on, read out of the
// route table: a WS route's third segment IS the channel name. Deriving it beats
// declaring it — a channel whose route was renamed or never mounted fails
// generation instead of documenting an address nothing serves.
func (c Contract) ChannelAddress(channel protocol.Channel) (string, error) {
	for _, r := range c.Routes {
		rest, ok := strings.CutPrefix(r.Pattern, "/api/ws/")
		if !ok {
			continue
		}
		name, _, _ := strings.Cut(rest, "/")
		if name == string(channel) {
			return r.Pattern, nil
		}
	}
	return "", fmt.Errorf("no route mounts the %s channel: the wire is documented but nothing serves it", channel)
}

// PathParams returns a route pattern's {name} placeholders, in the order they
// appear — the OpenAPI path parameters, taken from the route itself rather than
// from a convention a request struct would have to repeat.
func (c Contract) PathParams(pattern string) []string {
	var out []string
	rest := pattern
	for {
		_, after, found := strings.Cut(rest, "{")
		if !found {
			return out
		}
		name, tail, closed := strings.Cut(after, "}")
		if !closed {
			return out
		}
		out = append(out, name)
		rest = tail
	}
}
