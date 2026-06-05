package cloudflare

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

const apiBaseURL = "https://api.cloudflare.com/client/v4"

var zoneIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{32}$`)

type Client struct {
	token      string
	httpClient *http.Client
}

type Zone struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type DNSRecord struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Name    string `json:"name"`
	Content string `json:"content"`
	Proxied *bool  `json:"proxied,omitempty"`
}

func New(token string) *Client {
	return &Client{
		token:      strings.TrimSpace(token),
		httpClient: http.DefaultClient,
	}
}

func (c *Client) ResolveZoneID(ctx context.Context, zone string) (string, error) {
	zone = strings.TrimSpace(zone)
	if zone == "" {
		return "", fmt.Errorf("zone is required")
	}
	if isZoneID(zone) {
		return zone, nil
	}
	slog.Debug("resolving Cloudflare zone", "zone", zone)

	query := url.Values{}
	query.Set("name", zone)
	var zones []Zone
	if err := c.doJSON(ctx, http.MethodGet, "/zones?"+query.Encode(), nil, &zones); err != nil {
		return "", err
	}
	if len(zones) == 0 {
		return "", fmt.Errorf("cloudflare zone %s not found", zone)
	}
	return zones[0].ID, nil
}

func (c *Client) UpsertARecords(ctx context.Context, zone, hostname string, ips []string, proxied bool) error {
	slog.Info("upserting Cloudflare A records", "zone", zone, "hostname", hostname, "ips", ips, "proxied", proxied)
	zoneID, err := c.ResolveZoneID(ctx, zone)
	if err != nil {
		return err
	}
	if err := c.DeleteARecords(ctx, zoneID, hostname); err != nil {
		return err
	}
	for _, ip := range ips {
		record := map[string]any{
			"type":    "A",
			"name":    strings.TrimSpace(hostname),
			"content": strings.TrimSpace(ip),
			"proxied": proxied,
			"ttl":     1,
		}
		if err := c.doJSON(ctx, http.MethodPost, "/zones/"+zoneID+"/dns_records", record, nil); err != nil {
			return err
		}
	}
	return nil
}

func (c *Client) DeleteARecords(ctx context.Context, zoneOrID, hostname string) error {
	slog.Info("deleting Cloudflare A records", "zone", zoneOrID, "hostname", hostname)
	zoneID := strings.TrimSpace(zoneOrID)
	if !isZoneID(zoneID) {
		resolved, err := c.ResolveZoneID(ctx, zoneOrID)
		if err != nil {
			return err
		}
		zoneID = resolved
	}

	query := url.Values{}
	query.Set("type", "A")
	query.Set("name", strings.TrimSpace(hostname))
	var records []DNSRecord
	if err := c.doJSON(ctx, http.MethodGet, "/zones/"+zoneID+"/dns_records?"+query.Encode(), nil, &records); err != nil {
		return err
	}
	for _, record := range records {
		if err := c.doJSON(ctx, http.MethodDelete, "/zones/"+zoneID+"/dns_records/"+record.ID, nil, nil); err != nil {
			return err
		}
	}
	return nil
}

func isZoneID(value string) bool {
	return zoneIDPattern.MatchString(strings.TrimSpace(value))
}

func (c *Client) doJSON(ctx context.Context, method, path string, requestBody any, out any) error {
	if strings.TrimSpace(c.token) == "" {
		return fmt.Errorf("cloudflare API token is required")
	}

	var body io.Reader
	if requestBody != nil {
		payload, err := json.Marshal(requestBody)
		if err != nil {
			return fmt.Errorf("marshal cloudflare request: %w", err)
		}
		body = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, apiBaseURL+path, body)
	if err != nil {
		return fmt.Errorf("create cloudflare request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")
	if requestBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("call cloudflare API %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("cloudflare API %s %s returned %s: %s", method, path, resp.Status, strings.TrimSpace(string(body)))
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil
	}
	var wrapped struct {
		Result json.RawMessage `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&wrapped); err != nil {
		return fmt.Errorf("decode cloudflare response %s %s: %w", method, path, err)
	}
	if len(wrapped.Result) == 0 {
		return nil
	}
	if err := json.Unmarshal(wrapped.Result, out); err != nil {
		return fmt.Errorf("decode cloudflare result %s %s: %w", method, path, err)
	}
	return nil
}
