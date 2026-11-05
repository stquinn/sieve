//go:build linux

package radio

import "testing"

func TestParseHardwareAddress(t *testing.T) {
	tests := []struct {
		name    string
		text    string
		want    hardwareAddress
		wantErr bool
	}{
		{"upper case", "AA:BB:CC:DD:EE:FF", hardwareAddress{0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff}, false},
		{"lower case", "01:02:03:0a:0b:0c", hardwareAddress{1, 2, 3, 0x0a, 0x0b, 0x0c}, false},
		{"too few parts", "AA:BB:CC:DD:EE", hardwareAddress{}, true},
		{"too many parts", "AA:BB:CC:DD:EE:FF:00", hardwareAddress{}, true},
		{"not hex", "AA:BB:CC:DD:EE:GG", hardwareAddress{}, true},
		{"short part", "A:BB:CC:DD:EE:FF", hardwareAddress{}, true},
		{"empty", "", hardwareAddress{}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseHardwareAddress(tt.text)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err %v, wantErr %v", err, tt.wantErr)
			}
			if !tt.wantErr && got != tt.want {
				t.Errorf("got %v, want %v", got, tt.want)
			}
		})
	}
}
