package block

import "sieve/sieve/domain"

// ContainerView is an immutable, lock-free snapshot of one container, taken when
// a job is described: what a processor's job and a context provider read to
// assemble their context. It is READ-ONLY: nothing is written back through it,
// and it may be stale by the time a long job ends.
type ContainerView interface {
	// Container is the uuid of the container the view shows, "" when it names
	// none.
	Container() string

	// Block returns a copy of the top-level block the container holds under id,
	// or false when it holds none. An empty id is never found.
	Block(id string) (domain.SieveBlock, bool)

	// AddressOf is the absolute address of the block id in this container,
	// sieve://{container}/{id}; the zero Address when the view names no
	// container.
	AddressOf(id string) domain.Address

	// NodeContext is the AIContext of the block id carrying content, headed by
	// the block's absolute address; with no container, no address and no header.
	NodeContext(id, content string) AIContext

	// DocumentContext is the AIContext of the whole container carrying content,
	// headed by the container's own address; with no container, no address and
	// no header.
	DocumentContext(content string) AIContext

	// WholeContext is the whole container as one AIContext, rendered from the
	// blocks filter accepts (nil accepts every block) and headed as
	// DocumentContext heads it.
	WholeContext(filter BlockFilter) AIContext

	// ConversationBefore returns the ids of the blocks the container orders
	// before the block id as conversation, oldest first, and whether the
	// container is a conversation at all. A container that is not one answers
	// no ids and false.
	ConversationBefore(id string) (earlier []string, conversation bool)
}

// ContainerAddressing is the part of a ContainerView that depends on nothing but
// the uuid of the container it shows: the container's name and the addresses
// and headers of what it holds. A view embeds it, so every view addresses its
// blocks one way. The zero value names no container: it addresses nothing and
// heads no context.
type ContainerAddressing struct {
	UUID string
}

// Container is the container's uuid, verbatim.
func (a ContainerAddressing) Container() string { return a.UUID }

// AddressOf is the absolute address of the block id in this container:
// sieve://{UUID}/{id}. It is the zero Address when the view names no container.
func (a ContainerAddressing) AddressOf(id string) domain.Address {
	if a.UUID == "" {
		return domain.Address{}
	}
	return domain.NewLeafAddress(a.UUID, id)
}

// NodeContext is the AIContext of the block id carrying content, headed by the
// block's absolute address. A view with no container yields a context with no
// address, hence no header.
func (a ContainerAddressing) NodeContext(id, content string) AIContext {
	ctx := AIContext{Content: content}
	if addr := a.AddressOf(id); addr.Container != "" {
		ctx.Addresses = []string{addr.String()}
	}
	return ctx
}

// DocumentContext is the AIContext of the whole container carrying content,
// headed by the container's own address, sieve://{UUID}. A view with no
// container yields a context with no address, hence no header.
func (a ContainerAddressing) DocumentContext(content string) AIContext {
	ctx := AIContext{Content: content}
	if a.UUID != "" {
		ctx.Addresses = []string{domain.NewContainerAddress(a.UUID).String()}
	}
	return ctx
}
