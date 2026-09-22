import { jsonResponse } from "@/lib/agent-bridge";
import { readSupportBody, supportRoute } from "@/lib/support-api";
import { createSupportTopic, listSupportTopics } from "@/lib/support";
import { validateSupportSearch } from "@/lib/support-types";

export const prerender = false;
export const GET = supportRoute(async ({ url }, actor) =>
  jsonResponse(
    await listSupportTopics(
      actor,
      validateSupportSearch(Object.fromEntries(url.searchParams)),
    ),
  ),
);
export const POST = supportRoute(async ({ request }, actor) =>
  jsonResponse(
    { topic: await createSupportTopic(actor, await readSupportBody(request)) },
    { status: 201 },
  ),
);
