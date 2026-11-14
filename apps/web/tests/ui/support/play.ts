import type { Page } from "@playwright/test";

const PUBLIC_SCENARIO = {
  id: "intar/repair-nginx",
  title: "Repair the nginx front door",
  summary: "Bring a web server back after a bad configuration push.",
  difficulty: "easy",
  minutes: 20,
  credit: "Adapted from a livestream by Example Academy.",
};

/** Serves the play page's API as the server would for this session. */
export async function mockPlayScenario(page: Page, signedIn: boolean) {
  await page.route("**/api/play/intar/repair-nginx", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        signedIn,
        scenario: signedIn
          ? {
              ...PUBLIC_SCENARIO,
              tags: ["nginx", "systemd"],
              briefing:
                "The front door returns **502** after this morning's push.\n\n## What you have\n\n- A shell on `web`\n- The deploy notes in `/srv/notes.md`",
            }
          : PUBLIC_SCENARIO,
      }),
    }),
  );
}

export const PLAY_PATH = "/play/intar/repair-nginx?ref=stream-42";
