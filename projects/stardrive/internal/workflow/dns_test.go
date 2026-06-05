package workflow

import "testing"

func TestDesiredPublicDNSRecordsUseAllControlPlanePublicIPs(t *testing.T) {
	t.Parallel()

	cfg := workflowTestConfig(3)
	for i := range cfg.Nodes {
		cfg.Nodes[i].PublicIPv4 = []string{"49.13.128.157", "49.13.140.59", "49.13.142.173"}[i]
	}
	records := desiredPublicDNSRecords(cfg)

	apiRecords := records[cfg.DNS.APIHostname]
	if len(apiRecords) != 3 {
		t.Fatalf("expected 3 API records, got %v", apiRecords)
	}
	if wildcard := cfg.AppWildcardHostname(); len(records[wildcard]) != 3 {
		t.Fatalf("expected wildcard record for %s, got %v", wildcard, records[wildcard])
	}
}

func TestDesiredNodeDNSRecordsRespectManageNodeRecords(t *testing.T) {
	t.Parallel()

	cfg := workflowTestConfig(3)
	cfg.DNS.ManageNodeRecords = true
	cfg.DNS.ManageNodeRecordsSet = true
	for i := range cfg.Nodes {
		cfg.Nodes[i].PublicIPv4 = []string{"49.13.128.157", "49.13.140.59", "49.13.142.173"}[i]
	}

	records := desiredNodeDNSRecords(cfg)
	if len(records) != len(cfg.Nodes) {
		t.Fatalf("expected %d node DNS records, got %d", len(cfg.Nodes), len(records))
	}
}

func TestDesiredNodeReverseDNSRecordsRespectManageNodeRecords(t *testing.T) {
	t.Parallel()

	cfg := workflowTestConfig(3)
	cfg.DNS.ManageNodeRecords = true
	cfg.DNS.ManageNodeRecordsSet = true
	for i := range cfg.Nodes {
		cfg.Nodes[i].ServerID = int64(i + 1)
		cfg.Nodes[i].PublicIPv4 = []string{"49.13.128.157", "49.13.140.59", "49.13.142.173"}[i]
	}

	records := desiredNodeReverseDNSRecords(cfg)
	if len(records) != len(cfg.Nodes) {
		t.Fatalf("expected %d reverse DNS records, got %d", len(cfg.Nodes), len(records))
	}
	if got := records[cfg.Nodes[0].ProviderID()]; got != nodeDNSName(cfg, cfg.Nodes[0]) {
		t.Fatalf("expected reverse DNS hostname %q, got %q", nodeDNSName(cfg, cfg.Nodes[0]), got)
	}

	cfg.DNS.ManageNodeRecords = false
	if got := desiredNodeReverseDNSRecords(cfg); got != nil {
		t.Fatalf("expected reverse DNS records to be disabled, got %v", got)
	}
}

func TestNodeDNSNameFallsBackToAppBaseDomain(t *testing.T) {
	t.Parallel()

	cfg := workflowTestConfig(3)
	cfg.DNS.Zone = "cd5aa63e949cca2558dc73daa657759e"

	got := nodeDNSName(cfg, cfg.Nodes[0])
	if got != "control-plane-01.example.com" {
		t.Fatalf("expected fallback node DNS name, got %q", got)
	}
}
