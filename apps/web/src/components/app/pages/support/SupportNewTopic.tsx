import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { SupportTopic } from "@/lib/support-types";
import { PageShell } from "../../patterns/PageShell";
import { usePageChrome } from "../../shell/page-chrome";
import { supportRequest, TopicForm } from "./support-ui";

export function SupportNewTopic() {
  const client = useQueryClient();
  const navigate = useNavigate();
  usePageChrome({ title: "New topic" });
  return (
    <PageShell>
      <div className="w-full max-w-3xl">
        <TopicForm
          onCancel={() => void navigate({ to: "/support" })}
          onSave={async (input) => {
            const { topic } = await supportRequest<{ topic: SupportTopic }>(
              "",
              "POST",
              input,
            );
            await client.invalidateQueries({ queryKey: ["support"] });
            await navigate({
              to: "/support/$topicId",
              params: { topicId: topic.id },
            });
          }}
        />
      </div>
    </PageShell>
  );
}
