export function parseDirectCliJsonOutput(stdout: string, providerName: string): { status?: "completed" | "failed"; summary: string } {
  let summary = "";
  let completed = false;
  let failed = false;
  for (const line of stdout.split(/\r?\n/)) {
    const value = line.trim();
    if (!value.startsWith("{")) continue;
    try {
      const event = JSON.parse(value) as {
        type?: string;
        role?: string;
        content?: string | Array<{ type?: string; text?: string }>;
        item?: { type?: string; text?: string };
        part?: { type?: string; text?: string };
        result?: string;
        status?: string;
        message?: unknown;
        error?: unknown;
      };
      if (event.error || event.type === "error") {
        failed = true;
        summary = directCliErrorMessage(event.error) || directCliErrorMessage(event.message) || value;
      }
      if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
        summary = event.item.text;
      }
      if (event.type === "text" && event.part?.type === "text" && event.part.text) {
        summary = event.part.text;
      }
      const messageText = contentText(event.content);
      if (event.type === "message" && event.role === "assistant" && messageText) {
        summary = event.status === "success" ? messageText : `${summary}${messageText}`;
      }
      if (event.type === "result") {
        if (event.result) summary = event.result;
        completed = /^(success|completed)$/i.test(String(event.status ?? "success"));
        failed ||= /^(error|failed|failure)$/i.test(String(event.status ?? ""));
      }
    } catch {
      continue;
    }
  }
  if (failed) return { status: "failed", summary: summary || `${providerName} failed` };
  if (completed || summary) return { status: "completed", summary: summary || `${providerName} completed` };
  return { summary };
}

export function directCliErrorMessage(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return jsonMessage(value) || value;
  if (typeof value !== "object") return String(value);

  const record = value as {
    name?: unknown;
    message?: unknown;
    data?: { message?: unknown };
  };
  return directCliErrorMessage(record.data?.message) || directCliErrorMessage(record.message) || (record.name ? String(record.name) : "");
}

function jsonMessage(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return "";
  try {
    return directCliErrorMessage(JSON.parse(trimmed));
  } catch {
    return "";
  }
}

/**
 * Flattens a Claude/Anthropic-style `content` field (string or text-part array)
 * into a single newline-joined string. Exported so other provider runners can
 * share one canonical decoder rather than each shipping a near-identical copy.
 */
export function contentText(content: string | Array<{ type?: string; text?: string }> | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part.type === "text" ? part.text ?? "" : "").filter(Boolean).join("\n");
}
