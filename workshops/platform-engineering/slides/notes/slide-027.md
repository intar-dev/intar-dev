The digest-pinned rule is the first platform-engineering lesson of the day: external dependencies must be explicit, immutable, and observable. Digest pins prevent tag drift; they do not pretend DNS, TLS, registries, or provider egress have disappeared.

Concretely: the Intar checkpoint bootstrap validates every pinned image against its external registry; the git server then lives in-cluster and Argo CD never points at GitHub. Uncached or restored generations still require working registry egress, and the browser session still requires Intar connectivity.

Capacity honesty: this revision pins one CPX42 per learner. Its 16 GiB RAM covers the roughly 7.5–8 GiB in-cluster workload plus Talos, Docker, and operating-system headroom. Intar blocks provisioning if the pinned type, price, quota, or required location is unavailable; never resize or substitute it silently.
