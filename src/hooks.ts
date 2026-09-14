import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { fileURLToPath } from "node:url";
import { realpath } from "node:fs/promises";
import { type QuestionKind, StateStore } from "./state.js";

// Question/idle lifecycle handling draws on OMC/OMX MIT sources; project notices carry attribution.
const kinds = new Set<QuestionKind>([
  "requirement",
  "continuation",
  "confirmation",
  "closure",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function questionEvent(
  event: unknown,
  type: "question.asked" | "question.replied" | "question.rejected",
) {
  const candidate = record(event);
  if (candidate?.type !== type) return undefined;
  const properties = record(candidate.properties);
  if (!properties || typeof properties.sessionID !== "string") return undefined;
  if (type === "question.asked")
    return typeof properties.id === "string"
      ? {
          sessionID: properties.sessionID,
          requestID: properties.id,
          callID: record(properties.tool)?.callID,
        }
      : undefined;
  return typeof properties.requestID === "string"
    ? {
        sessionID: properties.sessionID,
        requestID: properties.requestID,
        answers: answers(properties.answers),
      }
    : undefined;
}

function oneQuestion(args: unknown) {
  const input = record(args);
  return Array.isArray(input?.questions) && input.questions.length === 1;
}

function answers(value: unknown): string[][] | undefined {
  if (
    !Array.isArray(value) ||
    !value.every(
      (group) =>
        Array.isArray(group) &&
        group.every((answer) => typeof answer === "string"),
    )
  )
    return undefined;
  return value as string[][];
}

/** Hooks only coordinate native lifecycle signals; they never manufacture replies or restart an unresolved interview. */
export function createHooks(
  store: StateStore,
  client: PluginInput["client"],
): Partial<Hooks> {
  return {
    async "command.execute.before"(input) {
      if (
        input.command !== "deep-interview" &&
        input.command !== "/deep-interview"
      )
        return;
      // The current host exposes source in Command.Info, although the legacy SDK
      // type omits it. Check observed metadata instead of trusting the name:
      // configured commands and MCP prompts can shadow a skill-derived command.
      const commands = await client.command.list({
        query: { directory: store.worktree },
      });
      const command = commands.data?.find(
        (item) => item.name === "deep-interview",
      );
      const skillDirectory = await realpath(
        fileURLToPath(new URL("../skills/deep-interview", import.meta.url)),
      );
      if (
        commands.error ||
        record(command)?.source !== "skill" ||
        !command?.template.endsWith(
          `Base directory for this skill: ${skillDirectory}\nRelative paths in this skill (e.g., scripts/, references/) are relative to this base directory.`,
        )
      )
        throw new Error(
          "deep-interview command ownership is missing or shadowed; inspect native debug skill/command sources",
        );
      const args = input.arguments.trim();
      if (args === "cancel") {
        await store.cancel(input.sessionID);
        return;
      }
      if (
        args === "resume" ||
        args === "resume --confirm-cancelled" ||
        args === "resume --confirm-pending"
      ) {
        const state = await store.read(input.sessionID);
        if (!state) throw new Error("no interview exists to resume");
        const [history, statuses] = await Promise.all([
          client.session.messages({
            path: { id: input.sessionID },
            query: { directory: store.worktree },
          }),
          client.session.status({ query: { directory: store.worktree } }),
        ]);
        if (history.error)
          throw new Error("could not reconcile session history before resume");
        if (
          statuses.error ||
          !statuses.data ||
          (statuses.data[input.sessionID] &&
            statuses.data[input.sessionID].type !== "idle")
        )
          throw new Error("native session is not idle enough to resume safely");
        const pending = state._runtime.pending;
        if (pending) {
          const question = history.data
            ?.flatMap((message) => message.parts)
            .find(
              (part) =>
                part.type === "tool" &&
                part.callID === pending.callId &&
                part.tool === "question",
            );
          if (
            question?.type === "tool" &&
            question.state.status === "completed"
          ) {
            const metadata = record(question.state.metadata);
            const recordedAnswers = answers(metadata?.answers);
            if (recordedAnswers)
              await store.recordQuestionReply(
                input.sessionID,
                pending.requestId,
                recordedAnswers,
              );
          } else if (
            question?.type === "tool" &&
            question.state.status === "error"
          ) {
            await store.interrupt(
              input.sessionID,
              "question tool failed in session history",
              false,
              pending.requestId,
            );
          }
        }
        if (
          state._runtime.inFlight ||
          (state._runtime.questionCallId && !state._runtime.pending)
        ) {
          await store.interrupt(
            input.sessionID,
            "explicit resume reconciled an unresolved prior dispatch",
          );
        }
        const reconciled = await store.read(input.sessionID);
        if (reconciled?._runtime.status !== "active")
          await store.resume(
            input.sessionID,
            args.endsWith("--confirm-cancelled"),
            args.endsWith("--confirm-pending"),
          );
        return;
      }
      if (!args)
        throw new Error(
          "/deep-interview requires a request, resume, or cancel",
        );
      await store.start(input.sessionID, args);
    },

    async "tool.execute.before"(input, output) {
      if (input.tool !== "question") return;
      const state = await store.read(input.sessionID);
      if (!state) return;
      if (
        ["cancelled", "completed", "limit-reached"].includes(
          state._runtime.status,
        )
      )
        return;
      if (!oneQuestion(output.args))
        throw new Error(
          "deep-interview questions must contain exactly one question",
        );
      if (state._runtime.status !== "active" || state._runtime.pending)
        throw new Error(
          "deep-interview cannot issue a duplicate or non-active question",
        );
      const modelKind = state.next_question_kind;
      if (
        typeof modelKind !== "string" ||
        !kinds.has(modelKind as QuestionKind)
      )
        throw new Error("model state must provide a valid next_question_kind");
      await store.recordQuestionIntent(
        input.sessionID,
        modelKind as QuestionKind,
        input.callID,
      );
    },

    async "tool.execute.after"(input, output) {
      if (input.tool !== "question") return;
      const state = await store.read(input.sessionID);
      if (
        !state ||
        state._runtime.status !== "waiting" ||
        state._runtime.pending?.callId !== input.callID
      )
        return;
      const metadata = record(output.metadata);
      // A successful native question tool may cross-check an answer here; absence
      // of this metadata never creates a synthetic reply.
      const recordedAnswers = answers(metadata?.answers);
      if (recordedAnswers)
        await store.recordQuestionReply(
          input.sessionID,
          state._runtime.pending.requestId,
          recordedAnswers,
        );
    },

    async event(input) {
      const asked = questionEvent(input.event, "question.asked");
      if (asked) {
        await store.recordQuestionAsked(
          asked.sessionID,
          asked.requestID,
          typeof asked.callID === "string" ? asked.callID : undefined,
        );
        return;
      }
      const replied = questionEvent(input.event, "question.replied");
      if (replied) {
        await store.recordQuestionReply(
          replied.sessionID,
          replied.requestID,
          "answers" in replied ? replied.answers : undefined,
        );
        return;
      }
      const rejected = questionEvent(input.event, "question.rejected");
      if (rejected) {
        await store.interrupt(
          rejected.sessionID,
          "native question was rejected",
          false,
          rejected.requestID,
        );
        return;
      }

      const event = record(input.event);
      const properties = record(event?.properties);
      if (!event || !properties || typeof properties.sessionID !== "string")
        return;
      if (event.type === "session.error") {
        const state = await store.read(properties.sessionID);
        if (state)
          await store.interrupt(
            properties.sessionID,
            typeof properties.error === "string"
              ? properties.error
              : "native session error",
            true,
          );
        return;
      }
      if (
        event.type !== "session.idle" &&
        !(
          event.type === "session.status" &&
          record(properties.status)?.type === "idle"
        )
      )
        return;

      const active = await store.read(properties.sessionID);
      if (
        !active ||
        active._runtime.status !== "active" ||
        active._runtime.pending ||
        active._runtime.inFlight
      )
        return;
      let history: Awaited<ReturnType<typeof client.session.messages>>;
      let statuses: Awaited<ReturnType<typeof client.session.status>>;
      try {
        [history, statuses] = await Promise.all([
          client.session.messages({
            path: { id: properties.sessionID },
            query: { directory: store.worktree },
          }),
          client.session.status({ query: { directory: store.worktree } }),
        ]);
      } catch {
        await store.interrupt(
          properties.sessionID,
          "native history or status request failed before post-idle continuation",
          true,
        );
        return;
      }
      if ("error" in history && history.error) {
        const state = await store.read(properties.sessionID);
        if (state)
          await store.interrupt(
            properties.sessionID,
            "could not reconcile session history before post-idle continuation",
            true,
          );
        return;
      }
      if ("error" in statuses && statuses.error) {
        await store.interrupt(
          properties.sessionID,
          "could not read native session status before post-idle continuation",
          true,
        );
        return;
      }
      // SessionStatus.list omits idle sessions; only busy/retry are retained.
      if (
        !statuses.data ||
        (statuses.data[properties.sessionID] &&
          statuses.data[properties.sessionID].type !== "idle")
      )
        return;
      const latest = history.data?.at(-1);
      // A missing, errored, or unfinished assistant message is not a valid idle
      // completion and must not be used to resurrect the interview.
      if (
        !latest ||
        latest.info.role !== "assistant" ||
        latest.info.time.completed === undefined
      )
        return;
      if (latest.info.error) {
        await store.interrupt(
          properties.sessionID,
          "latest assistant message was interrupted or errored",
          true,
        );
        return;
      }
      const parentID = latest.info.parentID;
      const parent = history.data?.find(
        (message) => message.info.id === parentID,
      )?.info;
      if (
        !parent ||
        parent.role !== "user" ||
        !parent.agent ||
        !parent.model?.providerID ||
        !parent.model.modelID
      ) {
        await store.interrupt(
          properties.sessionID,
          "cannot verify the current interview agent/model for continuation",
          true,
        );
        return;
      }
      const variant = record(parent.model)?.variant;
      const claim = await store.claimContinuation(
        properties.sessionID,
        latest.info.id,
      );
      if (!claim) return;
      // The state mutation above is complete before the network call. No queue is
      // held while promptAsync is in flight, and a second idle signal sees inFlight.
      const current = await store.read(properties.sessionID);
      if (
        !current ||
        current._runtime.status !== "active" ||
        !current._runtime.inFlight ||
        current._runtime.lastAssistantMessageId !== latest.info.id
      )
        return;
      try {
        const sent = await client.session.promptAsync({
          path: { id: properties.sessionID },
          query: { directory: store.worktree },
          body: {
            agent: parent.agent,
            model: {
              providerID: parent.model.providerID,
              modelID: parent.model.modelID,
            },
            ...(typeof variant === "string" ? { variant } : {}),
            parts: [{ type: "text", text: claim.prompt }],
          },
        });
        if (sent.error)
          await store.settleContinuation(
            properties.sessionID,
            "post-idle promptAsync failed",
          );
        else await store.settleContinuation(properties.sessionID);
      } catch {
        await store.settleContinuation(
          properties.sessionID,
          "post-idle promptAsync threw",
        );
      }
    },
  };
}
