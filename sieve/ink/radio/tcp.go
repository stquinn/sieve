package radio

import (
	"context"
	"net"
	"time"
)

// TCP is a Radio that dials a fixed TCP address, for companions that listen
// on a socket instead of advertising.
type TCP struct {
	addr     string
	identity string
}

// NewTCP returns a Radio that dials addr (host:port) and reports identity for
// every Link.
func NewTCP(addr, identity string) *TCP {
	return &TCP{addr: addr, identity: identity}
}

// Dial connects to the configured address.
func (t *TCP) Dial(ctx context.Context) (Link, error) {
	started := time.Now()
	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", t.addr)
	if err != nil {
		return nil, err
	}
	return &tcpLink{Conn: conn, identity: t.identity, elapsed: time.Since(started)}, nil
}

type tcpLink struct {
	net.Conn
	identity string
	elapsed  time.Duration
}

func (l *tcpLink) Identity() string      { return l.identity }
func (l *tcpLink) Elapsed() time.Duration { return l.elapsed }
