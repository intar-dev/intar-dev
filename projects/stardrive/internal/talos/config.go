package talos

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

const (
	defaultOSDisk        = "/dev/sda"
	talosAPIDefaultPort  = "50000"
	kubernetesAPIPort    = "6443"
)

func normalizeTalosEndpoint(endpoint string) (dialEndpoint string, target string, err error) {
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		return "", "", fmt.Errorf("endpoint is required")
	}

	if strings.HasPrefix(endpoint, "http://") || strings.HasPrefix(endpoint, "https://") {
		parsed, parseErr := url.Parse(endpoint)
		if parseErr != nil {
			return "", "", fmt.Errorf("parse endpoint %q: %w", endpoint, parseErr)
		}
		host := parsed.Hostname()
		port := parsed.Port()
		if port == "" {
			port = talosAPIDefaultPort
		}
		return net.JoinHostPort(host, port), host, nil
	}

	host, port, splitErr := net.SplitHostPort(endpoint)
	if splitErr == nil {
		return net.JoinHostPort(host, port), host, nil
	}

	return net.JoinHostPort(endpoint, talosAPIDefaultPort), endpoint, nil
}

func normalizeClusterEndpoint(endpoint string) string {
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		return ""
	}
	if strings.HasPrefix(endpoint, "http://") || strings.HasPrefix(endpoint, "https://") {
		return endpoint
	}
	if _, _, err := net.SplitHostPort(endpoint); err == nil {
		return "https://" + endpoint
	}
	return "https://" + net.JoinHostPort(endpoint, kubernetesAPIPort)
}
