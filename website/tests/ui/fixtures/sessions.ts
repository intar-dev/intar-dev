export type SessionRole =
  | "anonymous"
  | "learner"
  | "team-member"
  | "instructor"
  | "owner"
  | "global-admin";

export interface MockSession {
  session: {
    id: string;
    userId: string;
    expiresAt: string;
    createdAt: string;
    updatedAt: string;
    token: string;
  };
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    image: string | null;
    createdAt: string;
    updatedAt: string;
    username: string;
    displayUsername: string;
    role: "user" | "admin";
    banned: boolean;
    banReason: string | null;
    banExpires: string | null;
  };
}

const expiresAt = "2027-07-10T09:00:00.000Z";
const createdAt = "2026-01-12T09:00:00.000Z";
const updatedAt = "2026-07-09T18:00:00.000Z";

function session(
  id: string,
  name: string,
  username: string,
  role: "user" | "admin" = "user",
): MockSession {
  return {
    session: {
      id: `session-${id}`,
      userId: `user-${id}`,
      expiresAt,
      createdAt,
      updatedAt,
      token: `test-only-${id}`,
    },
    user: {
      id: `user-${id}`,
      name,
      email: `${username}@example.test`,
      emailVerified: true,
      image: null,
      createdAt,
      updatedAt,
      username,
      displayUsername: username,
      role,
      banned: false,
      banReason: null,
      banExpires: null,
    },
  };
}

export const SESSION_FIXTURES: Record<
  Exclude<SessionRole, "anonymous">,
  MockSession
> = {
  learner: session("learner", "Mina Learner", "minalearns"),
  "team-member": session("member", "Sam Operator", "samops"),
  instructor: session("instructor", "Inez Instructor", "inezinfra"),
  owner: session("owner", "Owen Owner", "owenowns"),
  "global-admin": session(
    "admin",
    "Ada Administrator",
    "adaadmin",
    "admin",
  ),
};

export function sessionFor(role: SessionRole): MockSession | null {
  return role === "anonymous" ? null : structuredClone(SESSION_FIXTURES[role]);
}
