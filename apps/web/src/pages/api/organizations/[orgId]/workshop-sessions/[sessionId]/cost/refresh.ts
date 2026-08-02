import type { APIRoute } from "astro";
import { handleWorkshopCostRequest } from "../cost";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) =>
  handleWorkshopCostRequest(request, params, true);
