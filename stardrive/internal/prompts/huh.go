package prompts

import (
	"context"
	"fmt"
	"strings"

	"charm.land/huh/v2"
)

type Choice[T comparable] struct {
	Label string
	Value T
}

func Input(ctx context.Context, title, description, initial string, validate func(string) error) (string, error) {
	value := initial
	field := huh.NewInput().
		Title(strings.TrimSpace(title)).
		Description(strings.TrimSpace(description)).
		Value(&value)
	if validate != nil {
		field.Validate(func(v string) error {
			return validate(strings.TrimSpace(v))
		})
	}

	if err := runForm(ctx, field); err != nil {
		return "", err
	}
	return strings.TrimSpace(value), nil
}

func Secret(ctx context.Context, title, description, initial string, validate func(string) error) (string, error) {
	value := initial
	field := huh.NewInput().
		Title(strings.TrimSpace(title)).
		Description(strings.TrimSpace(description)).
		Value(&value).
		EchoMode(huh.EchoModePassword)
	if validate != nil {
		field.Validate(func(v string) error {
			return validate(strings.TrimSpace(v))
		})
	}

	if err := runForm(ctx, field); err != nil {
		return "", err
	}
	return strings.TrimSpace(value), nil
}

func Confirm(ctx context.Context, title, description string, initial bool) (bool, error) {
	value := initial
	field := huh.NewConfirm().
		Title(strings.TrimSpace(title)).
		Description(strings.TrimSpace(description)).
		Value(&value)
	if err := runForm(ctx, field); err != nil {
		return false, err
	}
	return value, nil
}

func Select[T comparable](ctx context.Context, title, description string, choices []Choice[T], initial T) (T, error) {
	value := initial
	field := huh.NewSelect[T]().
		Title(strings.TrimSpace(title)).
		Description(strings.TrimSpace(description)).
		Value(&value)

	options := make([]huh.Option[T], 0, len(choices))
	for _, choice := range choices {
		label := strings.TrimSpace(choice.Label)
		if label == "" {
			label = fmt.Sprint(choice.Value)
		}
		options = append(options, huh.NewOption(label, choice.Value))
	}
	field.Options(options...)

	if err := runForm(ctx, field); err != nil {
		var zero T
		return zero, err
	}
	return value, nil
}

func runForm(ctx context.Context, field huh.Field) error {
	if ctx != nil && ctx.Err() != nil {
		return ctx.Err()
	}
	form := huh.NewForm(huh.NewGroup(field))
	if err := form.Run(); err != nil {
		return fmt.Errorf("interactive prompt failed: %w", err)
	}
	return nil
}
