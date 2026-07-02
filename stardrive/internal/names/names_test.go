package names

import (
	"strings"
	"testing"
)

func TestSlugify(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{name: "empty", input: "", want: ""},
		{name: "whitespace only", input: "   ", want: ""},
		{name: "lowercases", input: "Production", want: "production"},
		{name: "trims surrounding whitespace", input: "  prod  ", want: "prod"},
		{name: "replaces spaces with dashes", input: "my cluster", want: "my-cluster"},
		{name: "collapses consecutive separators", input: "my -- cluster", want: "my-cluster"},
		{name: "strips leading and trailing separators", input: "-my-cluster-", want: "my-cluster"},
		{name: "keeps digits", input: "cluster 01", want: "cluster-01"},
		{name: "replaces symbols", input: "a_b.c/d", want: "a-b-c-d"},
		{name: "keeps unicode letters", input: "über cluster", want: "über-cluster"},
		{name: "only symbols", input: "!!!", want: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Slugify(tt.input); got != tt.want {
				t.Fatalf("Slugify(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestHashSuffix(t *testing.T) {
	full := HashSuffix("value", 0)
	if len(full) != 40 {
		t.Fatalf("expected full sha1 hex length 40, got %d", len(full))
	}

	tests := []struct {
		name    string
		value   string
		size    int
		wantLen int
	}{
		{name: "truncates to size", value: "value", size: 8, wantLen: 8},
		{name: "zero size returns full hash", value: "value", size: 0, wantLen: 40},
		{name: "negative size returns full hash", value: "value", size: -1, wantLen: 40},
		{name: "size beyond hash length returns full hash", value: "value", size: 100, wantLen: 40},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := HashSuffix(tt.value, tt.size)
			if len(got) != tt.wantLen {
				t.Fatalf("HashSuffix(%q, %d) length = %d, want %d", tt.value, tt.size, len(got), tt.wantLen)
			}
			if !strings.HasPrefix(full, got) {
				t.Fatalf("HashSuffix(%q, %d) = %q is not a prefix of the full hash %q", tt.value, tt.size, got, full)
			}
		})
	}

	if HashSuffix("a", 8) == HashSuffix("b", 8) {
		t.Fatalf("expected different inputs to produce different hashes")
	}
}
