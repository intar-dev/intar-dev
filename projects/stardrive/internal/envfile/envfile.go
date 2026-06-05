package envfile

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
	"unicode"
)

func Load(path string, overwrite bool) (int, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return 0, nil
	}

	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, fmt.Errorf("open env file %s: %w", path, err)
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	loaded := 0
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		key, value, ok, err := parseLine(scanner.Text())
		if err != nil {
			return loaded, fmt.Errorf("parse env file %s line %d: %w", path, lineNo, err)
		}
		if !ok {
			continue
		}
		if !overwrite {
			if _, exists := os.LookupEnv(key); exists {
				continue
			}
		}
		if err := os.Setenv(key, value); err != nil {
			return loaded, fmt.Errorf("set env %s from %s: %w", key, path, err)
		}
		loaded++
	}
	if err := scanner.Err(); err != nil {
		return loaded, fmt.Errorf("scan env file %s: %w", path, err)
	}
	return loaded, nil
}

func parseLine(line string) (key, value string, ok bool, err error) {
	line = strings.TrimSpace(line)
	if line == "" || strings.HasPrefix(line, "#") {
		return "", "", false, nil
	}
	if strings.HasPrefix(line, "export ") {
		line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
	}

	left, right, found := strings.Cut(line, "=")
	if !found {
		return "", "", false, fmt.Errorf("missing '='")
	}

	key = strings.TrimSpace(left)
	if !validKey(key) {
		return "", "", false, fmt.Errorf("invalid key %q", key)
	}

	value = strings.TrimSpace(right)
	switch {
	case len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"':
		unquoted, unquoteErr := strconv.Unquote(value)
		if unquoteErr != nil {
			return "", "", false, fmt.Errorf("unquote %s: %w", key, unquoteErr)
		}
		value = unquoted
	case len(value) >= 2 && value[0] == '\'' && value[len(value)-1] == '\'':
		value = value[1 : len(value)-1]
	default:
		value = trimInlineComment(value)
	}

	return key, value, true, nil
}

func validKey(key string) bool {
	if key == "" {
		return false
	}
	for i, r := range key {
		switch {
		case r == '_' || unicode.IsLetter(r):
			if i == 0 {
				continue
			}
		case i > 0 && unicode.IsDigit(r):
			continue
		default:
			return false
		}
	}
	return true
}

func trimInlineComment(value string) string {
	inSpace := false
	for i, r := range value {
		switch {
		case r == '#':
			if i == 0 || inSpace {
				return strings.TrimSpace(value[:i])
			}
		case unicode.IsSpace(r):
			inSpace = true
		default:
			inSpace = false
		}
	}
	return strings.TrimSpace(value)
}
