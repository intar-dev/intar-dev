package hetzner

import (
	"context"
	"io"
	"net"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/hetznercloud/hcloud-go/v2/hcloud"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

func TestCreateStorageBoxUsesCurrentAPIFields(t *testing.T) {
	client := &Client{
		token: "test-token",
		httpClient: &http.Client{
			Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				if req.Method != http.MethodPost {
					t.Fatalf("unexpected method: %s", req.Method)
				}
				if req.URL.Path != "/v1/storage_boxes" {
					t.Fatalf("unexpected path: %s", req.URL.Path)
				}
				body, err := io.ReadAll(req.Body)
				if err != nil {
					t.Fatalf("read body: %v", err)
				}
				payload := string(body)
				if !strings.Contains(payload, `"storage_box_type":"BX11"`) {
					t.Fatalf("missing storage_box_type in payload: %s", payload)
				}
				if strings.Contains(payload, `"type":"BX11"`) {
					t.Fatalf("legacy type field should not be sent: %s", payload)
				}
				if !strings.Contains(payload, `"password":"Sd1!test-password"`) {
					t.Fatalf("missing password in payload: %s", payload)
				}
				return &http.Response{
					StatusCode: http.StatusCreated,
					Body: io.NopCloser(strings.NewReader(`{
						"storage_box": {
							"id": 7,
							"name": "stardrive-intar-storage-box",
							"username": "u12345",
							"location": "fsn1",
							"storage_box_type": "BX11",
							"status": "initializing"
						}
					}`)),
					Header: make(http.Header),
				}, nil
			}),
		},
	}

	box, err := client.CreateStorageBox(context.Background(), "stardrive-intar-storage-box", "BX11", "fsn1", "Sd1!test-password")
	if err != nil {
		t.Fatalf("CreateStorageBox returned error: %v", err)
	}
	if box.Type != "BX11" {
		t.Fatalf("unexpected storage box type: %q", box.Type)
	}
	if box.Location != "fsn1" {
		t.Fatalf("unexpected storage box location: %q", box.Location)
	}
}

func TestWaitForStorageBoxReadyPollsUntilUsernameAndStatusAreReady(t *testing.T) {
	requests := 0
	client := &Client{
		token: "test-token",
		httpClient: &http.Client{
			Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				requests++
				if req.Method != http.MethodGet {
					t.Fatalf("unexpected method: %s", req.Method)
				}
				if req.URL.Path != "/v1/storage_boxes" {
					t.Fatalf("unexpected path: %s", req.URL.Path)
				}

				body := `{"storage_boxes":[{"id":7,"name":"stardrive-intar-storage-box","location":"fsn1","storage_box_type":"BX11","status":"initializing"}]}`
				if requests > 1 {
					body = `{"storage_boxes":[{"id":7,"name":"stardrive-intar-storage-box","username":"u12345","location":"fsn1","storage_box_type":"BX11","status":"active"}]}`
				}
				return &http.Response{
					StatusCode: http.StatusOK,
					Body:       io.NopCloser(strings.NewReader(body)),
					Header:     make(http.Header),
				}, nil
			}),
		},
	}

	box, err := client.WaitForStorageBoxReady(context.Background(), 7, 6*time.Second)
	if err != nil {
		t.Fatalf("WaitForStorageBoxReady returned error: %v", err)
	}
	if requests < 2 {
		t.Fatalf("expected multiple polling requests, got %d", requests)
	}
	if box.Username != "u12345" {
		t.Fatalf("unexpected username: %q", box.Username)
	}
	if box.Status != "active" {
		t.Fatalf("unexpected status: %q", box.Status)
	}
}

func TestResetStorageBoxPasswordUsesExpectedEndpoint(t *testing.T) {
	client := &Client{
		token: "test-token",
		httpClient: &http.Client{
			Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				if req.Method != http.MethodPost {
					t.Fatalf("unexpected method: %s", req.Method)
				}
				if req.URL.Path != "/v1/storage_boxes/7/actions/reset_password" {
					t.Fatalf("unexpected path: %s", req.URL.Path)
				}
				body, err := io.ReadAll(req.Body)
				if err != nil {
					t.Fatalf("read body: %v", err)
				}
				payload := string(body)
				if !strings.Contains(payload, `"password":"Sd1!replacement-password"`) {
					t.Fatalf("missing password in payload: %s", payload)
				}
				return &http.Response{
					StatusCode: http.StatusOK,
					Body:       io.NopCloser(strings.NewReader(`{}`)),
					Header:     make(http.Header),
				}, nil
			}),
		},
	}

	if err := client.ResetStorageBoxPassword(context.Background(), 7, "Sd1!replacement-password"); err != nil {
		t.Fatalf("ResetStorageBoxPassword returned error: %v", err)
	}
}

func TestUpdateStorageBoxAccessSettingsUsesExpectedEndpoint(t *testing.T) {
	client := &Client{
		token: "test-token",
		httpClient: &http.Client{
			Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
				if req.Method != http.MethodPost {
					t.Fatalf("unexpected method: %s", req.Method)
				}
				if req.URL.Path != "/v1/storage_boxes/7/actions/update_access_settings" {
					t.Fatalf("unexpected path: %s", req.URL.Path)
				}
				body, err := io.ReadAll(req.Body)
				if err != nil {
					t.Fatalf("read body: %v", err)
				}
				payload := string(body)
				if !strings.Contains(payload, `"samba_enabled":true`) {
					t.Fatalf("missing samba_enabled in payload: %s", payload)
				}
				return &http.Response{
					StatusCode: http.StatusOK,
					Body:       io.NopCloser(strings.NewReader(`{}`)),
					Header:     make(http.Header),
				}, nil
			}),
		},
	}

	if err := client.UpdateStorageBoxAccessSettings(context.Background(), 7, true); err != nil {
		t.Fatalf("UpdateStorageBoxAccessSettings returned error: %v", err)
	}
}

func TestEnsureFirewallOpensPublicEdgePorts(t *testing.T) {
	rules := firewallRules(nil)
	ports := map[string]struct{}{}
	for _, rule := range rules {
		if rule.Port != nil {
			ports[*rule.Port] = struct{}{}
		}
	}
	for _, port := range []string{"50000", "6443", "80", "443"} {
		if _, ok := ports[port]; !ok {
			t.Fatalf("expected firewall rules to expose port %s, got %#v", port, ports)
		}
	}
}

func TestFirewallRulesEqualIgnoresOrderingButDetectsDrift(t *testing.T) {
	rules := firewallRules([]string{"203.0.113.0/24"})
	reordered := append([]hcloud.FirewallRule(nil), rules...)
	slices.Reverse(reordered)

	if !firewallRulesEqual(rules, reordered) {
		t.Fatalf("expected firewall rules to compare equal after reordering")
	}

	drifted := append([]hcloud.FirewallRule(nil), rules...)
	port := "8443"
	drifted[0].Port = &port
	if firewallRulesEqual(rules, drifted) {
		t.Fatalf("expected firewall rules with drifted port to compare unequal")
	}
}

func TestFromHCloudServerCapturesReconciliationMetadata(t *testing.T) {
	server := &hcloud.Server{
		ID:     42,
		Name:   "control-plane-01",
		Status: hcloud.ServerStatusRunning,
		ServerType: &hcloud.ServerType{
			Name: "cpx21",
		},
		Location: &hcloud.Location{
			Name: "fsn1",
		},
		Image: &hcloud.Image{
			ID: 77,
		},
		PlacementGroup: &hcloud.PlacementGroup{
			ID: 9,
		},
		PublicNet: hcloud.ServerPublicNet{
			IPv4: hcloud.ServerPublicNetIPv4{
				IP: net.ParseIP("49.13.142.173"),
			},
			Firewalls: []*hcloud.ServerFirewallStatus{
				{Firewall: hcloud.Firewall{ID: 5}},
				{Firewall: hcloud.Firewall{ID: 6}},
			},
		},
		PrivateNet: []hcloud.ServerPrivateNet{
			{
				Network: &hcloud.Network{ID: 11},
				IP:      net.ParseIP("10.42.0.10"),
			},
			{
				Network: &hcloud.Network{ID: 12},
				IP:      net.ParseIP("10.42.0.11"),
			},
		},
	}

	converted := fromHCloudServer(server)
	if converted == nil {
		t.Fatal("expected converted server")
	}
	if converted.ImageID != 77 {
		t.Fatalf("expected image ID 77, got %d", converted.ImageID)
	}
	if converted.PlacementGroupID != 9 {
		t.Fatalf("expected placement group ID 9, got %d", converted.PlacementGroupID)
	}
	if converted.PublicIPv4 != "49.13.142.173" {
		t.Fatalf("expected public IPv4 to be captured, got %q", converted.PublicIPv4)
	}
	if converted.PrivateIPv4 != "10.42.0.10" {
		t.Fatalf("expected first private IPv4 to be captured, got %q", converted.PrivateIPv4)
	}
	if !slices.Equal(converted.NetworkIDs, []int64{11, 12}) {
		t.Fatalf("expected network IDs [11 12], got %v", converted.NetworkIDs)
	}
	if !slices.Equal(converted.FirewallIDs, []int64{5, 6}) {
		t.Fatalf("expected firewall IDs [5 6], got %v", converted.FirewallIDs)
	}
}
