package talos

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"time"

	talosconfig "github.com/siderolabs/talos/pkg/machinery/config"
	talosgenerate "github.com/siderolabs/talos/pkg/machinery/config/generate"
	talossecrets "github.com/siderolabs/talos/pkg/machinery/config/generate/secrets"
	"github.com/siderolabs/talos/pkg/machinery/config/machine"
	v1alpha1 "github.com/siderolabs/talos/pkg/machinery/config/types/v1alpha1"
	talosconstants "github.com/siderolabs/talos/pkg/machinery/constants"
	"gopkg.in/yaml.v3"
)

const (
	kubernetesRegistryHost = "registry.k8s.io"
)

type GenConfigResult struct {
	ControlPlane []byte
	Worker       []byte
	Talosconfig  []byte
}

type GenConfigParams struct {
	ClusterName                 string
	Endpoint                    string
	TalosEndpoints              []string
	TalosVersion                string
	TalosSchematic              string
	KubernetesVersion           string
	InstallDisk                 string
	ControlPlaneTaints          bool
	KubernetesAPIServerCertSANs []string
	KubernetesRegistryMirrors   []string
	SecretsYAML                 []byte
}

func GenerateSecretsYAML(ctx context.Context) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	bundle, err := talossecrets.NewBundle(talossecrets.NewFixedClock(time.Now().UTC()), talosconfig.TalosVersionCurrent)
	if err != nil {
		return nil, fmt.Errorf("generate talos secrets bundle: %w", err)
	}
	data, err := yaml.Marshal(bundle)
	if err != nil {
		return nil, fmt.Errorf("marshal talos secrets: %w", err)
	}
	return data, nil
}

func GenerateConfig(ctx context.Context, params GenConfigParams) (*GenConfigResult, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if strings.TrimSpace(params.ClusterName) == "" {
		return nil, fmt.Errorf("cluster name is required")
	}
	if strings.TrimSpace(params.Endpoint) == "" {
		return nil, fmt.Errorf("endpoint is required")
	}
	if len(params.SecretsYAML) == 0 {
		return nil, fmt.Errorf("secrets YAML is required")
	}

	secretsBundle := &talossecrets.Bundle{}
	if err := yaml.Unmarshal(params.SecretsYAML, secretsBundle); err != nil {
		return nil, fmt.Errorf("decode secrets YAML: %w", err)
	}
	if secretsBundle.Clock == nil {
		secretsBundle.Clock = talossecrets.NewClock()
	}

	versionContract := talosconfig.TalosVersionCurrent
	if version := strings.TrimSpace(params.TalosVersion); version != "" {
		parsed, err := talosconfig.ParseContractFromVersion(version)
		if err != nil {
			return nil, fmt.Errorf("parse Talos version %q: %w", version, err)
		}
		versionContract = parsed
	}

	kubernetesVersion := strings.TrimPrefix(strings.TrimSpace(params.KubernetesVersion), "v")
	if kubernetesVersion == "" {
		kubernetesVersion = talosconstants.DefaultKubernetesVersion
	}

	_, talosEndpoint, err := normalizeTalosEndpoint(params.Endpoint)
	if err != nil {
		return nil, err
	}
	talosEndpoints := []string{talosEndpoint}
	if endpoints := trimStringSlice(params.TalosEndpoints); len(endpoints) > 0 {
		talosEndpoints = endpoints
	}

	opts := []talosgenerate.Option{
		talosgenerate.WithVersionContract(versionContract),
		talosgenerate.WithSecretsBundle(secretsBundle),
		talosgenerate.WithEndpointList(talosEndpoints),
		talosgenerate.WithClusterCNIConfig(&v1alpha1.CNIConfig{CNIName: "none"}),
		talosgenerate.WithAllowSchedulingOnControlPlanes(!params.ControlPlaneTaints),
		talosgenerate.WithInstallDisk(defaultIfEmpty(params.InstallDisk, defaultOSDisk)),
	}
	if installerImage := buildInstallerImage(params.TalosVersion, params.TalosSchematic); installerImage != "" {
		opts = append(opts, talosgenerate.WithInstallImage(installerImage))
	}
	if len(params.KubernetesAPIServerCertSANs) > 0 {
		opts = append(opts, talosgenerate.WithAdditionalSubjectAltNames(params.KubernetesAPIServerCertSANs))
	}

	input, err := talosgenerate.NewInput(
		strings.TrimSpace(params.ClusterName),
		normalizeClusterEndpoint(params.Endpoint),
		kubernetesVersion,
		opts...,
	)
	if err != nil {
		return nil, fmt.Errorf("generate talos input: %w", err)
	}

	controlPlaneConfig, err := input.Config(machine.TypeControlPlane)
	if err != nil {
		return nil, fmt.Errorf("generate control-plane config: %w", err)
	}
	controlPlane, err := controlPlaneConfig.Bytes()
	if err != nil {
		return nil, fmt.Errorf("encode control-plane config: %w", err)
	}
	controlPlane, err = disableKubeProxy(controlPlane)
	if err != nil {
		return nil, fmt.Errorf("disable kube-proxy in control-plane config: %w", err)
	}
	controlPlane, err = injectKubernetesRegistryMirror(controlPlane, params.KubernetesRegistryMirrors)
	if err != nil {
		return nil, fmt.Errorf("inject Kubernetes registry mirror in control-plane config: %w", err)
	}
	controlPlane, err = enableImageCache(controlPlane)
	if err != nil {
		return nil, fmt.Errorf("enable image cache in control-plane config: %w", err)
	}

	workerConfig, err := input.Config(machine.TypeWorker)
	if err != nil {
		return nil, fmt.Errorf("generate worker config: %w", err)
	}
	worker, err := workerConfig.Bytes()
	if err != nil {
		return nil, fmt.Errorf("encode worker config: %w", err)
	}
	worker, err = disableKubeProxy(worker)
	if err != nil {
		return nil, fmt.Errorf("disable kube-proxy in worker config: %w", err)
	}
	worker, err = injectKubernetesRegistryMirror(worker, params.KubernetesRegistryMirrors)
	if err != nil {
		return nil, fmt.Errorf("inject Kubernetes registry mirror in worker config: %w", err)
	}
	worker, err = enableImageCache(worker)
	if err != nil {
		return nil, fmt.Errorf("enable image cache in worker config: %w", err)
	}

	clientConfig, err := input.Talosconfig()
	if err != nil {
		return nil, fmt.Errorf("generate talosconfig: %w", err)
	}
	talosconfigBytes, err := clientConfig.Bytes()
	if err != nil {
		return nil, fmt.Errorf("encode talosconfig: %w", err)
	}

	return &GenConfigResult{
		ControlPlane: controlPlane,
		Worker:       worker,
		Talosconfig:  talosconfigBytes,
	}, nil
}

func disableKubeProxy(configYAML []byte) ([]byte, error) {
	var document map[string]any
	if err := yaml.Unmarshal(configYAML, &document); err != nil {
		return nil, fmt.Errorf("decode generated config: %w", err)
	}

	clusterMap := nestedStringMap(document, "cluster")
	clusterMap["proxy"] = map[string]any{
		"disabled": true,
	}

	data, err := yaml.Marshal(document)
	if err != nil {
		return nil, fmt.Errorf("encode generated config: %w", err)
	}

	return data, nil
}

func injectKubernetesRegistryMirror(configYAML []byte, endpoints []string) ([]byte, error) {
	endpoints = trimStringSlice(endpoints)
	if len(endpoints) == 0 {
		return configYAML, nil
	}

	var document map[string]any
	if err := yaml.Unmarshal(configYAML, &document); err != nil {
		return nil, fmt.Errorf("decode generated config: %w", err)
	}

	machineMap := nestedStringMap(document, "machine")
	registriesMap := nestedStringMap(machineMap, "registries")
	mirrorsMap := nestedStringMap(registriesMap, "mirrors")
	registryMirror := map[string]any{
		"endpoints": append([]string(nil), endpoints...),
	}
	if registryMirrorNeedsOverridePath(endpoints) {
		registryMirror["overridePath"] = true
	}
	if !registryMirrorUsesDefaultEndpoint(endpoints) {
		registryMirror["skipFallback"] = true
	}
	mirrorsMap[kubernetesRegistryHost] = registryMirror

	data, err := yaml.Marshal(document)
	if err != nil {
		return nil, fmt.Errorf("encode generated config: %w", err)
	}

	return data, nil
}

func enableImageCache(configYAML []byte) ([]byte, error) {
	var document map[string]any
	if err := yaml.Unmarshal(configYAML, &document); err != nil {
		return nil, fmt.Errorf("decode generated config: %w", err)
	}

	machineMap := nestedStringMap(document, "machine")
	featuresMap := nestedStringMap(machineMap, "features")
	imageCacheMap := nestedStringMap(featuresMap, "imageCache")
	imageCacheMap["localEnabled"] = true

	data, err := yaml.Marshal(document)
	if err != nil {
		return nil, fmt.Errorf("encode generated config: %w", err)
	}

	return data, nil
}

func registryMirrorNeedsOverridePath(endpoints []string) bool {
	for _, endpoint := range endpoints {
		parsed, err := url.Parse(strings.TrimSpace(endpoint))
		if err != nil {
			continue
		}
		if strings.Trim(parsed.EscapedPath(), "/") != "" {
			return true
		}
	}
	return false
}

func registryMirrorUsesDefaultEndpoint(endpoints []string) bool {
	if len(endpoints) != 1 {
		return false
	}
	parsed, err := url.Parse(strings.TrimSpace(endpoints[0]))
	if err != nil {
		return false
	}
	return parsed.Scheme == "https" && parsed.Host == kubernetesRegistryHost && strings.Trim(parsed.EscapedPath(), "/") == ""
}

func nestedStringMap(parent map[string]any, key string) map[string]any {
	if parent == nil {
		parent = map[string]any{}
	}
	if value, ok := parent[key]; ok {
		if existing, ok := value.(map[string]any); ok {
			return existing
		}
	}

	child := map[string]any{}
	parent[key] = child

	return child
}

func buildInstallerImage(talosVersion, talosSchematic string) string {
	installerImage, err := BuildInstallerImageRef(talosVersion, talosSchematic)
	if err != nil {
		return ""
	}
	return installerImage
}

func defaultIfEmpty(value, fallback string) string {
	value = strings.TrimSpace(value)
	if value != "" {
		return value
	}
	return strings.TrimSpace(fallback)
}

func trimStringSlice(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		out = append(out, value)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
