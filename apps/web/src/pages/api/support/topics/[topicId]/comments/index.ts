import { jsonResponse } from "@/lib/agent-bridge";
import { readSupportBody, supportRoute } from "@/lib/support-api";
import { createSupportComment, listSupportComments } from "@/lib/support";

export const prerender = false;
export const GET = supportRoute(async ({ params, url }, actor) =>
  jsonResponse(
    await listSupportComments(
      actor,
      params.topicId!,
      url.searchParams.get("page"),
    ),
  ),
);
export const POST = supportRoute(async ({ params, request }, actor) =>
  jsonResponse(
    {
      comment: await createSupportComment(
        actor,
        params.topicId!,
        await readSupportBody(request),
      ),
    },
    { status: 201 },
  ),
);
