import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Config } from "../config.ts";
import { aborted, type Brain, type TurnOut } from "./brain.ts";
import { systemPrompt } from "./prompt.ts";
import type { Topic } from "./router.ts";
import { TOOLS, runTool, type ToolContext } from "./tools.ts";

/**
 * Brain on the Claude API (pay per token, lowest latency, no process to keep
 * warm). Each topic has its own message history, trimmed to the last N turns.
 */
export class ApiBrain implements Brain {
  private client = new Anthropic();
  private histories = new Map<string, Anthropic.MessageParam[]>();
  private tools: Anthropic.Tool[] = TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: z.toJSONSchema(t.schema) as Anthropic.Tool.InputSchema,
    eager_input_streaming: true,
  }));
  private system: string;
  private cfg: Config["brain"];
  private ctx: ToolContext;

  constructor(cfg: Config["brain"], ctx: ToolContext, audioTags: boolean) {
    this.cfg = cfg;
    this.ctx = ctx;
    this.system = systemPrompt({ audioTags, projects: ctx.hub.projects, owner: cfg.owner });
  }

  async warm(): Promise<void> {
    /* Nothing to spawn. The prompt is under the minimum cacheable size, so no cache priming either. */
  }

  forget(topicId: string): void {
    this.histories.delete(topicId);
  }

  close(): void {
    // Nothing to release: requests are per turn.
  }

  async turn(topic: Topic, input: string, out: TurnOut, signal: AbortSignal): Promise<void> {
    const history = this.histories.get(topic.id) ?? [];
    const messages: Anthropic.MessageParam[] = [...history, { role: "user", content: input }];

    for (let step = 0; step < 8 && !signal.aborted; step++) {
      const stream = this.client.messages.stream(
        {
          model: this.cfg.model,
          max_tokens: 4096,
          system: this.system,
          tools: this.tools,
          output_config: { effort: this.cfg.effort },
          cache_control: { type: "ephemeral" },
          messages,
        },
        { signal },
      );
      stream.on("text", (t) => out.text(t));
      stream.on("streamEvent", (e) => {
        if (e.type === "content_block_start" && e.content_block.type === "tool_use") out.tool?.(e.content_block.name);
      });
      let msg: Anthropic.Message;
      try {
        msg = await stream.finalMessage();
      } catch (e) {
        if (aborted(signal)) break;
        throw e;
      }
      messages.push({ role: "assistant", content: msg.content });
      if (msg.stop_reason === "refusal" || msg.stop_reason === "max_tokens") break;
      if (msg.stop_reason !== "tool_use") break;

      const calls = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const results = await Promise.all(
        calls.map(async (c): Promise<Anthropic.ToolResultBlockParam> => {
          const out = await runTool(c.name, c.input, this.ctx);
          return {
            type: "tool_result",
            tool_use_id: c.id,
            content: out,
            is_error: /^(Invalid input|Failed|Unknown tool)/.test(out),
          };
        }),
      );
      messages.push({ role: "user", content: results });
    }

    // An interrupted turn can end on an unanswered tool_use; drop it so the next request is valid.
    for (let last = messages.at(-1); last && endsWithToolUse(last); last = messages.at(-1)) messages.pop();
    this.histories.set(topic.id, trim(messages, this.cfg.historyTurns));
  }
}

function endsWithToolUse(m: Anthropic.MessageParam): boolean {
  return m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use");
}

const isUserText = (m: Anthropic.MessageParam) =>
  m.role === "user" && (typeof m.content === "string" || !m.content.some((b) => b.type === "tool_result"));

/** Keep the last `turns` user turns, cutting only at a plain user message. */
export function trim(messages: Anthropic.MessageParam[], turns: number): Anthropic.MessageParam[] {
  const starts = messages.map((m, i) => (isUserText(m) ? i : -1)).filter((i) => i >= 0);
  if (starts.length <= turns) return messages;
  return messages.slice(starts[starts.length - turns]);
}
