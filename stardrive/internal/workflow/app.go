package workflow

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"

	"github.com/intar-dev/stardrive/internal/config"
	"github.com/intar-dev/stardrive/internal/operation"
)

type Options struct {
	Paths  config.Paths
	Stdout io.Writer
	Stderr io.Writer
}

type App struct {
	ctx   context.Context
	opts  Options
	store *operation.Store
}

func NewApp(ctx context.Context, opts Options) *App {
	opts.Paths = opts.Paths.WithDefaults()
	if opts.Stdout == nil {
		opts.Stdout = os.Stdout
	}
	if opts.Stderr == nil {
		opts.Stderr = os.Stderr
	}
	return &App{
		ctx:   ctx,
		opts:  opts,
		store: operation.NewStore(opts.Paths.StateDir),
	}
}

func (a *App) Paths() config.Paths {
	return a.opts.Paths
}

func (a *App) OperationStore() *operation.Store {
	return a.store
}

func (a *App) Printf(format string, args ...any) {
	_, _ = fmt.Fprintf(a.opts.Stdout, format, args...)
}

func (a *App) logDebug(msg string, args ...any) {
	slog.Debug(msg, args...)
}

func (a *App) logInfo(msg string, args ...any) {
	slog.Info(msg, args...)
}

func (a *App) logWarn(msg string, args ...any) {
	slog.Warn(msg, args...)
}

func (a *App) logError(msg string, args ...any) {
	slog.Error(msg, args...)
}
