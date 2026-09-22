import { jsonResponse } from "@/lib/agent-bridge";
import { readSupportBody, supportRoute } from "@/lib/support-api";
import {
  deleteSupportTopic,
  getSupportTopic,
  updateSupportTopic,
} from "@/lib/support";

export const prerender = false;
export const GET = supportRoute(async ({ params }, actor) =>
  jsonResponse({ topic: await getSupportTopic(actor, params.topicId!) }),
);
export const PATCH = supportRoute(async ({ params, request }, actor) =>
  jsonResponse({
    topic: await updateSupportTopic(
      actor,
      params.topicId!,
      await readSupportBody(request),
    ),
  }),
);
export const DELETE = supportRoute(async ({ params }, actor) => {
  await deleteSupportTopic(actor, params.topicId!);
  return new Response(null, { status: 204 });
});
