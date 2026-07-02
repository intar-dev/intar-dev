package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/intar-dev/stardrive/internal/buildinfo"
)

func TestRootCommandVersionFlagSkipsEnvLoading(t *testing.T) {
	restore := setBuildInfo(t, "v1.2.3", "abc1234", "2026-04-10T12:34:56Z")
	defer restore()

	envFile := writeInvalidEnvFile(t)

	cmd := NewRootCommand()
	output := &bytes.Buffer{}
	cmd.SetOut(output)
	cmd.SetErr(output)
	cmd.SetArgs([]string{"--env-file", envFile, "--version"})

	if err := cmd.Execute(); err != nil {
		t.Fatalf("Execute returned error: %v", err)
	}

	const want = "stardrive v1.2.3\ncommit: abc1234\nbuilt: 2026-04-10T12:34:56Z\n"
	if got := output.String(); got != want {
		t.Fatalf("unexpected version output:\nwant:\n%s\ngot:\n%s", want, got)
	}
}

func TestVersionCommandSkipsEnvLoading(t *testing.T) {
	restore := setBuildInfo(t, "v1.2.3", "abc1234", "2026-04-10T12:34:56Z")
	defer restore()

	envFile := writeInvalidEnvFile(t)

	cmd := NewRootCommand()
	output := &bytes.Buffer{}
	cmd.SetOut(output)
	cmd.SetErr(output)
	cmd.SetArgs([]string{"--env-file", envFile, "version"})

	if err := cmd.Execute(); err != nil {
		t.Fatalf("Execute returned error: %v", err)
	}

	const want = "stardrive v1.2.3\ncommit: abc1234\nbuilt: 2026-04-10T12:34:56Z\n"
	if got := output.String(); got != want {
		t.Fatalf("unexpected version output:\nwant:\n%s\ngot:\n%s", want, got)
	}
}

func setBuildInfo(t *testing.T, version, commit, date string) func() {
	t.Helper()

	previousVersion := buildinfo.Version
	previousCommit := buildinfo.Commit
	previousDate := buildinfo.Date

	buildinfo.Version = version
	buildinfo.Commit = commit
	buildinfo.Date = date

	return func() {
		buildinfo.Version = previousVersion
		buildinfo.Commit = previousCommit
		buildinfo.Date = previousDate
	}
}

func writeInvalidEnvFile(t *testing.T) string {
	t.Helper()

	path := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(path, []byte("this is not valid\n"), 0o600); err != nil {
		t.Fatalf("write env file: %v", err)
	}

	return path
}
