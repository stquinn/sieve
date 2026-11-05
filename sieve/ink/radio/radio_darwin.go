//go:build darwin && cgo

package radio

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	"github.com/tinygo-org/cbgo"

	"sieve/logger"
)

const (
	powerLimit      = 30 * time.Second
	scanLimit       = 30 * time.Second
	connectAttempts = 3
	connectLimit    = 15 * time.Second
	connectPause    = 500 * time.Millisecond
	gattLimit       = 10 * time.Second
	channelLimit    = 15 * time.Second

	// A live companion sends something every 2 s, so this much silence is a dead link.
	silenceLimit = 10 * time.Second
)

var (
	serviceUUID  = cbgo.MustParseUUID("a378dfef-96d7-4aa8-a37f-3bd6e376da00")
	psmUUID      = cbgo.MustParseUUID("a378dfef-96d7-4aa8-a37f-3bd6e376da01")
	identityUUID = cbgo.MustParseUUID("a378dfef-96d7-4aa8-a37f-3bd6e376da02")
	offerUUID    = cbgo.MustParseUUID("a378dfef-96d7-4aa8-a37f-3bd6e376da03")
)

// coreBluetoothRadio finds a companion by its service UUID, never by its
// identifier, and opens its L2CAP channel. Dials are serialised, and a Dial
// while a link is open fails.
//
// Every CoreBluetooth callback arrives on cbgo's one serial queue, which also
// services the channel's streams, so no callback here may block.
type coreBluetoothRadio struct {
	mu      sync.Mutex
	manager cbgo.CentralManager
	// central is nil until the first Dial creates the manager, which is what
	// raises the system's Bluetooth privacy prompt.
	central *centralDelegate
}

// NewBluetooth returns the platform's Bluetooth Radio. The central manager is
// created on the first Dial and kept for the life of the process.
func NewBluetooth() Radio {
	return &coreBluetoothRadio{}
}

// Dial waits for Bluetooth to be powered on, scans for a companion, reads its
// control characteristics and opens its channel. The channel's PSM is read on
// every dial because it changes whenever the companion's adapter restarts.
func (r *coreBluetoothRadio) Dial(ctx context.Context) (Link, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.powerOn(ctx); err != nil {
		return nil, err
	}
	if r.central.holding() {
		return nil, errors.New("an ink link is already open")
	}
	found, err := r.scan(ctx)
	if err != nil {
		return nil, err
	}
	logger.Debug("ink companion found", "peripheral", found.id, "rssi", found.rssi)
	if err := r.connect(ctx, found); err != nil {
		return nil, err
	}
	session := newPeripheralDelegate(found)
	found.peripheral.SetDelegate(session)
	r.central.hold(session)
	control, err := session.readControl(ctx)
	if err != nil {
		r.release(session)
		return nil, err
	}
	logger.Debug("ink companion control read", "psm", control.psm)
	stream, err := session.openChannel(ctx, control.psm)
	if err != nil {
		r.release(session)
		return nil, err
	}
	elapsed := time.Since(found.seen)
	logger.Info("ink channel open", "psm", control.psm, "elapsed", elapsed.Round(time.Millisecond))
	return &coreBluetoothLink{
		radio:    r,
		session:  session,
		stream:   stream,
		identity: control.identity,
		elapsed:  elapsed,
	}, nil
}

// powerOn creates the central manager on first use and waits, within
// powerLimit, for it to settle into a state.
func (r *coreBluetoothRadio) powerOn(ctx context.Context) error {
	if r.central == nil {
		r.central = newCentralDelegate()
		r.manager = cbgo.NewCentralManager(nil)
		r.manager.SetDelegate(r.central)
		logger.Info("ink bluetooth manager created", "state", managerState(r.manager.State()))
	}
	timer := time.NewTimer(powerLimit)
	defer timer.Stop()
	for {
		state := managerState(r.manager.State())
		if settled, err := state.settled(); settled {
			return err
		}
		select {
		case <-r.central.stateChanged:
		case <-timer.C:
			return fmt.Errorf("bluetooth: not ready after %v, state %s", powerLimit, state)
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// scan returns the first peripheral advertising the Sieve ink service UUID.
func (r *coreBluetoothRadio) scan(ctx context.Context) (discovery, error) {
	found := r.central.expectDiscovery()
	r.manager.Scan([]cbgo.UUID{serviceUUID}, &cbgo.CentralManagerScanOpts{AllowDuplicates: true})
	d, err := bounded[discovery]{limit: scanLimit}.wait(ctx, found)
	r.manager.StopScan()
	r.central.stopDiscovery()
	switch {
	case err == nil:
		return d, nil
	case ctx.Err() != nil:
		return discovery{}, ctx.Err()
	case errors.Is(err, errTimedOut):
		return discovery{}, fmt.Errorf("scan: no companion within %v", scanLimit)
	default:
		return discovery{}, fmt.Errorf("scan: %w", err)
	}
}

// connect brings up the GATT link, up to connectAttempts times, each within
// connectLimit. CoreBluetooth never times a connect out itself, so an attempt
// given up on is cancelled.
func (r *coreBluetoothRadio) connect(ctx context.Context, d discovery) error {
	var err error
	for attempt := 1; attempt <= connectAttempts; attempt++ {
		if err = r.connectOnce(ctx, d); err == nil {
			logger.Debug("ink gatt connected", "peripheral", d.id)
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		logger.Info("ink gatt connect failed", "peripheral", d.id, "attempt", attempt, "of", connectAttempts, "err", err)
		select {
		case <-time.After(connectPause):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return fmt.Errorf("gatt connect: %w", err)
}

func (r *coreBluetoothRadio) connectOnce(ctx context.Context, d discovery) error {
	answer := r.central.expectConnect(d.id)
	r.manager.Connect(d.peripheral, &cbgo.CentralManagerConnectOpts{})
	_, err := bounded[struct{}]{limit: connectLimit}.wait(ctx, answer)
	r.central.stopConnect()
	if errors.Is(err, errTimedOut) || ctx.Err() != nil {
		r.manager.CancelConnect(d.peripheral)
	}
	return err
}

// release drops the peripheral's delegate and its connection. It is safe to
// call more than once.
func (r *coreBluetoothRadio) release(session *peripheralDelegate) {
	session.peripheral.SetDelegate(nil)
	r.manager.CancelConnect(session.peripheral)
	r.central.forget(session)
}

// discovery is one advertisement of the ink service.
type discovery struct {
	peripheral cbgo.Peripheral
	id         string
	rssi       int
	seen       time.Time
}

// centralDelegate turns the central manager's callbacks into answers for the
// one Dial in progress. cbgo holds it for as long as it is the manager's
// delegate, which is the life of the process.
type centralDelegate struct {
	cbgo.CentralManagerDelegateBase

	stateChanged chan struct{}

	mu         sync.Mutex
	discovered mailbox[discovery] // non-nil while scanning
	connecting string             // the peripheral a connect attempt waits for
	connected  mailbox[struct{}]  // non-nil while a connect attempt waits
	session    *peripheralDelegate
}

func newCentralDelegate() *centralDelegate {
	return &centralDelegate{stateChanged: make(chan struct{}, 1)}
}

func (c *centralDelegate) CentralManagerDidUpdateState(cmgr cbgo.CentralManager) {
	logger.Info("ink bluetooth state", "state", managerState(cmgr.State()))
	select {
	case c.stateChanged <- struct{}{}:
	default:
	}
}

func (c *centralDelegate) DidDiscoverPeripheral(_ cbgo.CentralManager, prph cbgo.Peripheral, _ cbgo.AdvFields, rssi int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.discovered != nil {
		c.discovered.offer(discovery{peripheral: prph, id: prph.Identifier().String(), rssi: rssi, seen: time.Now()}, nil)
	}
}

func (c *centralDelegate) DidConnectPeripheral(_ cbgo.CentralManager, prph cbgo.Peripheral) {
	c.answerConnect(prph, nil)
}

func (c *centralDelegate) DidFailToConnectPeripheral(_ cbgo.CentralManager, prph cbgo.Peripheral, err error) {
	if err == nil {
		err = errors.New("CoreBluetooth gave no reason")
	}
	c.answerConnect(prph, newCoreBluetoothError(err))
}

func (c *centralDelegate) DidDisconnectPeripheral(_ cbgo.CentralManager, prph cbgo.Peripheral, err error) {
	id := prph.Identifier().String()
	logger.Info("ink gatt disconnected", "peripheral", id, "err", newCoreBluetoothError(err))
	cause := errors.New("companion disconnected")
	if err != nil {
		cause = fmt.Errorf("companion disconnected: %w", newCoreBluetoothError(err))
	}
	c.answerConnect(prph, cause)
	c.mu.Lock()
	session := c.session
	c.mu.Unlock()
	if session != nil && session.id == id {
		session.disconnected(cause)
	}
}

func (c *centralDelegate) answerConnect(prph cbgo.Peripheral, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.connected != nil && c.connecting == prph.Identifier().String() {
		c.connected.offer(struct{}{}, err)
	}
}

func (c *centralDelegate) expectDiscovery() mailbox[discovery] {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.discovered = make(mailbox[discovery], 1)
	return c.discovered
}

func (c *centralDelegate) stopDiscovery() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.discovered = nil
}

func (c *centralDelegate) expectConnect(id string) mailbox[struct{}] {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.connecting, c.connected = id, make(mailbox[struct{}], 1)
	return c.connected
}

func (c *centralDelegate) stopConnect() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.connecting, c.connected = "", nil
}

// hold makes session the connected peripheral that disconnects are reported to.
func (c *centralDelegate) hold(session *peripheralDelegate) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.session = session
}

func (c *centralDelegate) forget(session *peripheralDelegate) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.session == session {
		c.session = nil
	}
}

func (c *centralDelegate) holding() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.session != nil
}

// companionControl is what the companion's GATT characteristics say.
type companionControl struct {
	psm      uint16
	identity string
}

// peripheralDelegate turns one connected companion's callbacks into answers.
// cbgo holds it until SetDelegate(nil); after that its callbacks are dropped.
type peripheralDelegate struct {
	cbgo.PeripheralDelegateBase

	peripheral cbgo.Peripheral
	id         string

	services        mailbox[struct{}]
	characteristics mailbox[struct{}]
	values          map[string]mailbox[[]byte] // by characteristic UUID
	opened          mailbox[*blockingStream]
	streamsChanged  chan struct{}

	mu      sync.Mutex
	channel coreBluetoothChannel
	stream  *blockingStream
}

func newPeripheralDelegate(d discovery) *peripheralDelegate {
	return &peripheralDelegate{
		peripheral:      d.peripheral,
		id:              d.id,
		services:        make(mailbox[struct{}], 1),
		characteristics: make(mailbox[struct{}], 1),
		values: map[string]mailbox[[]byte]{
			psmUUID.String():      make(mailbox[[]byte], 1),
			identityUUID.String(): make(mailbox[[]byte], 1),
			offerUUID.String():    make(mailbox[[]byte], 1),
		},
		opened:         make(mailbox[*blockingStream], 1),
		streamsChanged: make(chan struct{}, 1),
	}
}

func (p *peripheralDelegate) DidDiscoverServices(_ cbgo.Peripheral, err error) {
	p.services.offer(struct{}{}, newCoreBluetoothError(err))
}

func (p *peripheralDelegate) DidDiscoverCharacteristics(_ cbgo.Peripheral, _ cbgo.Service, err error) {
	p.characteristics.offer(struct{}{}, newCoreBluetoothError(err))
}

func (p *peripheralDelegate) DidUpdateValueForCharacteristic(_ cbgo.Peripheral, chr cbgo.Characteristic, err error) {
	box, ok := p.values[chr.UUID().String()]
	if !ok {
		return
	}
	if err != nil {
		box.offer(nil, newCoreBluetoothError(err))
		return
	}
	box.offer(chr.Value(), nil)
}

// DidOpenL2CAPChannel registers the stream event handler here, on the
// callback queue, because the queue holds back the streams' first events
// until this returns; registered any later, they could be lost.
func (p *peripheralDelegate) DidOpenL2CAPChannel(_ cbgo.Peripheral, ch cbgo.L2CAPChannel, err error) {
	if err != nil {
		p.opened.offer(nil, newCoreBluetoothError(err))
		return
	}
	if ch == (cbgo.L2CAPChannel{}) {
		p.opened.offer(nil, errors.New("CoreBluetooth reported no channel and no error"))
		return
	}
	channel := coreBluetoothChannel{ch}
	stream := newBlockingStream(channel, silenceLimit)
	ch.SetEventHandler(p.streamEvents(stream))
	p.mu.Lock()
	p.channel, p.stream = channel, stream
	p.mu.Unlock()
	p.opened.offer(stream, nil)
}

// streamEvents is the channel's event handler: it wakes the stream and
// whoever waits for the streams to open, and never blocks.
func (p *peripheralDelegate) streamEvents(stream *blockingStream) func(cbgo.StreamEvent, bool) {
	return func(event cbgo.StreamEvent, input bool) {
		stream.notify(input)
		if ended := event & (cbgo.StreamEventErrorOccurred | cbgo.StreamEventEndEncountered); ended != 0 {
			stream.notify(!input)
			logger.Info("ink channel stream ended", "input", input, "error", ended&cbgo.StreamEventErrorOccurred != 0)
		}
		select {
		case p.streamsChanged <- struct{}{}:
		default:
		}
	}
}

// disconnected ends whatever waits on this peripheral with cause.
func (p *peripheralDelegate) disconnected(cause error) {
	p.services.offer(struct{}{}, cause)
	p.characteristics.offer(struct{}{}, cause)
	for _, box := range p.values {
		box.offer(nil, cause)
	}
	p.opened.offer(nil, cause)
	p.mu.Lock()
	stream := p.stream
	p.mu.Unlock()
	if stream != nil {
		stream.fail(cause)
	}
}

// readControl discovers the ink service and reads its psm (u16 little-endian),
// identity and offer characteristics, each step within gattLimit.
func (p *peripheralDelegate) readControl(ctx context.Context) (companionControl, error) {
	gatt := bounded[struct{}]{limit: gattLimit}
	p.peripheral.DiscoverServices([]cbgo.UUID{serviceUUID})
	if _, err := gatt.wait(ctx, p.services); err != nil {
		return companionControl{}, fmt.Errorf("discover service: %w", err)
	}
	var service cbgo.Service
	found := false
	for _, s := range p.peripheral.Services() {
		if s.UUID().String() == serviceUUID.String() {
			service, found = s, true
		}
	}
	if !found {
		return companionControl{}, errors.New("discover service: none found")
	}
	p.peripheral.DiscoverCharacteristics([]cbgo.UUID{psmUUID, identityUUID, offerUUID}, service)
	if _, err := gatt.wait(ctx, p.characteristics); err != nil {
		return companionControl{}, fmt.Errorf("discover characteristics: %w", err)
	}
	chars := map[string]cbgo.Characteristic{}
	for _, c := range service.Characteristics() {
		if _, wanted := p.values[c.UUID().String()]; wanted {
			chars[c.UUID().String()] = c
		}
	}
	if len(chars) < len(p.values) {
		return companionControl{}, fmt.Errorf("discover characteristics: %d found, want %d", len(chars), len(p.values))
	}
	psm, err := p.read(ctx, chars, psmUUID)
	if err != nil {
		return companionControl{}, fmt.Errorf("read psm: %w", err)
	}
	if len(psm) != 2 {
		return companionControl{}, fmt.Errorf("psm is %d bytes, want 2", len(psm))
	}
	identity, err := p.read(ctx, chars, identityUUID)
	if err != nil {
		return companionControl{}, fmt.Errorf("read identity: %w", err)
	}
	if _, err := p.read(ctx, chars, offerUUID); err != nil {
		return companionControl{}, fmt.Errorf("read offer: %w", err)
	}
	return companionControl{psm: uint16(psm[0]) | uint16(psm[1])<<8, identity: string(identity)}, nil
}

func (p *peripheralDelegate) read(ctx context.Context, chars map[string]cbgo.Characteristic, uuid cbgo.UUID) ([]byte, error) {
	p.peripheral.ReadCharacteristic(chars[uuid.String()])
	return bounded[[]byte]{limit: gattLimit}.wait(ctx, p.values[uuid.String()])
}

// openChannel opens the L2CAP channel on psm and waits, within channelLimit,
// for the channel and then for both its streams to be open.
func (p *peripheralDelegate) openChannel(ctx context.Context, psm uint16) (*blockingStream, error) {
	p.peripheral.OpenL2CAPChannel(psm)
	stream, err := bounded[*blockingStream]{limit: channelLimit}.wait(ctx, p.opened)
	if err != nil {
		return nil, fmt.Errorf("open l2cap channel psm=%d: %w", psm, err)
	}
	if err := p.awaitStreams(ctx); err != nil {
		_ = stream.Close()
		return nil, fmt.Errorf("open l2cap streams psm=%d: %w", psm, err)
	}
	return stream, nil
}

func (p *peripheralDelegate) awaitStreams(ctx context.Context) error {
	p.mu.Lock()
	channel := p.channel
	p.mu.Unlock()
	timer := time.NewTimer(channelLimit)
	defer timer.Stop()
	for {
		in, out := channel.statuses()
		if in.failed() || out.failed() {
			return fmt.Errorf("input stream %s, output stream %s", in, out)
		}
		if in.open() && out.open() {
			return nil
		}
		select {
		case <-p.streamsChanged:
		case <-timer.C:
			return fmt.Errorf("%w after %v: input stream %s, output stream %s", errTimedOut, channelLimit, in, out)
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// coreBluetoothLink is the channel and the GATT connection under it.
type coreBluetoothLink struct {
	radio     *coreBluetoothRadio
	session   *peripheralDelegate
	stream    *blockingStream
	identity  string
	elapsed   time.Duration
	closeOnce sync.Once
}

func (l *coreBluetoothLink) Read(p []byte) (int, error)  { return l.stream.Read(p) }
func (l *coreBluetoothLink) Write(p []byte) (int, error) { return l.stream.Write(p) }
func (l *coreBluetoothLink) Identity() string            { return l.identity }
func (l *coreBluetoothLink) Elapsed() time.Duration      { return l.elapsed }

// Close closes the channel, which unblocks any Read or Write, then drops the
// peripheral's delegate and cancels its connection. It is idempotent.
func (l *coreBluetoothLink) Close() error {
	l.closeOnce.Do(func() {
		_ = l.stream.Close()
		l.radio.release(l.session)
		logger.Debug("ink link closed", "peripheral", l.session.id)
	})
	return nil
}

// coreBluetoothChannel is a cbgo L2CAP channel as a pollable. cbgo's Read and
// Write never block: they return 0 and nil when the stream has nothing or no
// room, including when the stream has failed, so a zero count is checked
// against the stream's status.
type coreBluetoothChannel struct {
	ch cbgo.L2CAPChannel
}

func (c coreBluetoothChannel) Read(p []byte) (int, error) {
	n, err := c.ch.Read(p)
	if errors.Is(err, io.EOF) {
		return 0, io.EOF
	}
	if err != nil {
		return 0, fmt.Errorf("l2cap read: %w", newCoreBluetoothError(err))
	}
	if n > 0 {
		return n, nil
	}
	switch status := streamStatus(c.ch.InputStreamStatus()); status {
	case streamStatus(cbgo.StreamStatusAtEnd):
		return 0, io.EOF
	case streamStatus(cbgo.StreamStatusClosed):
		return 0, net.ErrClosed
	case streamStatus(cbgo.StreamStatusError):
		return 0, fmt.Errorf("l2cap read: input stream %s", status)
	}
	return 0, nil
}

func (c coreBluetoothChannel) Write(p []byte) (int, error) {
	n, err := c.ch.Write(p)
	if err != nil {
		return 0, fmt.Errorf("l2cap write: %w", newCoreBluetoothError(err))
	}
	if n == 0 {
		if status := streamStatus(c.ch.OutputStreamStatus()); status.failed() {
			return 0, fmt.Errorf("l2cap write: output stream %s", status)
		}
	}
	return n, nil
}

func (c coreBluetoothChannel) Close() { c.ch.Close() }

func (c coreBluetoothChannel) statuses() (input, output streamStatus) {
	return streamStatus(c.ch.InputStreamStatus()), streamStatus(c.ch.OutputStreamStatus())
}

// streamStatus is the state of one of a channel's streams.
type streamStatus cbgo.StreamStatus

func (s streamStatus) open() bool {
	switch cbgo.StreamStatus(s) {
	case cbgo.StreamStatusOpen, cbgo.StreamStatusReading, cbgo.StreamStatusWriting:
		return true
	}
	return false
}

func (s streamStatus) failed() bool {
	switch cbgo.StreamStatus(s) {
	case cbgo.StreamStatusAtEnd, cbgo.StreamStatusClosed, cbgo.StreamStatusError:
		return true
	}
	return false
}

func (s streamStatus) String() string {
	switch cbgo.StreamStatus(s) {
	case cbgo.StreamStatusNotOpen:
		return "not open"
	case cbgo.StreamStatusOpening:
		return "opening"
	case cbgo.StreamStatusOpen:
		return "open"
	case cbgo.StreamStatusReading:
		return "reading"
	case cbgo.StreamStatusWriting:
		return "writing"
	case cbgo.StreamStatusAtEnd:
		return "at end"
	case cbgo.StreamStatusClosed:
		return "closed"
	case cbgo.StreamStatusError:
		return "failed"
	}
	return fmt.Sprintf("status %d", int(s))
}

// managerState is the central manager's state.
type managerState cbgo.ManagerState

// settled reports whether the state is one a Dial stops waiting in, and the
// error it fails with there. Unknown and resetting are transient.
func (s managerState) settled() (bool, error) {
	switch cbgo.ManagerState(s) {
	case cbgo.ManagerStatePoweredOn:
		return true, nil
	case cbgo.ManagerStatePoweredOff:
		return true, fmt.Errorf("bluetooth: %w", ErrBluetoothOff)
	case cbgo.ManagerStateUnauthorized:
		return true, fmt.Errorf("bluetooth: %w; allow it in System Settings, Privacy & Security, Bluetooth, unless device management forbids it", ErrBluetoothNotAuthorised)
	case cbgo.ManagerStateUnsupported:
		return true, fmt.Errorf("bluetooth: %w", ErrBluetoothUnsupported)
	}
	return false, nil
}

func (s managerState) String() string {
	switch cbgo.ManagerState(s) {
	case cbgo.ManagerStateUnknown:
		return "unknown"
	case cbgo.ManagerStateResetting:
		return "resetting"
	case cbgo.ManagerStateUnsupported:
		return "unsupported"
	case cbgo.ManagerStateUnauthorized:
		return "unauthorised"
	case cbgo.ManagerStatePoweredOff:
		return "powered off"
	case cbgo.ManagerStatePoweredOn:
		return "powered on"
	}
	return fmt.Sprintf("state %d", int(s))
}

// coreBluetoothError is an error CoreBluetooth reported, written with its
// domain and code, which say more than its message.
type coreBluetoothError struct {
	ns *cbgo.NSError
}

// newCoreBluetoothError returns err, written with its domain and code when it
// is an NSError; nil stays nil.
func newCoreBluetoothError(err error) error {
	var ns *cbgo.NSError
	if errors.As(err, &ns) {
		return coreBluetoothError{ns}
	}
	return err
}

func (e coreBluetoothError) Error() string {
	return fmt.Sprintf("%s (%s %d)", e.ns.Message(), e.ns.Domain(), e.ns.Code())
}

func (e coreBluetoothError) Unwrap() error { return e.ns }
