import { jsonResponse } from "@/lib/agent-bridge";
import { readSupportBody, supportRoute } from "@/lib/support-api";
import { deleteSupportComment, updateSupportComment } from "@/lib/support";

export const prerender = false;
export const PATCH = supportRoute(async ({ params, request }, actor) =>
  jsonResponse({
    comment: await updateSupportComment(
      actor,
      params.topicId!,
      params.commentId!,
      await readSupportBody(request),
    ),
  }),
);
export const DELETE = supportRoute(async ({ params }, actor) => {
  await deleteSupportComment(actor, params.topicId!, params.commentId!);
  return new Response(null, { status: 204 });
});
