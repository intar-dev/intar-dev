import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { FileArchive } from "lucide-react";
import { InlineFeedback } from "../../patterns/InlineFeedback";
import { Section } from "../../patterns/Section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { OrganizationDetailResponse } from "./types";

type Detail = OrganizationDetailResponse["organization"];

/** CLI bundles are allowed. Browser HCL draft authoring is not. */
export function OrganizationBundleUpload({ detail }: { detail: Detail }) {
  const [bundle, setBundle] = useState<File | null>(null);
  const [metadata, setMetadata] = useState("");
  const upload = useMutation({
    mutationFn: async () => {
      if (!bundle || !metadata.trim()) {
        throw new Error("Choose a bundle archive and paste its metadata JSON.");
      }
      const form = new FormData();
      form.set("meta", metadata);
      form.set("bundle", bundle);
      const response = await fetch(
        `/api/organizations/${encodeURIComponent(detail.id)}/scenarios/bundles`,
        { method: "POST", credentials: "include", body: form },
      );
      const body = (await response.json().catch(() => null)) as {
        rev?: string;
        queued?: number;
        error?: string;
      } | null;
      if (!response.ok || !body?.rev) {
        throw new Error(body?.error ?? `Bundle upload failed (${response.status})`);
      }
      return body;
    },
    onSuccess: () => {
      setBundle(null);
      setMetadata("");
    },
  });

  if (detail.role === "member") return null;
  return (
    <Section
      density="compact"
      title="Upload a course bundle"
      description="Upload a bundle made by the image CLI. Browser HCL editing is not available."
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)]">
        <label className="flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/30 p-6 text-center">
          <FileArchive className="size-6 text-brand-text" aria-hidden />
          <span className="text-support font-medium">
            {bundle?.name ?? "Choose .tar.gz bundle"}
          </span>
          <Input
            type="file"
            accept=".tar.gz,.tgz,application/gzip"
            className="sr-only"
            onChange={(event) => setBundle(event.target.files?.[0] ?? null)}
          />
        </label>
        <Textarea
          value={metadata}
          onChange={(event) => setMetadata(event.target.value)}
          placeholder="Paste the bundle metadata JSON from the image CLI."
          className="min-h-32 text-code"
          aria-label="Bundle metadata JSON"
        />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          disabled={!bundle || !metadata.trim() || upload.isPending}
          onClick={() => upload.mutate()}
        >
          <FileArchive className="size-4" />
          {upload.isPending ? "Uploading…" : "Upload and queue"}
        </Button>
        {upload.data ? (
          <InlineFeedback tone="success">
            Bundle {upload.data.rev} queued ({upload.data.queued ?? 0} image job(s)).
          </InlineFeedback>
        ) : null}
        {upload.error ? (
          <InlineFeedback tone="error">
            {upload.error instanceof Error ? upload.error.message : "Bundle upload failed."}
          </InlineFeedback>
        ) : null}
      </div>
    </Section>
  );
}
