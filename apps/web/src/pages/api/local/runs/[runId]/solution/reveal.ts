import type { APIRoute } from "astro";
import { localRunLearningRequest } from "@/lib/desktop-channel";

export const prerender = false;

export const POST: APIRoute = ({ request, params }) =>
  localRunLearningRequest(request, params.runId ?? "", "solution");
