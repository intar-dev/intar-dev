import type { APIRoute } from "astro";
import { localLectureRequest } from "@/lib/desktop-channel";

export const prerender = false;

export const GET: APIRoute = ({ request, params }) =>
  localLectureRequest(request, params.courseId ?? "", params.lectureId ?? "", "read");
