package talos

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"

	commonapi "github.com/siderolabs/talos/pkg/machinery/api/common"
	machineapi "github.com/siderolabs/talos/pkg/machinery/api/machine"
)

func (c *Client) EtcdSnapshot(ctx context.Context, outputPath string) error {
	if strings.TrimSpace(outputPath) == "" {
		return fmt.Errorf("output path is required")
	}

	stream, err := c.raw.MachineClient.EtcdSnapshot(ctx, &machineapi.EtcdSnapshotRequest{})
	if err != nil {
		return fmt.Errorf("etcd snapshot failed: %w", err)
	}

	outputFile, err := os.Create(outputPath)
	if err != nil {
		return fmt.Errorf("create snapshot output file: %w", err)
	}
	defer outputFile.Close()

	for {
		chunk, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("read etcd snapshot stream: %w", err)
		}
		if _, err := outputFile.Write(chunk.GetBytes()); err != nil {
			return fmt.Errorf("write snapshot output file: %w", err)
		}
	}
	return nil
}

func (c *Client) EtcdRestore(ctx context.Context, snapshotPath string) error {
	if strings.TrimSpace(snapshotPath) == "" {
		return fmt.Errorf("snapshot path is required")
	}

	snapshotFile, err := os.Open(snapshotPath)
	if err != nil {
		return fmt.Errorf("open snapshot file: %w", err)
	}
	defer snapshotFile.Close()

	stream, err := c.raw.MachineClient.EtcdRecover(ctx)
	if err != nil {
		return fmt.Errorf("start etcd recovery stream: %w", err)
	}

	buffer := make([]byte, 4096)
	for {
		n, readErr := snapshotFile.Read(buffer)
		if n > 0 {
			if sendErr := stream.Send(&commonapi.Data{Bytes: buffer[:n]}); sendErr != nil {
				return fmt.Errorf("stream etcd recovery data: %w", sendErr)
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return fmt.Errorf("read snapshot file: %w", readErr)
		}
	}

	if _, err := stream.CloseAndRecv(); err != nil {
		return fmt.Errorf("etcd restore failed: %w", err)
	}
	return nil
}
