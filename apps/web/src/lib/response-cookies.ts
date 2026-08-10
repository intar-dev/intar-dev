export function copySetCookies(source: Headers, target: Headers): void {
  const cookies = source.getSetCookie();
  if (cookies.length > 0) {
    for (const cookie of cookies) target.append("set-cookie", cookie);
    return;
  }
  const combined = source.get("set-cookie");
  if (combined) target.append("set-cookie", combined);
}
