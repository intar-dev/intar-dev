package buildinfo

import (
	"fmt"
	"strings"
)

var (
	Version = "dev"
	Commit  = "none"
	Date    = "unknown"
)

func Report(binary string) string {
	name := valueOrDefault(binary, "stardrive")

	return fmt.Sprintf(
		"%s %s\ncommit: %s\nbuilt: %s",
		name,
		valueOrDefault(Version, "dev"),
		valueOrDefault(Commit, "none"),
		valueOrDefault(Date, "unknown"),
	)
}

func valueOrDefault(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}

	return value
}
