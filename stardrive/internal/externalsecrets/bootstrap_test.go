package externalsecrets

import "testing"

func TestDesiredClusterSecretStoreUsesUniversalAuthCredentialsSchema(t *testing.T) {
	params := BootstrapUniversalAuthParams{
		ControllerNamespace: "external-secrets",
		StoreName:           "infisical",
		AuthSecretName:      "infisical-universal-auth",
		HostAPI:             "https://eu.infisical.com",
		ProjectSlug:         "my-project",
		EnvironmentSlug:     "prod",
		SecretsPath:         "/",
	}

	store := desiredClusterSecretStore(params)
	spec := store.Object["spec"].(map[string]any)
	provider := spec["provider"].(map[string]any)
	infisical := provider["infisical"].(map[string]any)
	auth := infisical["auth"].(map[string]any)
	ua := auth["universalAuthCredentials"].(map[string]any)

	clientID := ua["clientId"].(map[string]any)
	if clientID["name"] != "infisical-universal-auth" || clientID["namespace"] != "external-secrets" || clientID["key"] != "clientId" {
		t.Fatalf("unexpected clientId ref: %#v", clientID)
	}

	clientSecret := ua["clientSecret"].(map[string]any)
	if clientSecret["name"] != "infisical-universal-auth" || clientSecret["namespace"] != "external-secrets" || clientSecret["key"] != "clientSecret" {
		t.Fatalf("unexpected clientSecret ref: %#v", clientSecret)
	}

	if infisical["hostAPI"] != "https://eu.infisical.com" {
		t.Fatalf("unexpected hostAPI: %#v", infisical["hostAPI"])
	}
}

func TestNormalizeHostAPIRemovesTrailingAPIPath(t *testing.T) {
	if got := normalizeHostAPI("https://eu.infisical.com/api"); got != "https://eu.infisical.com" {
		t.Fatalf("normalizeHostAPI() = %q, want %q", got, "https://eu.infisical.com")
	}
}
