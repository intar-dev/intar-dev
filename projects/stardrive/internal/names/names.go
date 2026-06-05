package names

import (
	"crypto/sha1"
	"encoding/hex"
	"strings"
	"unicode"
)

func Slugify(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		return ""
	}

	var out strings.Builder
	lastDash := false

	for _, r := range value {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			out.WriteRune(r)
			lastDash = false
		default:
			if !lastDash {
				out.WriteByte('-')
				lastDash = true
			}
		}
	}

	return strings.Trim(out.String(), "-")
}

func HashSuffix(value string, size int) string {
	sum := sha1.Sum([]byte(value))
	encoded := hex.EncodeToString(sum[:])
	if size <= 0 || size >= len(encoded) {
		return encoded
	}
	return encoded[:size]
}
