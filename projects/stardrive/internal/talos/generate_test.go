package talos

import (
	"context"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestGenerateConfigUsesSeparateTalosEndpoints(t *testing.T) {
	secretsYAML, err := GenerateSecretsYAML(context.Background())
	if err != nil {
		t.Fatalf("GenerateSecretsYAML() error = %v", err)
	}

	result, err := GenerateConfig(context.Background(), GenConfigParams{
		ClusterName:        "intar",
		Endpoint:           "cluster.intar.app",
		TalosEndpoints:     []string{"49.13.128.157", "49.13.142.173"},
		TalosVersion:       "v1.12.6",
		KubernetesVersion:  "1.35.3",
		SecretsYAML:        secretsYAML,
		ControlPlaneTaints: false,
	})
	if err != nil {
		t.Fatalf("GenerateConfig() error = %v", err)
	}

	configText := string(result.Talosconfig)
	if !strings.Contains(configText, "- 49.13.128.157") || !strings.Contains(configText, "- 49.13.142.173") {
		t.Fatalf("talosconfig endpoints not rendered as expected:\n%s", configText)
	}
	if strings.Contains(configText, "- cluster.intar.app") {
		t.Fatalf("talosconfig should not use Kubernetes endpoint as Talos endpoint:\n%s", configText)
	}
	assertProxyDisabled(t, result.ControlPlane, "control-plane")
	assertProxyDisabled(t, result.Worker, "worker")
}

func assertProxyDisabled(t *testing.T, configYAML []byte, kind string) {
	t.Helper()

	var document map[string]any
	if err := yaml.Unmarshal(configYAML, &document); err != nil {
		t.Fatalf("failed to decode %s config: %v", kind, err)
	}

	clusterMap, ok := document["cluster"].(map[string]any)
	if !ok {
		t.Fatalf("%s config is missing cluster section:\n%s", kind, configYAML)
	}
	proxyMap, ok := clusterMap["proxy"].(map[string]any)
	if !ok {
		t.Fatalf("%s config is missing cluster.proxy section:\n%s", kind, configYAML)
	}
	disabled, ok := proxyMap["disabled"].(bool)
	if !ok || !disabled {
		t.Fatalf("%s config should set cluster.proxy.disabled=true:\n%s", kind, configYAML)
	}
	if _, ok := proxyMap["image"]; ok {
		t.Fatalf("%s config should not keep kube-proxy image when proxy is disabled:\n%s", kind, configYAML)
	}
}
