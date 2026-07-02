//go:build windows

package workflow

import (
	"os"
	"strings"
	"syscall"
)

func defaultExecShell() string {
	if shell := strings.TrimSpace(os.Getenv("COMSPEC")); shell != "" {
		return shell
	}

	return "cmd.exe"
}

func commandSysProcAttr() *syscall.SysProcAttr {
	return nil
}
