package workflow

import (
	"testing"

	"github.com/intar-dev/stardrive/internal/config"
)

func TestBootstrapUniversalAuthCredentials(t *testing.T) {
	cfg := &config.Config{
		Infisical: config.InfisicalConfig{
			ClientID:     "client-id",
			ClientSecret: "client-secret",
		},
	}

	clientID, clientSecret, err := bootstrapUniversalAuthCredentials(cfg)
	if err != nil {
		t.Fatalf("bootstrapUniversalAuthCredentials() error = %v", err)
	}
	if clientID != "client-id" {
		t.Fatalf("clientID = %q, want %q", clientID, "client-id")
	}
	if clientSecret != "client-secret" {
		t.Fatalf("clientSecret = %q, want %q", clientSecret, "client-secret")
	}
}

func TestBootstrapSecretsUsesOperatorSharedPath(t *testing.T) {
	cfg := &config.Config{
		Cluster: config.ClusterConfig{Name: "intar"},
		Infisical: config.InfisicalConfig{
			PathRoot: "/stardrive",
		},
	}

	if got := cfg.Secrets().OperatorShared; got != "/stardrive/operator/shared" {
		t.Fatalf("cfg.Secrets().OperatorShared = %q, want %q", got, "/stardrive/operator/shared")
	}
}
