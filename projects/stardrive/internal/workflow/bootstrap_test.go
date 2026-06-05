package workflow

import (
	"strings"
	"testing"
	"unicode"
)

func TestGenerateStorageBoxPasswordMeetsPolicy(t *testing.T) {
	password := generateStorageBoxPassword()
	if len(password) < 12 {
		t.Fatalf("password too short: %d", len(password))
	}

	var hasUpper bool
	var hasLower bool
	var hasDigit bool
	var hasSpecial bool
	for _, r := range password {
		switch {
		case unicode.IsUpper(r):
			hasUpper = true
		case unicode.IsLower(r):
			hasLower = true
		case unicode.IsDigit(r):
			hasDigit = true
		case strings.ContainsRune("!@#$%^&*()-_=+[]{}:,.?", r):
			hasSpecial = true
		}
	}

	if !hasUpper || !hasLower || !hasDigit || !hasSpecial {
		t.Fatalf("password does not meet complexity policy: %q", password)
	}
}

func TestInfraSecretsFromValuesReadsCloudflareTunnelEnv(t *testing.T) {
	t.Setenv(secretHetznerToken, "hcloud-token")
	t.Setenv(secretCloudflareAPIToken, "cloudflare-token")
	t.Setenv(secretCloudflareAccountID, "cloudflare-account")
	t.Setenv(secretCloudflareTunnelName, "stardrive-tunnel")

	secrets := infraSecretsFromValues(nil)

	if secrets.Hetzner.Token != "hcloud-token" {
		t.Fatalf("expected Hetzner token from env, got %q", secrets.Hetzner.Token)
	}
	if secrets.CloudflareToken != "cloudflare-token" {
		t.Fatalf("expected Cloudflare token from env, got %q", secrets.CloudflareToken)
	}
	if secrets.CloudflareAccountID != "cloudflare-account" {
		t.Fatalf("expected Cloudflare account ID from env, got %q", secrets.CloudflareAccountID)
	}
	if secrets.CloudflareTunnelName != "stardrive-tunnel" {
		t.Fatalf("expected Cloudflare tunnel name from env, got %q", secrets.CloudflareTunnelName)
	}
}

func TestInfraSecretsFromValuesPrefersStoredValues(t *testing.T) {
	t.Setenv(secretCloudflareAccountID, "env-account")
	t.Setenv(secretCloudflareTunnelName, "env-tunnel")

	secrets := infraSecretsFromValues(map[string]string{
		secretCloudflareAccountID:  "stored-account",
		secretCloudflareTunnelName: "stored-tunnel",
	})

	if secrets.CloudflareAccountID != "stored-account" {
		t.Fatalf("expected stored Cloudflare account ID, got %q", secrets.CloudflareAccountID)
	}
	if secrets.CloudflareTunnelName != "stored-tunnel" {
		t.Fatalf("expected stored Cloudflare tunnel name, got %q", secrets.CloudflareTunnelName)
	}
}
