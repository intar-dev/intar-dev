package infisical

import "testing"

func TestSplitSecretPath(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		path       string
		wantParent string
		wantName   string
	}{
		{
			name:       "root child",
			path:       "/stardrive",
			wantParent: "/",
			wantName:   "stardrive",
		},
		{
			name:       "nested path",
			path:       "/stardrive/clusters/prod/runtime",
			wantParent: "/stardrive/clusters/prod",
			wantName:   "runtime",
		},
		{
			name:       "relative path",
			path:       "stardrive/clusters/prod",
			wantParent: "/stardrive/clusters",
			wantName:   "prod",
		},
		{
			name:       "root",
			path:       "/",
			wantParent: "/",
			wantName:   "",
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			parent, name := splitSecretPath(tt.path)
			if parent != tt.wantParent || name != tt.wantName {
				t.Fatalf("splitSecretPath(%q) = (%q, %q), want (%q, %q)", tt.path, parent, name, tt.wantParent, tt.wantName)
			}
		})
	}
}
