/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+Alt+O)
 * - Provides a `subagent_done` tool for autonomous agents to self-terminate
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createSubagentActivityRecorder } from "./activity.ts";

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

export function shouldAutoExitOnAgentEnd(
  _userTookOver: boolean,
  messages: any[] | undefined,
): boolean {
  // Manual input should not strand an auto-exit subagent. If the latest agent
  // turn completed normally, close the session. Escape/abort still leaves it
  // open for inspection or another prompt.
  //
  // stopReason: "error" (e.g. exhausted retries on a provider overload) also
  // returns true — we want to shut down so the parent is woken up — but we
  // pair this with findLatestAssistantError() so the parent learns it was an
  // error, not a clean completion.
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return msg.stopReason !== "aborted";
      }
    }
  }

  return true;
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (handled separately by shouldAutoExitOnAgentEnd).
 */
export function findLatestAssistantError(
  messages: any[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Answer sidecar written by the parent orchestration when it resolves an ask. */
export interface AskAnswerPayload {
  text?: string;
}

export type AskOutcome =
  | { ok: true; text: string }
  | { ok: false; reason: "cancelled" | "timeout" };

/** Poll interval for the answer sidecar. */
export const ASK_POLL_INTERVAL_MS = 250;

/**
 * Ceiling for a blocked ask.
 *
 * ponytail: a blocked tool call has no natural bound, so if the parent session
 * dies (or its watcher is aborted) while a child is waiting, the child would
 * block until its pane is killed. Bound it and resume the agent loop with an
 * explicit failure instead. Raise it if legitimately long human waits are needed.
 */
export const ASK_MAX_WAIT_MS = 30 * 60 * 1000;

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

/**
 * Block until the parent writes an answer sidecar, the tool is aborted, or the
 * wait ceiling is hit. The sidecar is consumed so a later ask cannot replay a
 * stale answer.
 */
export async function waitForAnswer(
  sessionFile: string,
  signal?: AbortSignal,
  timeoutMs: number = ASK_MAX_WAIT_MS,
): Promise<AskOutcome> {
  const answerFile = `${sessionFile}.answer`;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (signal?.aborted) return { ok: false, reason: "cancelled" };

    if (existsSync(answerFile)) {
      let text = "(the parent sent an empty answer)";
      try {
        const parsed = JSON.parse(readFileSync(answerFile, "utf8")) as AskAnswerPayload;
        if (typeof parsed?.text === "string" && parsed.text.trim() !== "") {
          text = parsed.text;
        }
      } catch {
        // Unparseable: fall back to the placeholder rather than blocking forever.
      }
      removeQuietly(answerFile);
      return { ok: true, text };
    }

    if (Date.now() >= deadline) return { ok: false, reason: "timeout" };

    await new Promise<void>((resolve) => setTimeout(resolve, ASK_POLL_INTERVAL_MS));
  }
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+Alt+O to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+Alt+O to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let userTookOver = false;
  let agentStarted = false;
  let awaitingAnswer = false;

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    recorder.sessionStart();
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx, null);
  });

  pi.on("input", () => {
    recorder.input();
    awaitingAnswer = false;
    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover.
    if (!shouldMarkUserTookOver(agentStarted)) return;
    userTookOver = true;
  });

  pi.on("before_agent_start", () => {
    recorder.beforeAgentStart();
  });

  pi.on("agent_start", () => {
    agentStarted = true;
    awaitingAnswer = false;
    recorder.agentStart();
  });

  pi.on("agent_end", (event, ctx) => {
    const messages = (event as any).messages as any[] | undefined;
    const shouldExit =
      !awaitingAnswer && autoExit && shouldAutoExitOnAgentEnd(userTookOver, messages);

    if (shouldExit) {
      // Surface stopReason: "error" turns (auto-retry exhausted, provider
      // overload, etc.) to the parent via the .exit sidecar so the watcher
      // can report a clear failure with the underlying error message.
      // Without this the parent would only see exit code 0 and a stale
      // assistant message, mistaking the crash for a successful completion.
      const errorInfo = findLatestAssistantError(messages);
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (errorInfo && sessionFile) {
        try {
          writeFileSync(
            `${sessionFile}.exit`,
            JSON.stringify({
              type: "error",
              errorMessage: errorInfo.errorMessage,
              stopReason: errorInfo.stopReason,
            }),
          );
        } catch {
          // Best effort — even without the sidecar, watcher's session-file
          // fallback can still recover the errorMessage.
        }
      }

      recorder.agentEndDone();
      ctx.shutdown();
      return;
    }

    recorder.agentEndWaiting();
    if (autoExit) {
      // Reset any recorded manual input marker. Auto-exit is decided by whether
      // the latest agent turn completed normally, not by who initiated it.
      userTookOver = false;
    }
  });

  pi.on("turn_start", (event) => {
    recorder.turnStart((event as any).turnIndex);
  });

  pi.on("turn_end", (event) => {
    recorder.turnEnd((event as any).turnIndex);
  });

  pi.on("before_provider_request", () => {
    recorder.beforeProviderRequest();
  });

  pi.on("after_provider_response", () => {
    recorder.afterProviderResponse();
  });

  pi.on("message_update", (event) => {
    recorder.messageUpdate((event as any).assistantMessageEvent?.type);
  });

  pi.on("tool_execution_start", (event) => {
    recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_call", (event) => {
    recorder.toolCall((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_end", (event) => {
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("session_shutdown", (event) => {
    recorder.sessionShutdown((event as any).reason);
  });

  // Toggle expand/collapse with Ctrl+Alt+O (Ctrl+J is pi's built-in newline binding)
  pi.registerShortcut("ctrl+alt+o", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  pi.registerTool({
    name: "ask_question",
    label: "Ask Question",
    description:
      "Ask the parent orchestrator one question and BLOCK until it answers. " +
      "Use this instead of guessing when requirements or decisions are unclear. " +
      "The answer is returned as this tool's result, so do not repeat the question " +
      "and do not call subagent_done while waiting.",
    parameters: Type.Object({
      question: Type.String({ description: "The single question to ask the orchestrator" }),
      details: Type.Optional(
        Type.String({ description: "Optional extra context shown under the question" }),
      ),
      options: Type.Optional(
        Type.Array(
          Type.Object({
            label: Type.String({ description: "Display label for this choice" }),
            value: Type.Optional(
              Type.String({ description: "Optional value returned instead of the label" }),
            ),
            description: Type.Optional(
              Type.String({ description: "Optional extra detail shown below the option" }),
            ),
          }),
          {
            description:
              "Optional multiple-choice options. The parent can pick one directly, " +
              "which is faster and more reliable than a free-text answer.",
          },
        ),
      ),
      multiSelect: Type.Optional(
        Type.Boolean({
          description:
            "Set to true to let the parent pick several options. The answer lists " +
            "every pick. Ignored when no options are given.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "ask_question is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      const askFile = `${sessionFile}.ask`;
      const options = Array.isArray(params.options)
        ? params.options.filter((option: any) => option && typeof option.label === "string")
        : undefined;
      const multiSelect = options && options.length > 0 ? params.multiSelect === true : undefined;

      awaitingAnswer = true;
      recorder.askQuestion();
      // Never consume a leftover answer from an earlier ask.
      removeQuietly(`${sessionFile}.answer`);
      removeQuietly(`${askFile}.sent`);
      writeFileSync(
        askFile,
        JSON.stringify({
          name: process.env.PI_SUBAGENT_NAME ?? "subagent",
          agent: process.env.PI_SUBAGENT_AGENT ?? "",
          question: params.question,
          details: params.details,
          options,
          multiSelect,
        }),
      );

      const outcome = await waitForAnswer(sessionFile, signal);

      awaitingAnswer = false;
      removeQuietly(askFile);
      removeQuietly(`${askFile}.sent`);

      if (!outcome.ok) {
        const text =
          outcome.reason === "timeout"
            ? "No answer arrived before the wait ceiling; the parent may no longer be running. " +
              "Continue with the best assumption available and state it in your summary."
            : "The parent cancelled the question. Continue with the best assumption available " +
              "and state it in your summary.";
        return {
          content: [{ type: "text", text }],
          details: { question: params.question, answered: false, reason: outcome.reason },
        };
      }

      return {
        content: [{ type: "text", text: `Answer from the parent: ${outcome.text}` }],
        details: { question: params.question, answered: true, answer: outcome.text },
      };
    },

    renderCall(args, theme) {
      const options = Array.isArray((args as any).options) ? (args as any).options : [];
      let text =
        theme.fg("toolTitle", theme.bold("ask_question ")) +
        theme.fg("muted", String((args as any).question ?? ""));
      if (options.length > 0) {
        const labels = options.map((option: any) => String(option?.label ?? "")).join(", ");
        const suffix = (args as any).multiSelect ? " [multi-select]" : "";
        text += `\n${theme.fg("dim", `  Options${suffix}: ${labels}`)}`;
      }
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description:
      "Send a help request to the parent agent and exit this session. " +
      "The parent will be notified with your message and can resume this session with a response. " +
      "Use when you're stuck, need clarification, or need the parent to take action.",
    parameters: Type.Object({
      message: Type.String({ description: "What you need help with" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "caller_ping is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      recorder.callerPing();
      const exitData = {
        type: "ping" as const,
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        message: params.message,
      };
      writeFileSync(`${sessionFile}.exit`, JSON.stringify(exitData));

      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Ping sent. Session will exit and parent will be notified." }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description:
      "Call this tool when you have completed your task. " +
      "It will close this session and return your results to the main session. " +
      "Your LAST assistant message before calling this becomes the summary returned to the caller.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      recorder.subagentDone();
      if (sessionFile) {
        writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
      }
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Shutting down subagent session." }],
        details: {},
      };
    },
  });
}
