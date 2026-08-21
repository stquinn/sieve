package nativedrop

import (
	"testing"
	"time"
)

func TestBucket_TakeAfterPut(t *testing.T) {
	b := NewBucket()
	b.Put([]string{"/a.png", "/b.pdf"})
	got := b.TakeDrop(10 * time.Millisecond)
	if len(got) != 2 || got[0] != "/a.png" {
		t.Fatalf("TakeDrop = %v", got)
	}
}

func TestBucket_SingleUse(t *testing.T) {
	b := NewBucket()
	b.Put([]string{"/a.png"})
	b.TakeDrop(time.Millisecond)
	if got := b.TakeDrop(time.Millisecond); got != nil {
		t.Fatalf("second take = %v, want nil", got)
	}
}

func TestBucket_TakeWaitsForPut(t *testing.T) {
	b := NewBucket()
	go func() {
		time.Sleep(20 * time.Millisecond)
		b.Put([]string{"/late.png"})
	}()
	got := b.TakeDrop(500 * time.Millisecond)
	if len(got) != 1 || got[0] != "/late.png" {
		t.Fatalf("TakeDrop = %v, want the late drop", got)
	}
}

func TestBucket_EmptyTimesOut(t *testing.T) {
	b := NewBucket()
	start := time.Now()
	if got := b.TakeDrop(30 * time.Millisecond); got != nil {
		t.Fatalf("TakeDrop = %v, want nil", got)
	}
	if time.Since(start) < 25*time.Millisecond {
		t.Fatal("must have waited out maxWait")
	}
}
