package talos

import (
	"context"
	"testing"

	"google.golang.org/grpc/metadata"
)

func TestTargetContextScopesRequestsToNode(t *testing.T) {
	t.Parallel()

	client := &Client{targetNode: "10.42.0.10"}
	ctx := client.targetContext(context.Background())

	md, ok := metadata.FromOutgoingContext(ctx)
	if !ok {
		t.Fatal("expected outgoing metadata")
	}
	if got := md.Get("node"); len(got) != 1 || got[0] != "10.42.0.10" {
		t.Fatalf("expected node metadata for target node, got %#v", got)
	}
	if got := md.Get("nodes"); len(got) != 0 {
		t.Fatalf("expected nodes metadata to be unset, got %#v", got)
	}
}
