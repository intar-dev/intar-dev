export function temporaryNativeSshKeyFilename(routeUsername: string) {
  const route = routeUsername
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return `intar-${route || "temporary-route"}.key`;
}

export function buildTemporaryNativeSshCommand(input: {
  username: string;
  host: string;
  port: number;
  knownHostsLine: string;
  keyFilename: string;
}) {
  const port = input.port === 22 ? "" : ` -p ${input.port}`;
  return [
    "(",
    `  key_path="$HOME/Downloads/${input.keyFilename}"`,
    '  known_hosts_file="$(mktemp)"',
    `  trap 'rm -f "$known_hosts_file"' EXIT`,
    '  chmod 600 "$key_path"',
    `  printf '%s\\n' ${shellQuote(input.knownHostsLine)} > "$known_hosts_file"`,
    `  ssh -i "$key_path" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$known_hosts_file"${port} ${shellQuote(`${input.username}@${input.host}`)}`,
    ")",
  ].join("\n");
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
