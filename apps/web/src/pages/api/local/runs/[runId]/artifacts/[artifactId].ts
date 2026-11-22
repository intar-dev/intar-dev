import type { APIRoute } from "astro";
import { localRunArtifactRequest } from "@/lib/desktop-channel";

export const prerender = false;

export const GET: APIRoute = ({ request, params }) =>
  localRunArtifactRequest(request, params.runId, params.artifactId);
