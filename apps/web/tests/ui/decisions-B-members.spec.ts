import { day } from "./fixtures/data/shared";
import { FIXED_NOW } from "./fixtures/data";
import { expect, test } from "./fixtures/test";
import { routeCase } from "./routes";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test("member and removed-member rows fade the photo in over the initials", async ({
  page,
  ui,
}) => {
  await page.route("https://img.test/**", (route) =>
    route.fulfill({ contentType: "image/png", body: onePixelPng }),
  );
  await page.route("**/api/organizations/org-platform", (route) => {
    const detail = ui.server.state.organizationDetail as {
      members: Array<{ userId: string }>;
    };
    return route.fulfill({
      json: {
        organization: {
          ...detail,
          members: detail.members.map((entry) =>
            entry.userId === "user-learner"
              ? { ...entry, image: "https://img.test/mina.png" }
              : entry,
          ),
          removedMembers: [
            {
              userId: "user-removed",
              name: "Rita Removed",
              email: "rita@platform.example",
              githubUsername: null,
              image: "https://img.test/rita.png",
              removedAt: FIXED_NOW - day,
            },
          ],
        },
      },
    });
  });
  await ui.open({
    ...routeCase("organization-detail"),
    path: "/organizations/org-platform?tab=people",
  });

  const mina = page.locator("li", { hasText: "Mina Learner" });
  await expect(mina.locator('[data-slot="avatar-image"]')).toBeVisible();
  // The initials stay mounted under the photo.
  await expect(mina.locator('[data-slot="avatar-fallback"]')).toHaveCount(1);
  // Members without a photo keep initials only.
  const owen = page.locator("li", { hasText: "Owen Owner" });
  await expect(owen.locator('[data-slot="avatar-image"]')).toHaveCount(0);
  await expect(owen.locator('[data-slot="avatar-fallback"]')).toHaveText("O");

  const rita = page.locator("li", { hasText: "Rita Removed" });
  await expect(rita.locator('[data-slot="avatar-image"]')).toBeVisible();
});
