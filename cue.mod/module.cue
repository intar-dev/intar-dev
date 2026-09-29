module: "github.com/intar-dev/intar-dev"
language: {
	version: "v0.16.0"
}
// CI evaluates this dependency offline from the layers whose digests
// .github/actions/setup-cuenv pins. Bump both together.
deps: {
	"github.com/cuenv/cuenv@v0": {
		v: "v0.56.7"
	}
}
