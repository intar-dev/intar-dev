package talos

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"time"

	clusterapi "github.com/siderolabs/talos/pkg/machinery/api/cluster"
	machineapi "github.com/siderolabs/talos/pkg/machinery/api/machine"
	talosclient "github.com/siderolabs/talos/pkg/machinery/client"
	clientconfig "github.com/siderolabs/talos/pkg/machinery/client/config"
)

type Client struct {
	targetNode string
	insecure   bool
	raw        *talosclient.Client
}

func NewClient(endpoint string, talosconfig []byte) (*Client, error) {
	dialEndpoint, targetNode, err := normalizeTalosEndpoint(endpoint)
	if err != nil {
		return nil, err
	}
	cfg, err := clientconfig.FromBytes(talosconfig)
	if err != nil {
		return nil, fmt.Errorf("parse talosconfig: %w", err)
	}

	raw, err := talosclient.New(
		context.Background(),
		talosclient.WithConfig(cfg),
		talosclient.WithEndpoints(dialEndpoint),
		talosclient.WithDefaultGRPCDialOptions(),
	)
	if err != nil {
		return nil, fmt.Errorf("connect to Talos API %q: %w", dialEndpoint, err)
	}

	return &Client{
		targetNode: targetNode,
		raw:        raw,
	}, nil
}

func NewInsecureClient(endpoint string) (*Client, error) {
	dialEndpoint, targetNode, err := normalizeTalosEndpoint(endpoint)
	if err != nil {
		return nil, err
	}

	raw, err := talosclient.New(
		context.Background(),
		talosclient.WithEndpoints(dialEndpoint),
		talosclient.WithTLSConfig(&tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: true}), //nolint:gosec
		talosclient.WithDefaultGRPCDialOptions(),
	)
	if err != nil {
		return nil, fmt.Errorf("connect to Talos maintenance API %q: %w", dialEndpoint, err)
	}

	return &Client{
		targetNode: targetNode,
		insecure:   true,
		raw:        raw,
	}, nil
}

func (c *Client) Close() error {
	if c == nil || c.raw == nil {
		return nil
	}
	return c.raw.Close()
}

func (c *Client) Kubeconfig(ctx context.Context) ([]byte, error) {
	data, err := c.raw.Kubeconfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("request kubeconfig: %w", err)
	}
	return data, nil
}

func (c *Client) Version(ctx context.Context) (*machineapi.VersionResponse, error) {
	resp, err := c.raw.Version(ctx)
	if err != nil {
		return nil, fmt.Errorf("request Talos version: %w", err)
	}
	return resp, nil
}

func (c *Client) ApplyConfig(ctx context.Context, config []byte, mode machineapi.ApplyConfigurationRequest_Mode) error {
	_, err := c.raw.ApplyConfiguration(ctx, &machineapi.ApplyConfigurationRequest{
		Data: config,
		Mode: mode,
	})
	if err != nil {
		return fmt.Errorf("apply Talos config: %w", err)
	}
	return nil
}

func (c *Client) Bootstrap(ctx context.Context) error {
	if err := c.raw.Bootstrap(ctx, &machineapi.BootstrapRequest{}); err != nil {
		return fmt.Errorf("bootstrap Talos node: %w", err)
	}
	return nil
}

func (c *Client) Upgrade(ctx context.Context, image string, force bool) error {
	if _, err := c.raw.Upgrade(ctx, image, false, force); err != nil {
		return fmt.Errorf("upgrade Talos node: %w", err)
	}
	return nil
}

func (c *Client) Reset(ctx context.Context, graceful, reboot bool) error {
	if err := c.raw.Reset(ctx, graceful, reboot); err != nil {
		return fmt.Errorf("reset Talos node: %w", err)
	}
	return nil
}

func (c *Client) HealthCheck(ctx context.Context, waitTimeout time.Duration, controlPlanes, workers []string, forceEndpoint string) error {
	stream, err := c.raw.ClusterHealthCheck(ctx, waitTimeout, &clusterapi.ClusterInfo{
		ControlPlaneNodes: controlPlanes,
		WorkerNodes:       workers,
		ForceEndpoint:     forceEndpoint,
	})
	if err != nil {
		return fmt.Errorf("start Talos health check: %w", err)
	}
	for {
		_, err := stream.Recv()
		if err == nil {
			continue
		}
		if err == io.EOF {
			return nil
		}
		return fmt.Errorf("Talos health check failed: %w", err)
	}
}
