package workflow

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"text/template"
	"time"

	"github.com/intar-dev/stardrive/internal/config"
)

const (
	fluxArtifactMediaType = "application/vnd.cncf.flux.content.v1.tar+gzip"
	fluxConfigMediaType   = "application/vnd.cncf.flux.config.v1+json"
)

func (a *App) GitOpsPublish(ctx context.Context, req GitOpsPublishRequest) error {
	cfg, err := config.Load(req.ConfigPath)
	if err != nil {
		return err
	}
	infClient, err := a.infisicalClient(ctx, cfg)
	if err != nil {
		return err
	}
	runtime, _ := a.loadRuntimeSecrets(ctx, cfg)
	runtime, err = a.ensureRegistryTLSMaterial(ctx, cfg, infClient, runtime)
	if err != nil {
		return err
	}

	kubeconfig, err := a.loadKubeconfigFromStateOrSecrets(ctx, cfg)
	if err != nil {
		return err
	}
	access := clusterAccessSecrets{KubeconfigYAML: kubeconfig}
	kubeconfigPath, cleanup, err := a.writeTempKubeconfig(access)
	if err != nil {
		return err
	}
	defer cleanup()

	artifactDir := filepath.Join(a.clusterStateDir(cfg.Cluster.Name), "gitops")
	if err := os.MkdirAll(artifactDir, 0o755); err != nil {
		return fmt.Errorf("create gitops artifact dir: %w", err)
	}
	renderedRoot, cleanupRendered, err := renderGitOpsSource(a.opts.Paths.GitOpsDir, cfg)
	if err != nil {
		return err
	}
	defer cleanupRendered()
	artifactPath := filepath.Join(artifactDir, "gitops.tgz")
	if err := archiveDirectoryAsTarGz(renderedRoot, artifactPath); err != nil {
		return err
	}
	artifactTag, err := gitOpsArtifactTag(artifactPath)
	if err != nil {
		return err
	}

	configPath := filepath.Join(artifactDir, "config.json")
	if err := os.WriteFile(configPath, []byte("{}\n"), 0o600); err != nil {
		return fmt.Errorf("write flux OCI config: %w", err)
	}

	orasBinary, err := a.ensureORASCLI(ctx)
	if err != nil {
		return err
	}
	caPath, caCleanup, err := a.writeTempFile("stardrive-registry-ca-*.crt", []byte(runtime.RegistryCACertPEM), 0o600)
	if err != nil {
		return err
	}
	defer caCleanup()

	if err := a.withRegistryPortForward(ctx, cfg, kubeconfigPath, func(localPort int) error {
		target := fmt.Sprintf("127.0.0.1:%d/%s:%s", localPort, gitOpsRepository(cfg), artifactTag)
		args := []string{
			"push",
			"--disable-path-validation",
			"--ca-file", caPath,
			"--config", configPath + ":" + fluxConfigMediaType,
			target,
			artifactPath + ":" + fluxArtifactMediaType,
		}
		return a.runCommand(ctx, nil, nil, orasBinary, args...)
	}); err != nil {
		return err
	}
	runtime.RegistryAddress = cfg.EffectiveRegistryAddress()
	runtime.Repository = gitOpsRepository(cfg)
	runtime.GitOpsArtifactTag = artifactTag
	if err := infClient.SetSecrets(ctx, cfg.Infisical.ProjectID, cfg.Infisical.Environment, cfg.Secrets().ClusterRuntime, map[string]string{
		secretRegistryAddress:    runtime.RegistryAddress,
		secretRegistryRepository: runtime.Repository,
		secretGitOpsArtifactTag:  runtime.GitOpsArtifactTag,
	}); err != nil {
		return err
	}
	_ = a.applyFluxBootstrapOCI(ctx, cfg, kubeconfigPath, runtime)

	a.Printf("Published %s to oci://%s/%s:%s\n", a.opts.Paths.GitOpsDir, cfg.EffectiveRegistryAddress(), gitOpsRepository(cfg), artifactTag)
	return nil
}

func gitOpsArtifactTag(artifactPath string) (string, error) {
	file, err := os.Open(artifactPath)
	if err != nil {
		return "", fmt.Errorf("open GitOps artifact %s: %w", artifactPath, err)
	}
	defer file.Close()

	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", fmt.Errorf("hash GitOps artifact %s: %w", artifactPath, err)
	}
	return "sha256-" + fmt.Sprintf("%x", hash.Sum(nil)), nil
}

func archiveDirectoryAsTarGz(root, outputPath string) error {
	root = strings.TrimSpace(root)
	if root == "" {
		return fmt.Errorf("gitops directory is required")
	}
	info, err := os.Stat(root)
	if err != nil {
		return fmt.Errorf("stat gitops directory %s: %w", root, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("%s is not a directory", root)
	}

	file, err := os.Create(outputPath)
	if err != nil {
		return fmt.Errorf("create %s: %w", outputPath, err)
	}
	defer file.Close()

	gzWriter := gzip.NewWriter(file)
	defer gzWriter.Close()
	tarWriter := tar.NewWriter(gzWriter)
	defer tarWriter.Close()

	return filepath.Walk(root, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if relative == "." {
			return nil
		}
		relative = filepath.ToSlash(relative)
		header, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		header.Name = relative
		if info.IsDir() {
			header.Name += "/"
		}
		if err := tarWriter.WriteHeader(header); err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		source, err := os.Open(path)
		if err != nil {
			return err
		}
		defer source.Close()
		_, err = io.Copy(tarWriter, source)
		return err
	})
}

type gitOpsTemplateData struct {
	ACMEEmail         string
	APIHostname       string
	AppBaseDomain     string
	AppWildcardDomain string
}

func renderGitOpsSource(sourceRoot string, cfg *config.Config) (string, func(), error) {
	sourceRoot = strings.TrimSpace(sourceRoot)
	if sourceRoot == "" {
		return "", nil, fmt.Errorf("gitops directory is required")
	}
	if cfg == nil {
		return "", nil, fmt.Errorf("config is required")
	}

	renderedRoot, err := os.MkdirTemp("", "stardrive-gitops-rendered-*")
	if err != nil {
		return "", nil, fmt.Errorf("create rendered gitops dir: %w", err)
	}
	cleanup := func() { _ = os.RemoveAll(renderedRoot) }
	data := gitOpsTemplateData{
		ACMEEmail:         cfg.Cluster.ACMEEmail,
		APIHostname:       cfg.DNS.APIHostname,
		AppBaseDomain:     cfg.AppBaseDomain(),
		AppWildcardDomain: cfg.AppWildcardHostname(),
	}

	if err := filepath.Walk(sourceRoot, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(sourceRoot, path)
		if err != nil {
			return err
		}
		if relative == "." {
			return os.MkdirAll(renderedRoot, 0o755)
		}
		target := filepath.Join(renderedRoot, relative)
		if info.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if strings.HasSuffix(info.Name(), ".tmpl") {
			target = strings.TrimSuffix(target, ".tmpl")
			return renderTemplateFile(path, target, data)
		}
		return copyFile(path, target, info.Mode())
	}); err != nil {
		cleanup()
		return "", nil, fmt.Errorf("render gitops source: %w", err)
	}

	return renderedRoot, cleanup, nil
}

func renderTemplateFile(sourcePath, targetPath string, data gitOpsTemplateData) error {
	raw, err := os.ReadFile(sourcePath)
	if err != nil {
		return fmt.Errorf("read template %s: %w", sourcePath, err)
	}
	tmpl, err := template.New(filepath.Base(sourcePath)).Option("missingkey=error").Parse(string(raw))
	if err != nil {
		return fmt.Errorf("parse template %s: %w", sourcePath, err)
	}

	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return fmt.Errorf("create template target dir %s: %w", filepath.Dir(targetPath), err)
	}
	file, err := os.OpenFile(targetPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("create rendered file %s: %w", targetPath, err)
	}
	defer file.Close()

	if err := tmpl.Execute(file, data); err != nil {
		return fmt.Errorf("render template %s: %w", sourcePath, err)
	}
	return nil
}

func copyFile(sourcePath, targetPath string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return fmt.Errorf("create copy target dir %s: %w", filepath.Dir(targetPath), err)
	}
	source, err := os.Open(sourcePath)
	if err != nil {
		return fmt.Errorf("open %s: %w", sourcePath, err)
	}
	defer source.Close()

	target, err := os.OpenFile(targetPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode.Perm())
	if err != nil {
		return fmt.Errorf("create %s: %w", targetPath, err)
	}
	defer target.Close()

	if _, err := io.Copy(target, source); err != nil {
		return fmt.Errorf("copy %s to %s: %w", sourcePath, targetPath, err)
	}
	return nil
}

func (a *App) withRegistryPortForward(ctx context.Context, cfg *config.Config, kubeconfigPath string, fn func(localPort int) error) error {
	port, err := freeTCPPort()
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, "kubectl",
		"--kubeconfig", kubeconfigPath,
		"--namespace", cfg.RegistryNamespace(),
		"port-forward",
		"svc/"+cfg.RegistryServiceName(),
		fmt.Sprintf("%d:%d", port, cfg.Storage.RegistryPort),
		"--address", "127.0.0.1",
	)
	cmd.Stdout = a.opts.Stdout
	cmd.Stderr = a.opts.Stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start registry port-forward: %w", err)
	}
	defer func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	}()

	waitCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if err := waitFor(waitCtx, 500*time.Millisecond, func(ctx context.Context) error {
		conn, err := (&net.Dialer{Timeout: time.Second}).DialContext(ctx, "tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			return err
		}
		_ = conn.Close()
		return nil
	}); err != nil {
		return fmt.Errorf("wait for registry port-forward: %w", err)
	}
	return fn(port)
}

func freeTCPPort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, fmt.Errorf("allocate local port: %w", err)
	}
	defer listener.Close()
	addr, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		return 0, fmt.Errorf("unexpected listener address type %T", listener.Addr())
	}
	return addr.Port, nil
}

func prettyJSON(value any) string {
	data, _ := json.Marshal(value)
	return string(data)
}
