//go:build !windows

package workflow

import (
	"os"
	"strings"
	"syscall"
)

func defaultExecShell() string {
	if shell := strings.TrimSpace(os.Getenv("SHELL")); shell != "" {
		return shell
	}

	return "/bin/sh"
}

func commandSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}
