package workflow

import (
	"context"
	"fmt"
	"strings"

	"github.com/intar-dev/stardrive/internal/cloudflare"
	"github.com/intar-dev/stardrive/internal/config"
	"github.com/intar-dev/stardrive/internal/hetzner"
)

func desiredPublicDNSRecords(cfg *config.Config) map[string][]string {
	if cfg == nil {
		return nil
	}

	ips := publicNodeIPs(cfg)
	if len(ips) == 0 {
		return nil
	}

	records := map[string][]string{}
	if hostname := strings.TrimSpace(cfg.DNS.APIHostname); hostname != "" {
		records[hostname] = append([]string(nil), ips...)
	}
	if hostname := strings.TrimSpace(cfg.AppWildcardHostname()); hostname != "" {
		records[hostname] = append([]string(nil), ips...)
	}
	return records
}

func desiredNodeDNSRecords(cfg *config.Config) map[string][]string {
	if cfg == nil || !cfg.DNS.ManageNodeRecords {
		return nil
	}

	records := map[string][]string{}
	for _, node := range cfg.Nodes {
		if ip := strings.TrimSpace(node.PublicIPv4); ip != "" {
			records[nodeDNSName(cfg, node)] = []string{ip}
		}
	}
	return records
}

func desiredNodeReverseDNSRecords(cfg *config.Config) map[int64]string {
	if cfg == nil || !cfg.DNS.ManageNodeRecords {
		return nil
	}

	records := map[int64]string{}
	for _, node := range cfg.Nodes {
		if node.ProviderID() == 0 || strings.TrimSpace(node.PublicIPv4) == "" {
			continue
		}
		records[node.ProviderID()] = nodeDNSName(cfg, node)
	}
	return records
}

func syncClusterDNS(ctx context.Context, cfg *config.Config, token string) error {
	token = strings.TrimSpace(token)
	if token == "" {
		return fmt.Errorf("cloudflare API token is required")
	}
	records := desiredPublicDNSRecords(cfg)
	if len(records) == 0 {
		return fmt.Errorf("no public DNS records can be derived from cluster nodes")
	}

	client := cloudflare.New(token)
	for hostname, ips := range records {
		if err := client.UpsertARecords(ctx, cfg.DNS.Zone, hostname, ips, false); err != nil {
			return err
		}
	}
	for hostname, ips := range desiredNodeDNSRecords(cfg) {
		if err := client.UpsertARecords(ctx, cfg.DNS.Zone, hostname, ips, false); err != nil {
			return err
		}
	}
	return nil
}

func syncClusterReverseDNS(ctx context.Context, cfg *config.Config, hzClient *hetzner.Client) error {
	if hzClient == nil {
		return fmt.Errorf("Hetzner client is required")
	}
	if cfg == nil || !cfg.DNS.ManageNodeRecords {
		return nil
	}
	for _, node := range cfg.Nodes {
		if serverID := node.ProviderID(); serverID > 0 && strings.TrimSpace(node.PublicIPv4) != "" {
			if err := hzClient.EnsureServerReverseDNS(ctx, serverID, strings.TrimSpace(node.PublicIPv4), nodeDNSName(cfg, node)); err != nil {
				return err
			}
		}
	}
	return nil
}

func deleteClusterDNS(ctx context.Context, cfg *config.Config, token string) error {
	token = strings.TrimSpace(token)
	if token == "" {
		return fmt.Errorf("cloudflare API token is required")
	}

	client := cloudflare.New(token)
	for hostname := range desiredPublicDNSRecords(cfg) {
		if err := client.DeleteARecords(ctx, cfg.DNS.Zone, hostname); err != nil {
			return err
		}
	}
	if wildcard := strings.TrimSpace(cfg.AppWildcardHostname()); wildcard != "" {
		if err := client.DeleteARecords(ctx, cfg.DNS.Zone, wildcard); err != nil {
			return err
		}
	}
	if api := strings.TrimSpace(cfg.DNS.APIHostname); api != "" {
		if err := client.DeleteARecords(ctx, cfg.DNS.Zone, api); err != nil {
			return err
		}
	}
	for hostname := range desiredNodeDNSRecords(cfg) {
		if err := client.DeleteARecords(ctx, cfg.DNS.Zone, hostname); err != nil {
			return err
		}
	}
	return nil
}
