package protocol

import "testing"

// Every outbound word must have a constructor case pinning the bytes it puts on
// the wire. The reverse — a case whose frame no registry entry claims — is
// TestOutboundFrames_AreRegistered; together they make the outbound vocabulary a
// bijection, so a frame cannot be registered without its JSON being pinned, nor
// pinned without being registered.
func TestOutboundFrames_EveryRegisteredFrameHasAPinnedShape(t *testing.T) {
	pinned := map[string]bool{}
	for _, tc := range outboundWireCases() {
		frameType, _ := asObject(t, tc.frame)["type"].(string)
		pinned[frameType] = true
	}
	for _, entry := range NewRegistry().Frames() {
		if entry.Direction != Outbound {
			continue
		}
		if !pinned[entry.Type] {
			t.Errorf("%s frame %q is registered outbound but no wire case pins its JSON",
				entry.Channel, entry.Type)
		}
	}
}
