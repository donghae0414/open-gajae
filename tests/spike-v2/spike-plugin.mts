// Phase 0 spike plugin for the OpenCode v2 port (plan: .omc/plans/ralplan-opencode-v2-port.md).
// The driver (tests/spike-v2/phase0-probe.ts) copies this file to <disposable>/plugin/src/index.ts,
// writes a root index.ts that re-exports it (P5), and installs @opencode/plugin@2.0.15 there.
// It is kept as .mts so the repo typecheck (which does not depend on @opencode/plugin yet) skips it.
// It only observes and records; it is a first draft for the Step 8 host probes, not product code.
import { Plugin } from "@opencode/plugin";
import { Error as PluginToolError } from "@opencode/plugin/promise/tool";
import { z as zodNew } from "zod";
import { appendFileSync, readFileSync } from "node:fs";
import { relative, sep } from "node:path";

type Json = Record<string, unknown>;

const config = JSON.parse(
  readFileSync(new URL("../spike-config.json", import.meta.url), "utf8"),
) as { log: string; tools: string[]; skillRoot: string };

// Every entry names the plugin instance (one per location) that wrote it.
function write(instance: string, kind: string, data: Json) {
  appendFileSync(config.log, JSON.stringify({ t: Date.now(), kind, instance, ...data }) + "\n");
}

function errorShape(error: any) {
  if (!error || typeof error !== "object") return { value: String(error) };
  return {
    ctor: error.constructor?.name,
    _tag: error._tag,
    message: error.message,
    keys: Object.keys(error),
    innerTag: error.error?._tag,
    innerCtor: error.error?.constructor?.name,
    innerMessage: error.error?.message,
    innerKeys: error.error && typeof error.error === "object" ? Object.keys(error.error) : undefined,
    instanceofPluginToolError: error instanceof PluginToolError,
  };
}

function sessionShape(info: any) {
  if (!info || typeof info !== "object") return info;
  return {
    id: info.id,
    agent: info.agent,
    parentID: info.parentID,
    outcome: info.outcome,
    timeCreated: info.time?.created,
    timeCreatedType: typeof info.time?.created,
    timeCreatedCtor: info.time?.created?.constructor?.name,
    timeCreatedEpoch:
      typeof info.time?.created === "number"
        ? info.time.created
        : typeof info.time?.created?.epochMillis === "number"
          ? info.time.created.epochMillis
          : undefined,
    location: info.location,
    model: info.model,
  };
}

async function withTimeout<T>(label: string, promise: Promise<T>, ms = 10_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export default Plugin.define({
  id: "open-gajae",
  async setup(ctx: any) {
    const log = (kind: string, data: Json) => write(ctx.location.directory, kind, data);
    let resolvedPlugin: string | undefined;
    try {
      resolvedPlugin = import.meta.resolve("@opencode/plugin");
    } catch (error) {
      resolvedPlugin = `resolve failed: ${String(error)}`;
    }
    const plannerPrefix = (() => {
      const rel = relative(ctx.location.directory, ctx.location.project.directory).split(sep).join("/");
      return rel ? `${rel}/` : "";
    })();
    log("setup", {
      location: ctx.location,
      appVersion: ctx.app?.version,
      entry: import.meta.url,
      resolvedPlugin,
      plannerPrefix,
    });

    // P6(a)/(b): agents. spike-planner has no host config (creation from defaults);
    // spike-override is also configured by the host config (model/system/permissions).
    await ctx.agent.transform((editor: any) => {
      const before = editor.get("spike-planner");
      editor.update("spike-planner", (agent: any) => {
        agent.name = "spike-planner";
        agent.description = "Spike planner role";
        agent.mode = "all";
        agent.system = "SPIKE-PLUGIN-SYSTEM planner";
        agent.model = { providerID: "fake", id: "model-a" };
        agent.permissions.push(
          { action: "edit", resource: "*", effect: "deny" },
          { action: "edit", resource: `${plannerPrefix}.open-gajae/_session-*/plans/*`, effect: "allow" },
          { action: "opencode_session_move", resource: "*", effect: "deny" },
          { action: "opencode_session_rename", resource: "*", effect: "deny" },
        );
      });
      const overrideBefore = editor.get("spike-override");
      editor.update("spike-override", (agent: any) => {
        agent.description = "Spike override role";
        agent.mode = "subagent";
        agent.system = "SPIKE-PLUGIN-SYSTEM override";
        agent.model = { providerID: "fake", id: "model-a" };
        agent.permissions.push({ action: "edit", resource: "*", effect: "deny" });
      });
      log("agent-transform", {
        plannerExistedBefore: before !== undefined,
        overrideExistedBefore: overrideBefore !== undefined,
        overrideBefore: overrideBefore
          ? { model: overrideBefore.model, system: overrideBefore.system, permissions: overrideBefore.permissions }
          : undefined,
        plannerAfter: editor.get("spike-planner"),
      });
    });

    // P7: skill ids for mentions.
    await ctx.skill.transform((editor: any) => {
      for (const id of ["ralplan", "deep-interview"])
        editor.add({
          id,
          name: id,
          description: `Spike ${id} skill`,
          path: `${config.skillRoot}/${id}/SKILL.md`,
          content: `SPIKE-SKILL-BODY ${id}`,
        });
    });

    // P4: tool input schema variants.
    await ctx.tool.transform((editor: any) => {
      const execute = (name: string) => async (input: unknown) => ({
        content: `ok:${name}:${JSON.stringify(input)}`,
      });
      if (config.tools.includes("zod_new"))
        editor.add({
          name: "spike_zod_new",
          description: "Spike tool with a zod 4.6 schema",
          input: zodNew.object({ value: zodNew.string() }),
          options: { codemode: false },
          execute: execute("spike_zod_new"),
        });
      if (config.tools.includes("json"))
        editor.add({
          name: "spike_json",
          description: "Spike tool with a plain JSON Schema",
          input: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
          options: { codemode: false },
          execute: execute("spike_json"),
        });
    });
    if (config.tools.includes("zod_old")) {
      // zod 4.1.8 is the copy bundled under @opencode/plugin; it lacks ~standard.jsonSchema.
      const { z: zodOld } = await import("../node_modules/@opencode/plugin/node_modules/zod/index.js" as string);
      await ctx.tool.transform((editor: any) => {
        editor.add({
          name: "spike_zod_old",
          description: "Spike tool with a zod 4.1.8 schema",
          input: zodOld.object({ value: zodOld.string() }),
          options: { codemode: false },
          execute: async (input: unknown) => ({ content: `ok:spike_zod_old:${JSON.stringify(input)}` }),
        });
      });
    }
    try {
      const tools = await ctx.tool.list();
      log("tool-list", { ids: tools.map((tool: any) => tool.id).filter((id: string) => id.startsWith("spike")) });
    } catch (error) {
      log("tool-list-error", { error: String(error) });
    }

    // P7: prompt hook facts and notice position.
    await ctx.session.hook("prompt", async (event: any) => {
      let info: unknown;
      try {
        info = sessionShape(await ctx.session.get({ sessionID: event.sessionID }));
      } catch (error) {
        info = { error: String(error) };
      }
      log("prompt-hook", {
        sessionID: event.sessionID,
        messageID: event.messageID,
        text: event.prompt.text,
        skills: event.prompt.skills,
        agents: event.prompt.agents,
        delivery: event.delivery,
        session: info as Json,
      });
      if (event.prompt.text.includes("SPIKE_NOTICE")) {
        try {
          const result = await withTimeout(
            "synthetic in prompt hook",
            ctx.session.synthetic({
              sessionID: event.sessionID,
              text: "<spike-notice>SPIKE-NOTICE-BODY</spike-notice>",
              resume: false,
            }),
          );
          log("prompt-hook-synthetic", { sessionID: event.sessionID, ok: true, result: result as Json });
        } catch (error) {
          log("prompt-hook-synthetic", { sessionID: event.sessionID, ok: false, error: String(error) });
        }
      }
      if (event.prompt.text.includes("SPIKE_APPEND")) event.prompt.text += "\n<spike-append>APPENDED</spike-append>";
    });

    // P3/P8: guard and error rewrite.
    const blocked = new Map<string, "i" | "ii">();
    await ctx.tool.hook("execute.before", async (event: any) => {
      const input = event.input;
      log("execute.before", {
        tool: event.tool,
        sessionID: event.sessionID,
        agent: event.agent,
        id: event.id,
        inputType: typeof input,
        input,
      });
      if (!["write", "edit", "patch"].includes(event.tool)) return;
      const path = input && typeof input === "object" ? (input as Json).path : undefined;
      if (typeof path === "string" && path.includes("BLOCKME")) {
        const mode = path.includes("mode-ii") ? "ii" : "i";
        blocked.set(event.id, mode);
        event.input = {};
        log("guard-block", { id: event.id, mode, path });
      }
    });
    await ctx.tool.hook("execute.after", async (event: any) => {
      const record: Json = {
        tool: event.tool,
        sessionID: event.sessionID,
        agent: event.agent,
        id: event.id,
        status: event.status,
        input: event.input,
      };
      if (event.status === "error") record.error = errorShape(event.error);
      else record.content = event.result?.content;
      log("execute.after", record);
      if (event.status !== "error") return;
      let mode = blocked.get(event.id);
      let source = "guard";
      if (!mode && typeof (event.input as Json)?.path === "string" && ((event.input as Json).path as string).includes("PERM")) {
        mode = ((event.input as Json).path as string).includes("mode-ii") ? "ii" : "i";
        source = "permission";
      }
      if (!mode) return;
      blocked.delete(event.id);
      const text = `SPIKE-REWRITE-${source}-${mode}`;
      try {
        if (mode === "i") event.error = new PluginToolError({ message: text });
        else event.error.message = text;
        log("rewrite", { id: event.id, mode, source, ok: true, after: errorShape(event.error) });
      } catch (error) {
        log("rewrite", { id: event.id, mode, source, ok: false, error: String(error) });
      }
    });

    // P6(c): permission resources as the host evaluates them.
    await ctx.permission.hook("evaluate", async (event: any) => {
      if (event.action === "edit" || event.action === "external_directory")
        log("permission-evaluate", {
          sessionID: event.sessionID,
          agent: event.agent,
          action: event.action,
          resources: event.resources,
          effect: event.effect,
        });
    });

    // P1/P2/P9: durable execution events.
    const controller = new AbortController();
    const p1Sessions = new Set<string>();
    const p1Done = new Set<string>();
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          const type = (event as any).type as string;
          if (!type.startsWith("session.")) continue;
          const data = (event as any).data ?? {};
          if (type.startsWith("session.execution.") || type === "session.created") {
            let info: unknown;
            try {
              info = sessionShape(await ctx.session.get({ sessionID: data.sessionID }));
            } catch (error) {
              info = { error: String(error) };
            }
            log("event", { type, envelopeKeys: Object.keys(event as any), data, session: info as Json });
          } else if (type === "session.tool.called") log("event-other", { type, sessionID: data.sessionID, data });
          else if (!type.includes("delta")) log("event-other", { type, sessionID: data.sessionID });

          if (type === "session.execution.succeeded" && p1Sessions.has(data.sessionID) && !p1Done.has(data.sessionID)) {
            p1Done.add(data.sessionID);
            const sessionID = data.sessionID;
            void (async () => {
              try {
                const first = await ctx.session.synthetic({ sessionID, text: "P1-RESUME-FALSE-TEXT", resume: false });
                log("p1-synthetic", { sessionID, resume: false, ok: true, result: first });
                await new Promise((r) => setTimeout(r, 3000));
                log("p1-wait-over", { sessionID });
                const second = await ctx.session.synthetic({ sessionID, text: "P1-RESUME-TRUE-TEXT", resume: true });
                log("p1-synthetic", { sessionID, resume: true, ok: true, result: second });
              } catch (error) {
                log("p1-synthetic", { sessionID, ok: false, error: String(error) });
              }
            })();
          }
        } catch (error) {
          log("event-handler-error", { error: String(error) });
        }
      }
    })().catch((error) => log("event-loop-error", { error: String(error) }));

    await ctx.session.hook("prompt", async (event: any) => {
      if (event.prompt.text.includes("SPIKE_P1")) p1Sessions.add(event.sessionID);
    });

    return () => {
      controller.abort();
      log("cleanup", {});
    };
  },
});
