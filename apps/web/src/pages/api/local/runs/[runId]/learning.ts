import type { APIRoute } from "astro";
import { localRunLearningRequest } from "@/lib/desktop-channel";

export const prerender = false;

export const GET: APIRoute = ({ request, params }) =>
  localRunLearningRequest(request, params.runId ?? "", "read");
