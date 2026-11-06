//go:build linux

package radio

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"
	"tinygo.org/x/bluetooth"

	"sieve/logger"
)

// Linux Bluetooth socket constants that golang.org/x/sys/unix does not export
// (include/net/bluetooth/bluetooth.h).
const (
	bdaddrLEPublic = 0x01
	bdaddrLERandom = 0x02
	solBluetooth   = 274
	btSndMTU       = 12
	btRcvMTU       = 13

	// The largest SDU this end accepts, which is the largest the companion will
	// send in one piece. It must stay at 4096: an Android companion delivers
	// larger SDUs with bytes altered, and the frame they carry does not open.
	wantRcvMTU = 4096

	scanLimit       = 30 * time.Second
	connectAttempts = 3
	connectLimit    = 15 * time.Second
	connectPause    = 500 * time.Millisecond

	// A live companion sends something every 2 s, so this much silence is a dead link.
	readTimeoutSeconds = 10
)

// uuidText is a UUID in its written form.
type uuidText string

// uuid parses t; the constants below are fixed, so a failure is a programming error.
func (t uuidText) uuid() bluetooth.UUID {
	u, err := bluetooth.ParseUUID(string(t))
	if err != nil {
		panic(err)
	}
	return u
}

var (
	serviceUUID  = uuidText("a378dfef-96d7-4aa8-a37f-3bd6e376da00").uuid()
	psmUUID      = uuidText("a378dfef-96d7-4aa8-a37f-3bd6e376da01").uuid()
	identityUUID = uuidText("a378dfef-96d7-4aa8-a37f-3bd6e376da02").uuid()
	offerUUID    = uuidText("a378dfef-96d7-4aa8-a37f-3bd6e376da03").uuid()
)

// bluetoothRadio finds a companion by its service UUID, never by its address,
// and opens its L2CAP channel. Dials are serialised.
type bluetoothRadio struct {
	mu      sync.Mutex
	adapter *bluetooth.Adapter
	enabled bool
}

// NewBluetooth returns the platform's Bluetooth Radio. The adapter is enabled
// on the first Dial.
func NewBluetooth() Radio {
	return &bluetoothRadio{adapter: bluetooth.DefaultAdapter}
}

// Dial scans for a companion, reads its control characteristics and opens its
// channel. The channel's PSM is read on every dial because it changes whenever
// the companion's adapter restarts.
func (r *bluetoothRadio) Dial(ctx context.Context) (Link, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.enabled {
		if err := r.adapter.Enable(); err != nil {
			return nil, fmt.Errorf("enable adapter: %w", err)
		}
		r.enabled = true
	}
	found, err := r.scan(ctx)
	if err != nil {
		return nil, err
	}
	seen := time.Now()
	logger.Debug("ink companion found", "address", found.Address.String(), "random", found.Address.IsRandom(), "rssi", found.RSSI)
	dev, err := r.connect(ctx, found.Address)
	if err != nil {
		return nil, err
	}
	control, err := bounded[companionControl]{}.run(ctx, func() (companionControl, error) { return r.readControl(dev) })
	if err != nil {
		_ = dev.Disconnect()
		return nil, err
	}
	logger.Debug("ink companion control read", "psm", control.psm)
	socket, err := dialL2CAP(found.Address, control.psm)
	if err != nil {
		_ = dev.Disconnect()
		return nil, err
	}
	elapsed := time.Since(seen)
	logger.Info("ink channel open", "rcvmtu", socket.rcvMTU, "sndmtu", socket.sndMTU, "elapsed", elapsed.Round(time.Millisecond))
	return &bluetoothLink{
		socket:   socket,
		device:   dev,
		reader:   bufio.NewReaderSize(socket, wantRcvMTU+1),
		identity: control.identity,
		elapsed:  elapsed,
	}, nil
}

// scan returns the first advertisement carrying the Sieve ink service UUID.
func (r *bluetoothRadio) scan(ctx context.Context) (bluetooth.ScanResult, error) {
	scanCtx, cancel := context.WithTimeout(ctx, scanLimit)
	defer cancel()
	results := make(chan bluetooth.ScanResult, 1)
	_, err := bounded[struct{}]{}.run(scanCtx, func() (struct{}, error) {
		return struct{}{}, r.adapter.Scan(func(a *bluetooth.Adapter, result bluetooth.ScanResult) {
			if !result.HasServiceUUID(serviceUUID) {
				return
			}
			select {
			case results <- result:
				_ = a.StopScan()
			default:
			}
		})
	})
	_ = r.adapter.StopScan()
	select {
	case result := <-results:
		return result, nil
	default:
	}
	if ctx.Err() != nil {
		return bluetooth.ScanResult{}, ctx.Err()
	}
	if err != nil && !errors.Is(err, context.DeadlineExceeded) {
		return bluetooth.ScanResult{}, fmt.Errorf("scan: %w", err)
	}
	return bluetooth.ScanResult{}, fmt.Errorf("scan: no companion within %v", scanLimit)
}

// connect brings up the GATT link over D-Bus, up to connectAttempts times, each
// within connectLimit. BlueZ intermittently answers an attempt with
// le-connection-abort-by-local, and the library's connect takes no deadline, so
// it can block for ever. An attempt given up on keeps running: if it succeeds
// the link is up and the next attempt finds it connected.
func (r *bluetoothRadio) connect(ctx context.Context, addr bluetooth.Address) (bluetooth.Device, error) {
	var err error
	for attempt := 1; attempt <= connectAttempts; attempt++ {
		var dev bluetooth.Device
		dev, err = bounded[bluetooth.Device]{limit: connectLimit}.run(ctx, func() (bluetooth.Device, error) {
			return r.adapter.Connect(addr, bluetooth.ConnectionParams{})
		})
		if err == nil {
			logger.Debug("ink gatt connected", "address", addr.String())
			return dev, nil
		}
		if ctx.Err() != nil {
			return bluetooth.Device{}, ctx.Err()
		}
		logger.Info("ink gatt connect failed", "address", addr.String(), "attempt", attempt, "of", connectAttempts, "err", err)
		select {
		case <-time.After(connectPause):
		case <-ctx.Done():
			return bluetooth.Device{}, ctx.Err()
		}
	}
	return bluetooth.Device{}, fmt.Errorf("gatt connect: %w", err)
}

// bluetoothLink is the channel and the GATT link under it.
type bluetoothLink struct {
	socket   *l2capSocket
	device   bluetooth.Device
	reader   *bufio.Reader
	identity string
	elapsed  time.Duration
}

func (l *bluetoothLink) Read(p []byte) (int, error)  { return l.reader.Read(p) }
func (l *bluetoothLink) Write(p []byte) (int, error) { return l.socket.Write(p) }
func (l *bluetoothLink) Identity() string            { return l.identity }
func (l *bluetoothLink) Elapsed() time.Duration      { return l.elapsed }

// Close closes the channel and disconnects the GATT link.
func (l *bluetoothLink) Close() error {
	l.socket.close()
	return l.device.Disconnect()
}

// companionControl is what the companion's GATT characteristics say.
type companionControl struct {
	psm      uint16
	identity string
}

// readControl reads the psm (u16 little-endian), identity and offer characteristics.
func (r *bluetoothRadio) readControl(dev bluetooth.Device) (companionControl, error) {
	services, err := dev.DiscoverServices([]bluetooth.UUID{serviceUUID})
	if err != nil {
		return companionControl{}, fmt.Errorf("discover service: %w", err)
	}
	if len(services) == 0 {
		return companionControl{}, errors.New("discover service: none found")
	}
	chars, err := services[0].DiscoverCharacteristics([]bluetooth.UUID{psmUUID, identityUUID, offerUUID})
	if err != nil {
		return companionControl{}, fmt.Errorf("discover characteristics: %w", err)
	}
	if len(chars) < 3 {
		return companionControl{}, fmt.Errorf("discover characteristics: %d found, want 3", len(chars))
	}
	buf := make([]byte, 128)
	n, err := chars[0].Read(buf)
	if err != nil {
		return companionControl{}, fmt.Errorf("read psm: %w", err)
	}
	if n != 2 {
		return companionControl{}, fmt.Errorf("psm is %d bytes, want 2", n)
	}
	psm := uint16(buf[0]) | uint16(buf[1])<<8
	n, err = chars[1].Read(buf)
	if err != nil {
		return companionControl{}, fmt.Errorf("read identity: %w", err)
	}
	identity := string(buf[:n])
	if _, err = chars[2].Read(buf); err != nil {
		return companionControl{}, fmt.Errorf("read offer: %w", err)
	}
	return companionControl{psm: psm, identity: identity}, nil
}

// hardwareAddress is a Bluetooth address in the display order
// unix.SockaddrL2 expects.
type hardwareAddress [6]byte

// parseHardwareAddress reads "AA:BB:CC:DD:EE:FF".
func parseHardwareAddress(text string) (hardwareAddress, error) {
	var mac hardwareAddress
	parts := strings.Split(text, ":")
	if len(parts) != 6 {
		return mac, fmt.Errorf("bad address %q", text)
	}
	for i, p := range parts {
		if len(p) != 2 {
			return mac, fmt.Errorf("bad address %q", text)
		}
		if _, err := fmt.Sscanf(p, "%02x", &mac[i]); err != nil {
			return mac, fmt.Errorf("bad address %q: %w", text, err)
		}
	}
	return mac, nil
}

// l2capSocket is one LE L2CAP connection-oriented channel, a SOCK_SEQPACKET
// socket whose every read returns one SDU and every write sends one.
type l2capSocket struct {
	fd     int
	rcvMTU int
	sndMTU int
}

// dialL2CAP connects an LE channel to psm on the peer.
func dialL2CAP(peer bluetooth.Address, psm uint16) (*l2capSocket, error) {
	addr, err := parseHardwareAddress(peer.String())
	if err != nil {
		return nil, err
	}
	fd, err := unix.Socket(unix.AF_BLUETOOTH, unix.SOCK_SEQPACKET, unix.BTPROTO_L2CAP)
	if err != nil {
		return nil, fmt.Errorf("socket: %w", err)
	}
	s := &l2capSocket{fd: fd}
	if err := unix.Bind(fd, &unix.SockaddrL2{AddrType: bdaddrLEPublic}); err != nil {
		s.close()
		return nil, fmt.Errorf("bind: %w", err)
	}
	if err := unix.SetsockoptString(fd, solBluetooth, btRcvMTU, string([]byte{byte(wantRcvMTU & 0xff), byte(wantRcvMTU >> 8)})); err != nil {
		logger.Debug("ink BT_RCVMTU not set, keeping default", "want", wantRcvMTU, "err", err)
	}
	tv := unix.Timeval{Sec: readTimeoutSeconds}
	if err := unix.SetsockoptTimeval(fd, unix.SOL_SOCKET, unix.SO_RCVTIMEO, &tv); err != nil {
		s.close()
		return nil, fmt.Errorf("SO_RCVTIMEO: %w", err)
	}
	addrType := uint8(bdaddrLEPublic)
	if peer.IsRandom() {
		addrType = bdaddrLERandom
	}
	if err := unix.Connect(fd, &unix.SockaddrL2{PSM: psm, Addr: addr, AddrType: addrType}); err != nil {
		s.close()
		return nil, fmt.Errorf("l2cap connect psm=%d addr=%s type=%d: %w", psm, peer.String(), addrType, err)
	}
	s.rcvMTU = s.mtu(btRcvMTU)
	s.sndMTU = s.mtu(btSndMTU)
	return s, nil
}

// mtu reads a u16 socket option; the kernel writes two bytes, so the int's high
// half stays zero.
func (s *l2capSocket) mtu(opt int) int {
	v, err := unix.GetsockoptInt(s.fd, solBluetooth, opt)
	if err != nil {
		return -1
	}
	return v & 0xffff
}

// Read is one SDU; p must hold the largest one.
func (s *l2capSocket) Read(p []byte) (int, error) {
	n, err := unix.Read(s.fd, p)
	if err != nil {
		return 0, fmt.Errorf("l2cap read: %w", err)
	}
	if n == 0 {
		return 0, io.EOF
	}
	return n, nil
}

// Write sends p in SDUs of at most the peer's MTU.
func (s *l2capSocket) Write(p []byte) (int, error) {
	if s.sndMTU <= 0 {
		return 0, errors.New("l2cap: no send MTU")
	}
	sent := 0
	for sent < len(p) {
		n, err := unix.Write(s.fd, p[sent:min(sent+s.sndMTU, len(p))])
		if err != nil {
			return sent, fmt.Errorf("l2cap write: %w", err)
		}
		sent += n
	}
	return sent, nil
}

func (s *l2capSocket) close() { _ = unix.Close(s.fd) }
