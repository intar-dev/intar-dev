package talos

import (
	"fmt"
	"strings"
)

const DefaultFactorySchematic = "376567988ad370138ad8b2698212367b8edcb69b5fd68c80be1f2ec7d603b4ba"

type BootAssets struct {
	KernelURL    string
	InitramfsURL string
}

func NormalizeVersion(version string) (string, error) {
	version = strings.TrimSpace(version)
	if version == "" {
		return "", fmt.Errorf("Talos version is required")
	}
	if !strings.HasPrefix(version, "v") {
		version = "v" + version
	}
	return version, nil
}

func EffectiveSchematic(schematic string) string {
	schematic = strings.TrimSpace(schematic)
	if schematic != "" {
		return schematic
	}
	return DefaultFactorySchematic
}

func BuildFactoryDiskImageURL(version, schematic, asset string) (string, error) {
	version, err := NormalizeVersion(version)
	if err != nil {
		return "", err
	}
	asset = strings.TrimSpace(asset)
	if asset == "" {
		return "", fmt.Errorf("Talos image asset is required")
	}
	return fmt.Sprintf("https://factory.talos.dev/image/%s/%s/%s", EffectiveSchematic(schematic), version, asset), nil
}

func BuildInstallerImageRef(version, schematic string) (string, error) {
	version, err := NormalizeVersion(version)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("factory.talos.dev/installer/%s:%s", EffectiveSchematic(schematic), version), nil
}

func BuildBootAssets(version, schematic string) (BootAssets, error) {
	var err error
	version, err = NormalizeVersion(version)
	if err != nil {
		return BootAssets{}, err
	}

	schematic = strings.TrimSpace(schematic)
	if schematic != "" {
		base := fmt.Sprintf("https://factory.talos.dev/image/%s/%s", schematic, version)
		return BootAssets{
			KernelURL:    base + "/kernel-amd64",
			InitramfsURL: base + "/initramfs-amd64.xz",
		}, nil
	}

	base := fmt.Sprintf("https://github.com/siderolabs/talos/releases/download/%s", version)
	return BootAssets{
		KernelURL:    base + "/vmlinuz-amd64",
		InitramfsURL: base + "/initramfs-amd64.xz",
	}, nil
}
