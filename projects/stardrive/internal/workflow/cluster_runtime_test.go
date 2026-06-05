package workflow

import (
	"slices"
	"strings"
	"testing"
)

func TestTalosCiliumInstallFlagsMatchTalosRequirements(t *testing.T) {
	t.Parallel()

	flags := talosCiliumInstallFlags()
	expected := []string{
		"ipam.mode=kubernetes",
		"kubeProxyReplacement=true",
		"securityContext.capabilities.ciliumAgent={CHOWN,KILL,NET_ADMIN,NET_RAW,IPC_LOCK,SYS_ADMIN,SYS_RESOURCE,DAC_OVERRIDE,FOWNER,SETGID,SETUID}",
		"securityContext.capabilities.cleanCiliumState={NET_ADMIN,SYS_ADMIN,SYS_RESOURCE}",
		"cgroup.autoMount.enabled=false",
		"cgroup.hostRoot=/sys/fs/cgroup",
		"k8sServiceHost=localhost",
		"k8sServicePort=7445",
		"gatewayAPI.enabled=true",
		"gatewayAPI.enableAlpn=true",
		"gatewayAPI.enableAppProtocol=true",
		"gatewayAPI.hostNetwork.enabled=true",
		"envoy.enabled=true",
		"envoy.securityContext.capabilities.keepCapNetBindService=true",
		"envoy.securityContext.capabilities.envoy={NET_ADMIN,SYS_ADMIN,NET_BIND_SERVICE}",
	}
	for _, want := range expected {
		if !slices.Contains(flags, want) {
			t.Fatalf("expected Cilium install flags to contain %q, got %v", want, flags)
		}
	}
}

func TestGatewayAPICRDVersionIsPinned(t *testing.T) {
	t.Parallel()

	if gatewayAPIVersion != "v1.4.1" {
		t.Fatalf("expected pinned Gateway API version v1.4.1, got %q", gatewayAPIVersion)
	}
}

func TestFluxOCIBootstrapManifestStagesDependentKustomizations(t *testing.T) {
	t.Parallel()

	app := &App{}
	cfg := workflowTestConfig(3)

	manifest := string(app.fluxOCIBootstrapManifest(cfg))
	for _, needle := range []string{
		`path: "./core/external-secrets"`,
		`path: "./core/cert-manager"`,
		`path: "./core/cert-manager-issuer"`,
		`path: "./core/cluster-secrets"`,
		`path: "./core/public-edge"`,
		`path: "./core/cloudflare-tunnel-ingress-controller"`,
		`path: "./apps"`,
		`- name: stardrive`,
		`- name: stardrive-cert-manager`,
		`- name: stardrive-cert-manager-issuer`,
		`- name: stardrive-public-edge`,
		`- name: stardrive-cloudflare-tunnel`,
	} {
		if !strings.Contains(manifest, needle) {
			t.Fatalf("expected flux bootstrap manifest to contain %q, got:\n%s", needle, manifest)
		}
	}
}

func TestPublicEdgeProbeHostnameUsesConcreteWildcardHost(t *testing.T) {
	t.Parallel()

	cfg := workflowTestConfig(3)

	if got := publicEdgeProbeHostname(cfg); got != "stardrive-probe.example.com" {
		t.Fatalf("expected public edge probe hostname to use wildcard base domain, got %q", got)
	}
}
