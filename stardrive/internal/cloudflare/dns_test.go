package cloudflare

import "testing"

func TestIsZoneID(t *testing.T) {
	if !isZoneID("cd5aa63e949cca2558dc73daa657759e") {
		t.Fatalf("expected Cloudflare zone ID to be detected")
	}
	if isZoneID("example.com") {
		t.Fatalf("did not expect zone name to be treated as zone ID")
	}
	if isZoneID("6cdf5968-f9fe-4192-97c2-f349e813c5e8") {
		t.Fatalf("did not expect UUID with dashes to be treated as Cloudflare zone ID")
	}
}
