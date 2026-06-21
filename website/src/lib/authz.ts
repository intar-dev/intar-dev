type RoleSubject = { role?: string | null | undefined } | null | undefined;

export function getUserRole(user: RoleSubject): string | null {
  const role = user?.role;
  if (typeof role !== "string") {
    return null;
  }

  const normalizedRole = role.trim();
  if (!normalizedRole) {
    return null;
  }

  return normalizedRole;
}

export function isAdminRole(role: string | null | undefined): boolean {
  return role === "admin";
}

export function isAdminUser(user: RoleSubject): boolean {
  return isAdminRole(getUserRole(user));
}
