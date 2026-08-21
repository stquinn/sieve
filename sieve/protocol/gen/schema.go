package gen

import (
	"fmt"
	"reflect"
	"sort"
	"strings"
)

// Schema is one JSON Schema node in the 2020-12 dialect OpenAPI 3.1 and
// AsyncAPI 3.0 both speak. It is an ordered STRUCT rather than a map so the
// emitted YAML is byte-identical on every run: a map would leave key order to
// the marshaller.
type Schema struct {
	Ref         string // "#/components/schemas/X"; when set, nothing else but Description is emitted
	Type        string // JSON type word
	Description string
	Enum        []string
	Items       *Schema
	Properties  []Property // declaration order, which is the order a reader meets the fields in Go
	Required    []string
	Values      *Schema // additionalProperties for a map
	Any         bool    // an unconstrained JSON value: emitted as {}
}

// Property is one named member of an object schema.
type Property struct {
	Name   string
	Schema *Schema
}

// Field is one struct field as it crosses the wire, resolved to the place it
// travels. Embedded structs are already flattened away: their members appear
// here as members of the outer type, exactly as encoding/json promotes them.
type Field struct {
	JSONName string
	Doc      string // the field's doc:"…" tag
	Query    string // the query:"…" tag: this field is a query parameter, not a body property
	Required bool
	Schema   *Schema
	GoType   string
}

// NamedType pairs a component's name with the Go type it was built from.
type NamedType struct {
	Name string
	Type reflect.Type
}

// SchemaSet turns registered Go types into JSON schemas and remembers each named
// type as a reusable component. It is also where the SELF-DOCUMENTATION RULE
// bites: every named type it meets in this module must carry a godoc comment,
// and generation fails naming the type when one does not.
type SchemaSet struct {
	docs       *DocIndex
	components map[string]*Schema
	names      map[reflect.Type]string
	byName     map[string]reflect.Type // the inverse, to catch two types claiming one name
	enums      map[reflect.Type][]string
	undocument []string
}

// NewSchemaSet opens an empty set reading its prose from docs.
func NewSchemaSet(docs *DocIndex) *SchemaSet {
	return &SchemaSet{
		docs:       docs,
		components: map[string]*Schema{},
		names:      map[reflect.Type]string{},
		byName:     map[string]reflect.Type{},
		enums:      map[reflect.Type][]string{},
	}
}

// Enumerate declares the closed vocabulary of a named type — the values the
// Registry owns, such as the invalidation topics. Nothing is inferred: a type
// gets an enum because the contract enumerates it somewhere, never because its
// package happens to declare constants of that type.
func (s *SchemaSet) Enumerate(t reflect.Type, values []string) {
	s.enums[t] = values
}

// Fields resolves a struct type to the fields that actually cross the wire, with
// embedded members promoted. The type itself is registered as a component, so a
// caller that wants the flat list and a caller that wants a $ref describe the
// same thing.
func (s *SchemaSet) Fields(t reflect.Type) ([]Field, error) {
	if _, err := s.Add(t); err != nil {
		return nil, err
	}
	return s.fieldsOf(t)
}

func (s *SchemaSet) fieldsOf(t reflect.Type) ([]Field, error) {
	if t.Kind() != reflect.Struct {
		return nil, fmt.Errorf("%s is not a struct", t.String())
	}
	var out []Field
	for i := range t.NumField() {
		f := t.Field(i)
		if !f.IsExported() {
			continue
		}
		tag := f.Tag.Get("json")
		name, opts, _ := strings.Cut(tag, ",")
		if name == "-" && opts == "" {
			continue
		}
		// An anonymous field with no json name is PROMOTED by encoding/json: its
		// members sit at the outer type's top level, which is how a frame that
		// embeds its payload stays one flat envelope on the wire.
		if f.Anonymous && name == "" {
			embedded := f.Type
			if embedded.Kind() == reflect.Pointer {
				embedded = embedded.Elem()
			}
			if embedded.Kind() == reflect.Struct {
				if _, err := s.Add(f.Type); err != nil {
					return nil, err
				}
				promoted, err := s.fieldsOf(embedded)
				if err != nil {
					return nil, err
				}
				out = append(out, promoted...)
				continue
			}
		}
		if name == "" {
			name = f.Name
		}
		schema, err := s.Add(f.Type)
		if err != nil {
			return nil, err
		}
		out = append(out, Field{
			JSONName: name,
			Doc:      f.Tag.Get("doc"),
			Query:    f.Tag.Get("query"),
			// A pointer or an omitempty field may be absent; everything else is part
			// of every message of this type.
			Required: !strings.Contains(opts, "omitempty") && f.Type.Kind() != reflect.Pointer,
			Schema:   schema,
			GoType:   f.Type.String(),
		})
	}
	return out, nil
}

// Add returns the schema for t, registering a component for every named type it
// reaches. The returned schema is a $ref when t is named and a literal schema
// when it is not.
func (s *SchemaSet) Add(t reflect.Type) (*Schema, error) {
	if t.Kind() == reflect.Pointer {
		return s.Add(t.Elem())
	}
	if t.PkgPath() != "" {
		return s.named(t)
	}
	return s.anonymous(t)
}

// named handles a declared type. A type declared in this module must document
// itself; one declared elsewhere must be a shape this generator understands
// without reading its source, or the contract is naming something it cannot
// describe.
func (s *SchemaSet) named(t reflect.Type) (*Schema, error) {
	if name, ok := s.names[t]; ok {
		return &Schema{Ref: "#/components/schemas/" + name}, nil
	}
	if t.PkgPath() == "encoding/json" && t.Name() == "RawMessage" {
		// Deliberately opaque: a command's context is whatever the invoking lens
		// wrote, and the contract's promise is that it is JSON, not what shape.
		return &Schema{Any: true}, nil
	}
	loaded, err := s.docs.Load(t.PkgPath())
	if err != nil {
		return nil, err
	}
	if !loaded {
		return nil, fmt.Errorf(
			"the contract names %s.%s, which lives outside this module: the generator cannot read its documentation, so it cannot describe it on the wire",
			t.PkgPath(), t.Name())
	}

	godoc := s.docs.Type(t.PkgPath(), t.Name())
	if godoc == "" {
		s.undocument = append(s.undocument, t.PkgPath()+"."+t.Name())
	}

	name := s.componentName(t)
	if other, taken := s.byName[name]; taken {
		return nil, fmt.Errorf(
			"both %s.%s and %s.%s want the component name %s: qualifying by package name is not enough here, so one of them has to be renamed before either can be published",
			other.PkgPath(), other.Name(), t.PkgPath(), t.Name(), name)
	}
	s.byName[name] = t
	s.names[t] = name
	// Registered BEFORE the body is built, so a type that reaches itself resolves
	// to its own $ref instead of recursing forever.
	s.components[name] = &Schema{}

	body, err := s.body(t)
	if err != nil {
		return nil, err
	}
	body.Description = godoc
	if enum, ok := s.enums[t]; ok {
		body.Enum = enum
	}
	s.components[name] = body
	return &Schema{Ref: "#/components/schemas/" + name}, nil
}

func (s *SchemaSet) body(t reflect.Type) (*Schema, error) {
	if t.Kind() != reflect.Struct {
		return s.anonymous(t)
	}
	fields, err := s.fieldsOf(t)
	if err != nil {
		return nil, err
	}
	return s.ObjectSchema(fields), nil
}

// ObjectSchema assembles fields into one object schema, in declaration order,
// each property carrying its field's doc: tag as its description. It is the ONE
// place a set of fields becomes a schema, so a type's component and an
// endpoint's request body describe the same field the same way.
func (s *SchemaSet) ObjectSchema(fields []Field) *Schema {
	out := &Schema{Type: "object"}
	for _, f := range fields {
		property := *f.Schema
		if f.Doc != "" {
			property.Description = f.Doc
		}
		out.Properties = append(out.Properties, Property{Name: f.JSONName, Schema: &property})
		if f.Required {
			out.Required = append(out.Required, f.JSONName)
		}
	}
	return out
}

func (s *SchemaSet) anonymous(t reflect.Type) (*Schema, error) {
	switch t.Kind() {
	case reflect.String:
		return &Schema{Type: "string"}, nil
	case reflect.Bool:
		return &Schema{Type: "boolean"}, nil
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return &Schema{Type: "integer"}, nil
	case reflect.Float32, reflect.Float64:
		return &Schema{Type: "number"}, nil
	case reflect.Slice, reflect.Array:
		items, err := s.Add(t.Elem())
		if err != nil {
			return nil, err
		}
		return &Schema{Type: "array", Items: items}, nil
	case reflect.Map:
		if t.Key().Kind() != reflect.String {
			return nil, fmt.Errorf("%s: only string-keyed maps cross the wire", t.String())
		}
		values, err := s.Add(t.Elem())
		if err != nil {
			return nil, err
		}
		if values.Any {
			return &Schema{Type: "object"}, nil
		}
		return &Schema{Type: "object", Values: values}, nil
	case reflect.Interface:
		if t.NumMethod() == 0 {
			return &Schema{Any: true}, nil
		}
		return nil, fmt.Errorf("%s: an interface with methods has no wire shape", t.String())
	case reflect.Struct:
		return s.body(t)
	default:
		return nil, fmt.Errorf("%s: %s has no JSON representation", t.String(), t.Kind())
	}
}

// componentName qualifies a type with its package so two packages may both
// declare an Action without colliding, and so a reader of the spec can see where
// a shape is declared.
func (s *SchemaSet) componentName(t reflect.Type) string {
	pkg := t.PkgPath()
	if i := strings.LastIndex(pkg, "/"); i >= 0 {
		pkg = pkg[i+1:]
	}
	return strings.ToUpper(pkg[:1]) + pkg[1:] + t.Name()
}

// Reachable returns the roots plus every component they reference, directly or
// through another, sorted. Each spec then carries the schemas it actually uses
// and no others: an HTTP spec listing every frame payload would be describing a
// contract it does not serve.
func (s *SchemaSet) Reachable(roots []string) []string {
	seen := map[string]bool{}
	queue := append([]string(nil), roots...)
	for len(queue) > 0 {
		name := queue[0]
		queue = queue[1:]
		if seen[name] {
			continue
		}
		schema, ok := s.components[name]
		if !ok {
			continue
		}
		seen[name] = true
		queue = append(queue, schema.refs()...)
	}
	out := make([]string, 0, len(seen))
	for name := range seen {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// refs lists the component names this schema references at any depth within
// itself — its own $ref, its items', its properties'.
func (s *Schema) refs() []string {
	if s == nil {
		return nil
	}
	var out []string
	if s.Ref != "" {
		out = append(out, strings.TrimPrefix(s.Ref, "#/components/schemas/"))
	}
	out = append(out, s.Items.refs()...)
	out = append(out, s.Values.refs()...)
	for _, p := range s.Properties {
		out = append(out, p.Schema.refs()...)
	}
	return out
}

// NamedTypes returns every type that earned a component, ordered by component
// name, paired with that name.
func (s *SchemaSet) NamedTypes() []NamedType {
	out := make([]NamedType, 0, len(s.names))
	for t, name := range s.names {
		out = append(out, NamedType{Name: name, Type: t})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Component returns one registered schema by name.
func (s *SchemaSet) Component(name string) *Schema { return s.components[name] }

// Name returns the component name a type was registered under, or "" for a type
// that earned none — including the nil an endpoint uses for "takes nothing".
func (s *SchemaSet) Name(t reflect.Type) string {
	if t == nil {
		return ""
	}
	if t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	return s.names[t]
}

// Undocumented lists every type that crossed the contract without a godoc
// comment, sorted and deduplicated. Generation fails on a non-empty list: the
// registry holds no prose, so a type with no comment is a piece of the wire that
// nothing in the repository explains.
func (s *SchemaSet) Undocumented() []string {
	seen := map[string]bool{}
	var out []string
	for _, name := range s.undocument {
		if !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}
