package workflow

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/intar-dev/stardrive/internal/config"
	"github.com/intar-dev/stardrive/internal/fs"
	"github.com/intar-dev/stardrive/internal/operation"
	"github.com/intar-dev/stardrive/internal/talos"
	"gopkg.in/yaml.v3"
)

const (
	fluxNamespace                         = "flux-system"
	fluxOCIRepositoryName                 = "stardrive"
	fluxKustomizationName                 = "stardrive"
	fluxCertManagerKustomizationName      = "stardrive-cert-manager"
	fluxIssuerKustomizationName           = "stardrive-cert-manager-issuer"
	fluxPublicEdgeKustomizationName       = "stardrive-public-edge"
	fluxClusterSecretsKustomizationName   = "stardrive-cluster-secrets"
	fluxCloudflareTunnelKustomizationName = "stardrive-cloudflare-tunnel"
	fluxAppsKustomizationName             = "stardrive-apps"
	defaultCiliumCLIVersion               = "v0.19.2"
	defaultORASCLIVersion                 = "v1.3.0"
)

type clusterAccessSecrets struct {
	TalosSecretsYAML       []byte
	ControlPlaneConfigYAML []byte
	WorkerConfigYAML       []byte
	TalosconfigYAML        []byte
	KubeconfigYAML         []byte
}

func (a *App) runPhase(op *operation.Operation, phase string, fn func() (any, error)) error {
	if op.ResumePhase() != phase {
		return nil
	}
	startedAt := time.Now()
	a.logInfo("phase started",
		"operation", op.ID,
		"type", string(op.Type),
		"cluster", op.Cluster,
		"phase", phase,
	)
	if err := op.StartPhase(phase); err != nil {
		return err
	}
	if err := a.store.Save(op); err != nil {
		return err
	}
	data, err := fn()
	if err != nil {
		a.logError("phase failed",
			"operation", op.ID,
			"type", string(op.Type),
			"cluster", op.Cluster,
			"phase", phase,
			"duration", time.Since(startedAt).String(),
			"error", err,
		)
		_ = op.FailPhase(phase, err)
		_ = a.store.Save(op)
		return err
	}
	if err := op.CompletePhase(phase, data); err != nil {
		return err
	}
	a.logInfo("phase completed",
		"operation", op.ID,
		"type", string(op.Type),
		"cluster", op.Cluster,
		"phase", phase,
		"duration", time.Since(startedAt).String(),
	)
	return a.store.Save(op)
}

func (a *App) ensureBinary(name string) (string, error) {
	path, err := exec.LookPath(strings.TrimSpace(name))
	if err != nil {
		return "", fmt.Errorf("required binary %q not found in PATH", name)
	}
	a.logDebug("resolved binary", "name", name, "path", path)
	return path, nil
}

func (a *App) runCommand(ctx context.Context, env map[string]string, input []byte, name string, args ...string) error {
	startedAt := time.Now()
	a.logDebug("running command",
		"command", formatCommand(name, args...),
		"env_keys", envKeys(env),
		"stdin_bytes", len(input),
	)
	cmd := exec.CommandContext(ctx, name, args...)
	var stdoutBuf bytes.Buffer
	var stderrBuf bytes.Buffer
	cmd.Stdout = io.MultiWriter(a.opts.Stdout, &stdoutBuf)
	cmd.Stderr = io.MultiWriter(a.opts.Stderr, &stderrBuf)
	cmd.Env = withEnv(os.Environ(), env)
	if len(input) > 0 {
		cmd.Stdin = bytes.NewReader(input)
	}
	if err := cmd.Run(); err != nil {
		detail := commandOutputTail(stderrBuf.Bytes())
		if detail == "" {
			detail = commandOutputTail(stdoutBuf.Bytes())
		}
		wrapped := fmt.Errorf("run %s: %w", formatCommand(name, args...), err)
		if detail != "" {
			wrapped = fmt.Errorf("%w: %s", wrapped, detail)
		}
		a.logError("command failed",
			"command", formatCommand(name, args...),
			"duration", time.Since(startedAt).String(),
			"error", wrapped,
		)
		return wrapped
	}
	a.logDebug("command completed",
		"command", formatCommand(name, args...),
		"duration", time.Since(startedAt).String(),
	)
	return nil
}

func commandOutputTail(data []byte) string {
	const limit = 8 * 1024
	data = bytes.TrimSpace(data)
	if len(data) == 0 {
		return ""
	}
	if len(data) > limit {
		data = data[len(data)-limit:]
	}
	return strings.TrimSpace(string(data))
}

func (a *App) captureCommand(ctx context.Context, env map[string]string, input []byte, name string, args ...string) ([]byte, error) {
	startedAt := time.Now()
	a.logDebug("capturing command output",
		"command", formatCommand(name, args...),
		"env_keys", envKeys(env),
		"stdin_bytes", len(input),
	)
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stderr = a.opts.Stderr
	cmd.Env = withEnv(os.Environ(), env)
	if len(input) > 0 {
		cmd.Stdin = bytes.NewReader(input)
	}
	out, err := cmd.Output()
	if err != nil {
		wrapped := fmt.Errorf("capture %s: %w", formatCommand(name, args...), err)
		a.logError("command failed",
			"command", formatCommand(name, args...),
			"duration", time.Since(startedAt).String(),
			"error", wrapped,
		)
		return nil, wrapped
	}
	a.logDebug("captured command output",
		"command", formatCommand(name, args...),
		"duration", time.Since(startedAt).String(),
		"bytes", len(out),
	)
	return out, nil
}

func (a *App) probeCommand(ctx context.Context, env map[string]string, input []byte, name string, args ...string) ([]byte, error) {
	startedAt := time.Now()
	a.logDebug("probing command",
		"command", formatCommand(name, args...),
		"env_keys", envKeys(env),
		"stdin_bytes", len(input),
	)
	cmd := exec.CommandContext(ctx, name, args...)
	var stdoutBuf bytes.Buffer
	var stderrBuf bytes.Buffer
	cmd.Stdout = &stdoutBuf
	cmd.Stderr = &stderrBuf
	cmd.Env = withEnv(os.Environ(), env)
	if len(input) > 0 {
		cmd.Stdin = bytes.NewReader(input)
	}
	if err := cmd.Run(); err != nil {
		detail := commandOutputTail(stderrBuf.Bytes())
		if detail == "" {
			detail = commandOutputTail(stdoutBuf.Bytes())
		}
		a.logDebug("command probe failed",
			"command", formatCommand(name, args...),
			"duration", time.Since(startedAt).String(),
			"error", err,
			"detail", detail,
		)
		return nil, err
	}
	a.logDebug("command probe succeeded",
		"command", formatCommand(name, args...),
		"duration", time.Since(startedAt).String(),
	)
	return stdoutBuf.Bytes(), nil
}

func withEnv(base []string, extra map[string]string) []string {
	if len(extra) == 0 {
		return base
	}

	env := append([]string(nil), base...)
	for key, value := range extra {
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		prefix := key + "="
		replaced := false
		for i := range env {
			if strings.HasPrefix(env[i], prefix) {
				env[i] = prefix + value
				replaced = true
				break
			}
		}
		if !replaced {
			env = append(env, prefix+value)
		}
	}
	return env
}

func envKeys(extra map[string]string) []string {
	if len(extra) == 0 {
		return nil
	}
	keys := make([]string, 0, len(extra))
	for key := range extra {
		key = strings.TrimSpace(key)
		if key != "" {
			keys = append(keys, key)
		}
	}
	slices.Sort(keys)
	return keys
}

func formatCommand(name string, args ...string) string {
	parts := append([]string{strings.TrimSpace(name)}, args...)
	for i := range parts {
		part := strings.TrimSpace(parts[i])
		if part == "" {
			continue
		}
		if strings.ContainsAny(part, " \t\n\"'") {
			parts[i] = strconv.Quote(part)
			continue
		}
		parts[i] = part
	}
	return strings.Join(parts, " ")
}

func (a *App) writeTempFile(prefix string, data []byte, mode os.FileMode) (string, func(), error) {
	file, err := os.CreateTemp("", prefix)
	if err != nil {
		return "", nil, err
	}
	if _, err := file.Write(data); err != nil {
		file.Close()
		os.Remove(file.Name())
		return "", nil, err
	}
	if err := file.Chmod(mode); err != nil {
		file.Close()
		os.Remove(file.Name())
		return "", nil, err
	}
	if err := file.Close(); err != nil {
		os.Remove(file.Name())
		return "", nil, err
	}
	return file.Name(), func() { _ = os.Remove(file.Name()) }, nil
}

func (a *App) loadClusterAccessSecrets(ctx context.Context, cfg *config.Config) (clusterAccessSecrets, error) {
	client, err := a.infisicalClient(ctx, cfg)
	if err != nil {
		return clusterAccessSecrets{}, err
	}
	values, err := client.GetSecrets(ctx, cfg.Infisical.ProjectID, cfg.Infisical.Environment, cfg.Secrets().ClusterAccess)
	if err != nil {
		return clusterAccessSecrets{}, err
	}
	return clusterAccessSecrets{
		TalosSecretsYAML:       []byte(values[secretTalosSecretsYAML]),
		ControlPlaneConfigYAML: []byte(values[secretTalosControlPlaneYAML]),
		WorkerConfigYAML:       []byte(values[secretTalosWorkerYAML]),
		TalosconfigYAML:        []byte(values[secretTalosconfigYAML]),
		KubeconfigYAML:         []byte(values[secretKubeconfigYAML]),
	}, nil
}

func (a *App) ensureClusterAccessSecrets(ctx context.Context, cfg *config.Config, existing clusterAccessSecrets, requireKubeconfig bool) (clusterAccessSecrets, error) {
	return ensureClusterAccessSecrets(existing, requireKubeconfig, func() (clusterAccessSecrets, error) {
		a.logInfo("reloading cluster access secrets",
			"cluster", cfg.Cluster.Name,
			"require_kubeconfig", requireKubeconfig,
		)
		return a.loadClusterAccessSecrets(ctx, cfg)
	})
}

func ensureClusterAccessSecrets(existing clusterAccessSecrets, requireKubeconfig bool, loader func() (clusterAccessSecrets, error)) (clusterAccessSecrets, error) {
	hasTalosconfig := len(bytes.TrimSpace(existing.TalosconfigYAML)) > 0
	hasKubeconfig := len(bytes.TrimSpace(existing.KubeconfigYAML)) > 0
	if hasTalosconfig && (!requireKubeconfig || hasKubeconfig) {
		return existing, nil
	}

	loaded, err := loader()
	if err != nil {
		return clusterAccessSecrets{}, err
	}
	if len(bytes.TrimSpace(loaded.TalosconfigYAML)) == 0 {
		return clusterAccessSecrets{}, fmt.Errorf("talosconfig is missing")
	}
	if requireKubeconfig && len(bytes.TrimSpace(loaded.KubeconfigYAML)) == 0 {
		return clusterAccessSecrets{}, fmt.Errorf("kubeconfig is missing")
	}
	return loaded, nil
}

func (a *App) writeTempTalosconfig(secrets clusterAccessSecrets) (string, func(), error) {
	if len(bytes.TrimSpace(secrets.TalosconfigYAML)) == 0 {
		return "", nil, fmt.Errorf("talosconfig is missing")
	}
	return a.writeTempFile("stardrive-talosconfig-*.yaml", secrets.TalosconfigYAML, 0o600)
}

func (a *App) writeTempKubeconfig(secrets clusterAccessSecrets) (string, func(), error) {
	if len(bytes.TrimSpace(secrets.KubeconfigYAML)) == 0 {
		return "", nil, fmt.Errorf("kubeconfig is missing")
	}
	return a.writeTempFile("stardrive-kubeconfig-*.yaml", secrets.KubeconfigYAML, 0o600)
}

func (a *App) kubectlEnv(kubeconfigPath string) map[string]string {
	if strings.TrimSpace(kubeconfigPath) == "" {
		return nil
	}
	return map[string]string{"KUBECONFIG": kubeconfigPath}
}

func joinCSV(values []string) string {
	return strings.Join(uniqueNonEmpty(values), ",")
}

func uniqueNonEmpty(values []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func controlPlaneIPs(cfg *config.Config) []string {
	if cfg == nil {
		return nil
	}
	ips := make([]string, 0, len(cfg.Nodes))
	for _, node := range cfg.ControlPlaneNodes() {
		if node.PublicIPv4 != "" {
			ips = append(ips, node.PublicIPv4)
		}
	}
	return uniqueNonEmpty(ips)
}

func controlPlaneHealthIPs(cfg *config.Config) []string {
	if cfg == nil {
		return nil
	}
	ips := make([]string, 0, len(cfg.Nodes))
	for _, node := range cfg.ControlPlaneNodes() {
		switch {
		case node.PrivateIPv4 != "":
			ips = append(ips, node.PrivateIPv4)
		case node.PublicIPv4 != "":
			ips = append(ips, node.PublicIPv4)
		}
	}
	return uniqueNonEmpty(ips)
}

func firstControlPlaneIP(cfg *config.Config) string {
	ips := controlPlaneIPs(cfg)
	if len(ips) == 0 {
		return ""
	}
	return ips[0]
}

func (a *App) firstReachableControlPlaneIP(ctx context.Context, cfg *config.Config, talosconfig []byte) (string, error) {
	endpoints := controlPlaneIPs(cfg)
	if len(endpoints) == 0 {
		return "", fmt.Errorf("no control-plane public IPv4 addresses are available")
	}
	if len(bytes.TrimSpace(talosconfig)) == 0 {
		return "", fmt.Errorf("talosconfig is missing")
	}
	failures := make([]string, 0, len(endpoints))
	for _, endpoint := range endpoints {
		probeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		client, err := talos.NewClient(endpoint, talosconfig)
		if err != nil {
			cancel()
			failures = append(failures, fmt.Sprintf("%s: %v", endpoint, err))
			continue
		}
		_, err = client.Version(probeCtx)
		_ = client.Close()
		cancel()
		if err == nil {
			return endpoint, nil
		}
		failures = append(failures, fmt.Sprintf("%s: %v", endpoint, err))
	}
	return "", fmt.Errorf("no reachable control-plane Talos endpoint found: %s", strings.Join(failures, "; "))
}

func publicNodeIPs(cfg *config.Config) []string {
	if cfg == nil {
		return nil
	}
	ips := make([]string, 0, len(cfg.Nodes))
	for _, node := range cfg.Nodes {
		if ip := strings.TrimSpace(node.PublicIPv4); ip != "" {
			ips = append(ips, ip)
		}
	}
	return uniqueNonEmpty(ips)
}

func trimVersionPrefix(version string) string {
	return strings.TrimPrefix(strings.TrimSpace(version), "v")
}

func (a *App) ensureCiliumCLI(ctx context.Context) (string, error) {
	targetDir := filepath.Join(a.opts.Paths.StateDir, "bin")
	if err := fs.EnsureDir(targetDir, 0o755); err != nil {
		return "", err
	}

	version := defaultCiliumCLIVersion
	binaryPath := filepath.Join(targetDir, "cilium-"+version)
	if info, err := os.Stat(binaryPath); err == nil && !info.IsDir() {
		return binaryPath, nil
	}

	assetBase, err := ciliumCLIAssetBase()
	if err != nil {
		return "", err
	}
	tarballURL := fmt.Sprintf("https://github.com/cilium/cilium-cli/releases/download/%s/%s.tar.gz", version, assetBase)
	checksumURL := tarballURL + ".sha256sum"

	tarballPath := filepath.Join(targetDir, assetBase+".tar.gz")
	checksumPath := filepath.Join(targetDir, assetBase+".tar.gz.sha256sum")

	if err := downloadFile(ctx, tarballURL, tarballPath); err != nil {
		return "", err
	}
	if err := downloadFile(ctx, checksumURL, checksumPath); err != nil {
		return "", err
	}
	if err := verifySHA256File(tarballPath, checksumPath); err != nil {
		return "", err
	}
	if err := extractTarGzBinary(tarballPath, "cilium", binaryPath); err != nil {
		return "", err
	}
	return binaryPath, nil
}

func (a *App) ensureORASCLI(ctx context.Context) (string, error) {
	if path, err := exec.LookPath("oras"); err == nil {
		return path, nil
	}

	targetDir := filepath.Join(a.opts.Paths.StateDir, "bin")
	if err := fs.EnsureDir(targetDir, 0o755); err != nil {
		return "", err
	}

	version := defaultORASCLIVersion
	binaryPath := filepath.Join(targetDir, "oras-"+version)
	if info, err := os.Stat(binaryPath); err == nil && !info.IsDir() {
		return binaryPath, nil
	}

	assetBase, err := orasCLIAssetBase(version)
	if err != nil {
		return "", err
	}
	versionNoPrefix := strings.TrimPrefix(version, "v")
	tarballURL := fmt.Sprintf("https://github.com/oras-project/oras/releases/download/%s/%s.tar.gz", version, assetBase)
	checksumURL := fmt.Sprintf("https://github.com/oras-project/oras/releases/download/%s/oras_%s_checksums.txt", version, versionNoPrefix)

	tarballPath := filepath.Join(targetDir, assetBase+".tar.gz")
	checksumPath := filepath.Join(targetDir, "oras_"+versionNoPrefix+"_checksums.txt")

	if err := downloadFile(ctx, tarballURL, tarballPath); err != nil {
		return "", err
	}
	if err := downloadFile(ctx, checksumURL, checksumPath); err != nil {
		return "", err
	}
	if err := verifySHA256File(tarballPath, checksumPath); err != nil {
		return "", err
	}
	if err := extractTarGzBinary(tarballPath, "oras", binaryPath); err != nil {
		return "", err
	}
	return binaryPath, nil
}

func ciliumCLIAssetBase() (string, error) {
	goos := runtime.GOOS
	goarch := runtime.GOARCH
	switch goos {
	case "darwin", "linux":
	default:
		return "", fmt.Errorf("unsupported OS for cilium CLI bootstrap: %s", goos)
	}
	switch goarch {
	case "amd64", "arm64":
	default:
		return "", fmt.Errorf("unsupported architecture for cilium CLI bootstrap: %s", goarch)
	}
	return "cilium-" + goos + "-" + goarch, nil
}

func orasCLIAssetBase(version string) (string, error) {
	goos := runtime.GOOS
	goarch := runtime.GOARCH
	switch goos {
	case "darwin", "linux":
	default:
		return "", fmt.Errorf("unsupported OS for ORAS CLI bootstrap: %s", goos)
	}
	switch goarch {
	case "amd64", "arm64":
	default:
		return "", fmt.Errorf("unsupported architecture for ORAS CLI bootstrap: %s", goarch)
	}
	return fmt.Sprintf("oras_%s_%s_%s", strings.TrimPrefix(strings.TrimSpace(version), "v"), goos, goarch), nil
}

func fetchText(ctx context.Context, rawURL string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return "", fmt.Errorf("GET %s returned %s: %s", rawURL, resp.Status, strings.TrimSpace(string(body)))
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func downloadFile(ctx context.Context, rawURL, outputPath string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("download %s: %w", rawURL, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("download %s returned %s: %s", rawURL, resp.Status, strings.TrimSpace(string(body)))
	}

	if err := fs.EnsureDir(filepath.Dir(outputPath), 0o755); err != nil {
		return err
	}
	file, err := os.Create(outputPath)
	if err != nil {
		return err
	}
	defer file.Close()
	if _, err := io.Copy(file, resp.Body); err != nil {
		return err
	}
	return nil
}

func verifySHA256File(path, checksumPath string) error {
	sumData, err := os.ReadFile(checksumPath)
	if err != nil {
		return err
	}
	expected := expectedChecksum(sumData, filepath.Base(path))
	if expected == "" {
		return fmt.Errorf("checksum file %s is empty", checksumPath)
	}

	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()

	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return err
	}
	actual := hex.EncodeToString(hash.Sum(nil))
	if actual != expected {
		return fmt.Errorf("checksum mismatch for %s", path)
	}
	return nil
}

func expectedChecksum(data []byte, target string) string {
	target = strings.TrimSpace(filepath.Base(target))
	if target == "" {
		return ""
	}

	first := ""
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) == 0 {
			continue
		}
		sum := strings.ToLower(strings.TrimSpace(fields[0]))
		if first == "" {
			first = sum
		}
		if len(fields) == 1 {
			continue
		}
		name := strings.TrimLeft(filepath.Base(fields[len(fields)-1]), "*")
		if name == target {
			return sum
		}
	}
	return first
}

func extractTarGzBinary(archivePath, binaryName, outputPath string) error {
	file, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer file.Close()

	gzReader, err := gzip.NewReader(file)
	if err != nil {
		return err
	}
	defer gzReader.Close()

	tarReader := tar.NewReader(gzReader)
	for {
		header, err := tarReader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
		if filepath.Base(header.Name) != binaryName {
			continue
		}
		data, err := io.ReadAll(tarReader)
		if err != nil {
			return err
		}
		return fs.WriteFileAtomic(outputPath, data, 0o755)
	}
	return fmt.Errorf("binary %s not found in %s", binaryName, archivePath)
}

func renderTalosConfigForNode(base []byte, node config.NodeConfig) ([]byte, error) {
	var document map[string]any
	if err := yaml.Unmarshal(base, &document); err != nil {
		return nil, fmt.Errorf("parse Talos config: %w", err)
	}
	machineSection := ensureConfigMap(document, "machine")
	networkSection := ensureConfigMap(machineSection, "network")
	networkSection["hostname"] = strings.TrimSpace(node.Name)

	installDisk := strings.TrimSpace(node.InstallDisk)
	if installDisk == "" {
		rendered, err := yaml.Marshal(document)
		if err != nil {
			return nil, fmt.Errorf("render Talos node config: %w", err)
		}
		return rendered, nil
	}

	installSection := ensureConfigMap(machineSection, "install")
	installSection["disk"] = installDisk
	updated, err := yaml.Marshal(document)
	if err != nil {
		return nil, fmt.Errorf("render Talos install disk config: %w", err)
	}
	return updated, nil
}

func ensureConfigMap(root map[string]any, key string) map[string]any {
	if existing, ok := root[key]; ok {
		if typed, ok := existing.(map[string]any); ok {
			return typed
		}
	}
	child := map[string]any{}
	root[key] = child
	return child
}

func fluxInstallURL(version string) string {
	version = strings.TrimSpace(version)
	if version == "" || strings.EqualFold(version, "latest") {
		version = config.DefaultFluxVersion
	}
	return fmt.Sprintf("https://github.com/fluxcd/flux2/releases/download/%s/install.yaml", version)
}

func (a *App) bootstrapRuntimeState(cfg *config.Config) (clusterAccessSecrets, string, string, error) {
	stateDir := a.clusterStateDir(cfg.Cluster.Name)
	access := clusterAccessSecrets{}
	talosconfigPath := filepath.Join(stateDir, "talosconfig")
	kubeconfigPath := filepath.Join(stateDir, "kubeconfig")

	if data, err := os.ReadFile(filepath.Join(stateDir, "talos-secrets.yaml")); err == nil {
		access.TalosSecretsYAML = data
	}
	if data, err := os.ReadFile(filepath.Join(stateDir, "controlplane.yaml")); err == nil {
		access.ControlPlaneConfigYAML = data
	}
	if data, err := os.ReadFile(filepath.Join(stateDir, "worker.yaml")); err == nil {
		access.WorkerConfigYAML = data
	}
	if data, err := os.ReadFile(talosconfigPath); err == nil {
		access.TalosconfigYAML = data
	}
	if data, err := os.ReadFile(kubeconfigPath); err == nil {
		access.KubeconfigYAML = data
	}
	return access, talosconfigPath, kubeconfigPath, nil
}

func waitFor(ctx context.Context, interval time.Duration, check func(context.Context) error) error {
	if interval <= 0 {
		interval = 5 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if err := check(ctx); err == nil {
			return nil
		} else if ctx.Err() != nil {
			return ctx.Err()
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func removeFileIfExists(path string) error {
	err := os.Remove(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func sortedNodeNames(cfg *config.Config) []string {
	if cfg == nil {
		return nil
	}
	names := make([]string, 0, len(cfg.Nodes))
	for _, node := range cfg.Nodes {
		names = append(names, node.Name)
	}
	slices.Sort(names)
	return names
}

func parallelNodeLimit(count int) int {
	if count <= 0 {
		return 1
	}
	if count > 3 {
		return 3
	}
	return count
}
