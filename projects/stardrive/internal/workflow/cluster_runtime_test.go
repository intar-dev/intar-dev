package workflow

import (
	"slices"
	"strings"
	"testing"

	"github.com/intar-dev/stardrive/internal/talos"
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
		t.Fatalf("expected Gateway API version v1.4.1 for Cilium 1.19 compatibility, got %q", gatewayAPIVersion)
	}
}

func TestGatewayAPICRDInstallIncludesCiliumTLSRouteVersion(t *testing.T) {
	t.Parallel()

	urls := gatewayAPICRDURLs()
	if len(urls) != 2 {
		t.Fatalf("expected standard Gateway API bundle plus TLSRoute CRD, got %v", urls)
	}
	if !strings.Contains(urls[0], "/"+gatewayAPIVersion+"/standard-install.yaml") {
		t.Fatalf("expected standard Gateway API install URL for %s, got %q", gatewayAPIVersion, urls[0])
	}
	if !strings.Contains(urls[1], "/"+gatewayAPIVersion+"/config/crd/experimental/gateway.networking.k8s.io_tlsroutes.yaml") {
		t.Fatalf("expected experimental TLSRoute CRD URL for %s, got %q", gatewayAPIVersion, urls[1])
	}

	crds := gatewayAPICRDNames()
	if !slices.Contains(crds, "tlsroutes.gateway.networking.k8s.io") {
		t.Fatalf("expected Gateway API CRD wait list to contain TLSRoute, got %v", crds)
	}
	if slices.Contains(crds, "listenersets.gateway.networking.k8s.io") {
		t.Fatalf("Gateway API %s should not wait for ListenerSet, got %v", gatewayAPIVersion, crds)
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

func TestTalosBootImageIdentityTracksKubernetesBundle(t *testing.T) {
	t.Parallel()

	cfg := workflowTestConfig(3)
	cfg.Cluster.KubernetesVersion = "1.36.1"
	first := talosImageIdentity(cfg)

	cfg.Cluster.KubernetesVersion = "1.35.3"
	second := talosImageIdentity(cfg)

	if first == second {
		t.Fatalf("expected Talos image identity to change when Kubernetes version changes")
	}
	source := talosBootImageSource(cfg)
	if !strings.HasPrefix(source, "image-cache:"+talosHCloudCachedAsset+":") {
		t.Fatalf("unexpected Talos boot image source %q", source)
	}
	if strings.Contains(source, "/") {
		t.Fatalf("Talos boot image source should not leak local paths: %q", source)
	}
}

func TestTalosBootImageIdentityTracksSMBDriverVersion(t *testing.T) {
	t.Parallel()

	cfg := workflowTestConfig(3)
	cfg.Storage.SMBDriverVersion = "v1.20.1"
	first := talosImageIdentity(cfg)

	cfg.Storage.SMBDriverVersion = "v1.20.2"
	second := talosImageIdentity(cfg)

	if first == second {
		t.Fatalf("expected Talos image identity to change when SMB CSI driver version changes")
	}
}

func TestTalosKubernetesBundleVersionAddsVPrefix(t *testing.T) {
	t.Parallel()

	if got := talosKubernetesBundleVersion("1.36.1"); got != "v1.36.1" {
		t.Fatalf("expected v-prefixed Kubernetes version, got %q", got)
	}
	if got := talosKubernetesBundleVersion("v1.36.1"); got != "v1.36.1" {
		t.Fatalf("expected existing v-prefixed Kubernetes version to be preserved, got %q", got)
	}
}

func TestImageReferencesFromYAMLExtractsContainerImages(t *testing.T) {
	t.Parallel()

	images, err := imageReferencesFromYAML([]byte(`apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: smb
          image: registry.k8s.io/sig-storage/smbplugin:v1.20.1
        - name: liveness
          image: registry.k8s.io/sig-storage/livenessprobe:v2.18.0
---
apiVersion: apps/v1
kind: DaemonSet
spec:
  template:
    spec:
      containers:
        - name: smb
          image: registry.k8s.io/sig-storage/smbplugin:v1.20.1
`))
	if err != nil {
		t.Fatalf("extract image references: %v", err)
	}
	expected := []string{
		"registry.k8s.io/sig-storage/livenessprobe:v2.18.0",
		"registry.k8s.io/sig-storage/smbplugin:v1.20.1",
	}
	if !slices.Equal(images, expected) {
		t.Fatalf("unexpected image references: %#v", images)
	}
}

func TestImageListBytesSortsAndDeduplicatesImages(t *testing.T) {
	t.Parallel()

	got := string(imageListBytes([]string{
		"registry.k8s.io/sig-storage/smbplugin:v1.20.1",
		"",
		" registry.k8s.io/pause:3.10.1 ",
		"registry.k8s.io/sig-storage/smbplugin:v1.20.1",
	}))
	expected := "registry.k8s.io/pause:3.10.1\nregistry.k8s.io/sig-storage/smbplugin:v1.20.1\n"
	if got != expected {
		t.Fatalf("unexpected image list:\n%s", got)
	}
}

func TestUsesDefaultTalosSchematic(t *testing.T) {
	t.Parallel()

	cfg := workflowTestConfig(3)
	cfg.Cluster.TalosSchematic = ""
	if !usesDefaultTalosSchematic(cfg) {
		t.Fatal("expected blank Talos schematic to use default")
	}
	cfg.Cluster.TalosSchematic = talos.DefaultFactorySchematic
	if !usesDefaultTalosSchematic(cfg) {
		t.Fatal("expected default Talos schematic id to be accepted")
	}
	cfg.Cluster.TalosSchematic = "custom"
	if usesDefaultTalosSchematic(cfg) {
		t.Fatal("expected custom Talos schematic to be rejected by cached-image path")
	}
}
