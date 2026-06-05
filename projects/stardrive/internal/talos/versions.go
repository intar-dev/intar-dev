package talos

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"runtime/debug"
	"strings"
	"time"

	machineapi "github.com/siderolabs/talos/pkg/machinery/api/machine"
	compatibility "github.com/siderolabs/talos/pkg/machinery/compatibility"
)

const (
	defaultTalosReleasesURL          = "https://api.github.com/repos/siderolabs/talos/releases?per_page=%d"
	defaultKubernetesStableURLFormat = "https://dl.k8s.io/release/stable-%s.txt"
	talosMachineryModulePath         = "github.com/siderolabs/talos/pkg/machinery"
)

var (
	talosVersionPattern = regexp.MustCompile(`^v?(\d+)\.(\d+)(?:\.(\d+))?$`)
)

type ReleaseResolver struct {
	httpClient             *http.Client
	supportedTalosMinor    string
	talosReleasesURLFmt    string
	kubernetesStableURLFmt string
}

func NewReleaseResolver() *ReleaseResolver {
	return &ReleaseResolver{
		httpClient:             &http.Client{Timeout: 20 * time.Second},
		talosReleasesURLFmt:    defaultTalosReleasesURL,
		kubernetesStableURLFmt: defaultKubernetesStableURLFormat,
	}
}

func (r *ReleaseResolver) ResolveBootstrapVersions(ctx context.Context, talosVersion, kubernetesVersion string) (string, string, error) {
	resolvedTalos := normalizeTalosVersion(talosVersion)
	if resolvedTalos == "" {
		latest, err := r.LatestTalosVersion(ctx)
		if err != nil {
			return "", "", err
		}
		resolvedTalos = latest
	}

	resolvedKubernetes := normalizeKubernetesVersion(kubernetesVersion)
	if resolvedKubernetes == "" {
		minor, err := r.HighestSupportedKubernetesMinor(ctx, resolvedTalos)
		if err != nil {
			return "", "", err
		}
		latestPatch, err := r.LatestKubernetesPatch(ctx, minor)
		if err != nil {
			return "", "", err
		}
		resolvedKubernetes = latestPatch
	}

	return resolvedTalos, resolvedKubernetes, nil
}

func (r *ReleaseResolver) LatestTalosVersion(ctx context.Context) (string, error) {
	versions, err := r.StableTalosVersions(ctx, 1)
	if err != nil {
		return "", err
	}
	if len(versions) == 0 {
		return "", fmt.Errorf("no supported Talos releases found")
	}
	return versions[0], nil
}

func (r *ReleaseResolver) HighestSupportedKubernetesMinor(ctx context.Context, talosVersion string) (string, error) {
	minors, err := r.SupportedKubernetesMinors(ctx, talosVersion)
	if err != nil {
		return "", err
	}
	if len(minors) == 0 {
		return "", fmt.Errorf("no supported Kubernetes minors found for Talos %s", talosVersion)
	}
	return minors[0], nil
}

func (r *ReleaseResolver) StableTalosVersions(ctx context.Context, limit int) ([]string, error) {
	if limit <= 0 {
		limit = 8
	}
	supportedMinor, err := supportedTalosMinor()
	if strings.TrimSpace(r.supportedTalosMinor) != "" {
		supportedMinor = strings.TrimSpace(r.supportedTalosMinor)
		err = nil
	}
	if err != nil {
		return nil, err
	}

	var response []struct {
		TagName    string `json:"tag_name"`
		Draft      bool   `json:"draft"`
		Prerelease bool   `json:"prerelease"`
	}
	if err := r.getJSON(ctx, fmt.Sprintf(r.talosReleasesURLFmt, limit*2), &response); err != nil {
		return nil, fmt.Errorf("list Talos releases: %w", err)
	}

	versions := make([]string, 0, limit)
	seen := map[string]struct{}{}
	for _, release := range response {
		if release.Draft || release.Prerelease {
			continue
		}
		version := normalizeTalosVersion(release.TagName)
		if version == "" {
			continue
		}
		minor, err := talosMinorVersion(version)
		if err != nil || minor != supportedMinor {
			continue
		}
		if _, ok := seen[version]; ok {
			continue
		}
		seen[version] = struct{}{}
		versions = append(versions, version)
		if len(versions) >= limit {
			break
		}
	}
	if len(versions) == 0 {
		return nil, fmt.Errorf("no stable Talos releases found")
	}
	return versions, nil
}

func (r *ReleaseResolver) SupportedKubernetesMinors(ctx context.Context, talosVersion string) ([]string, error) {
	target, err := compatibility.ParseTalosVersion(&machineapi.VersionInfo{Tag: normalizeTalosVersion(talosVersion)})
	if err != nil {
		return nil, err
	}
	minors := make([]string, 0, 8)
	for minor := 45; minor >= 20; minor-- {
		version := fmt.Sprintf("1.%d.0", minor)
		k8sVersion, err := compatibility.ParseKubernetesVersion(version)
		if err != nil {
			continue
		}
		if err := k8sVersion.SupportedWith(target); err == nil {
			minors = append(minors, fmt.Sprintf("1.%d", minor))
		}
	}
	if len(minors) == 0 {
		return nil, fmt.Errorf("no supported Kubernetes versions found for Talos %s", talosVersion)
	}
	return minors, nil
}

func (r *ReleaseResolver) SupportedKubernetesPatches(ctx context.Context, talosVersion string) ([]string, error) {
	minors, err := r.SupportedKubernetesMinors(ctx, talosVersion)
	if err != nil {
		return nil, err
	}

	patches := make([]string, 0, len(minors))
	for _, minor := range minors {
		version, err := r.LatestKubernetesPatch(ctx, minor)
		if err != nil {
			return nil, err
		}
		patches = append(patches, version)
	}
	return patches, nil
}

func (r *ReleaseResolver) LatestKubernetesPatch(ctx context.Context, minor string) (string, error) {
	minor = strings.TrimSpace(strings.TrimPrefix(minor, "v"))
	if minor == "" {
		return "", fmt.Errorf("Kubernetes minor version is required")
	}

	version, err := r.getText(ctx, fmt.Sprintf(r.kubernetesStableURLFmt, minor))
	if err != nil {
		return "", fmt.Errorf("resolve latest Kubernetes patch for %s: %w", minor, err)
	}

	version = normalizeKubernetesVersion(version)
	if version == "" {
		return "", fmt.Errorf("latest Kubernetes patch response for %s was empty", minor)
	}
	return version, nil
}

func talosMinorVersion(version string) (string, error) {
	match := talosVersionPattern.FindStringSubmatch(strings.TrimSpace(version))
	if len(match) < 3 {
		return "", fmt.Errorf("parse Talos version %q", version)
	}
	return match[1] + "." + match[2], nil
}

func normalizeTalosVersion(version string) string {
	version = strings.TrimSpace(version)
	if version == "" {
		return ""
	}
	match := talosVersionPattern.FindStringSubmatch(version)
	if len(match) == 0 {
		return ""
	}
	if match[3] == "" {
		return "v" + match[1] + "." + match[2] + ".0"
	}
	return "v" + match[1] + "." + match[2] + "." + match[3]
}

func normalizeKubernetesVersion(version string) string {
	version = strings.TrimSpace(strings.TrimPrefix(version, "v"))
	return version
}

func (r *ReleaseResolver) getJSON(ctx context.Context, rawURL string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "stardrive")

	client := r.httpClient
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("GET %s returned %s: %s", rawURL, resp.Status, strings.TrimSpace(string(body)))
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func (r *ReleaseResolver) getText(ctx context.Context, rawURL string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "text/plain, text/html, application/json")
	req.Header.Set("User-Agent", "stardrive")

	client := r.httpClient
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return "", fmt.Errorf("GET %s returned %s: %s", rawURL, resp.Status, strings.TrimSpace(string(body)))
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(body)), nil
}

func supportedTalosMinor() (string, error) {
	buildInfo, ok := debug.ReadBuildInfo()
	if !ok {
		return "", fmt.Errorf("read build info for Talos machinery dependency")
	}
	for _, dep := range buildInfo.Deps {
		if dep.Path != talosMachineryModulePath {
			continue
		}
		minor, err := talosMinorVersion(dep.Version)
		if err != nil {
			return "", fmt.Errorf("parse Talos machinery version %q: %w", dep.Version, err)
		}
		return minor, nil
	}
	return "", fmt.Errorf("Talos machinery dependency not found in build info")
}
