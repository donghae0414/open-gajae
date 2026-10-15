// Task 7a: actual OpenCode 2.0.26 tool-loop observations and deterministic
// adapter race probes. Native receipts and adapter-only evidence are separate.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { z } from "zod";
import {
  AGENTS, REPO, HOST_VERSION, barrier, contentText, directive, runProbe, withHost,
  waitForEvent, releasedPort, type Host, type HostEvent, type Report,
} from "./host-harness";
import { createHooks, type HostSession } from "../src/hooks";
import { epochMillis, StateStore } from "../src/state";
import { TodoStore } from "../src/todo/store";
import { todoSnapshotSchema, type TodoSnapshot } from "../src/todo/state";
import { todoViewSchema } from "../src/todo/protocol";

const arg = process.argv.indexOf("--evidence-dir");
const evidenceDir = resolve(arg >= 0 && process.argv[arg + 1]
  ? process.argv[arg + 1] : join(REPO, ".omo/evidence/todo-agent-performance/host"));
mkdirSync(evidenceDir, { recursive: true });
const settings = { enabled: true, continuation: true, stagnationLimit: 3, failureLimit: 5 };
// Fault control: run only the disabled fixture with enabled:true, retaining
// every disabled assertion. A non-zero exit proves the checks are non-vacuous.
const disabledOnly = process.argv.includes("--disabled-only");
const disabledControlEnabled = process.argv.includes("--disabled-control-enabled");
if (disabledControlEnabled && !disabledOnly)
  throw new Error("--disabled-control-enabled requires --disabled-only");
const TODO_POLICY = "<open-gajae-todo-policy>";
const init = { tool: "todo", args: { op: "init", list: [{ phase: "Work", items: ["A", "B"] }] } };
const receiptSchema = z.object({
  disposition: z.enum(["applied", "unchanged", "committed-with-warning", "rejected", "uncertain"]),
  view: z.object({ status: z.string(), counts: z.object({ open: z.number() }).optional() }),
});
function save(name: string, data: unknown) {
  writeFileSync(join(evidenceDir, `${name}.json`), JSON.stringify(data, null, 2) + "\n");
}
function snapshot(host: Host, id: string): TodoSnapshot {
  const bytes = host.sessionFile(id, "state/todo.json");
  if (!bytes) throw new Error(`missing native todo board: ${id}`);
  return todoSnapshotSchema.parse(JSON.parse(bytes));
}
function formState(host: Host, id: string) {
  const bytes = host.sessionFile(id, "state/todo-forms.json");
  if (!bytes) throw new Error(`missing native form observations: ${id}`);
  return z.object({
    instanceID: z.string().uuid(), pending: z.array(z.string()), unknown: z.boolean(),
    recovery: z.object({
      reason: z.literal("backend_instance_changed"),
      previousInstanceID: z.string().uuid().nullable(), discarded: z.number().int(),
    }).optional(),
  }).parse(JSON.parse(bytes));
}
function resumeEvents(host: Host, id: string) {
  return host.sessionEvents(id).filter((e) => e.type === "session.inbox.enqueued" &&
    e.data?.item?.payload?.metadata?.source === "open-gajae.todo" &&
    e.data?.item?.payload?.metadata?.kind !== "notice");
}
function terminal(host: Host, id: string, predicate: (e: HostEvent) => boolean = () => true) {
  return host.waitForEvent((e) => e.data?.sessionID === id &&
    e.type === "session.execution.succeeded" && predicate(e), 90_000);
}
/** Install before the action. Provider arrival is not a persistence barrier. */
function persistedTodo(host: Host, id: string, predicate: (board: TodoSnapshot) => boolean) {
  return host.waitForEvent((event) => {
    if (event.type !== "rpc.open-gajae.todo.changed" || event.data?.sessionID !== id) return false;
    const view = todoViewSchema.parse(event.data.view);
    if (view.status !== "ready") return false;
    const board = snapshot(host, id);
    return board.revision === view.revision && predicate(board);
  }, 90_000);
}
async function closedLoop(report: Report, scratch: string, enabled: boolean) {
  await withHost(report, join(scratch, enabled ? "on" : "off"), { plugins: [REPO] }, async (host) => {
    const stateHome = host.env.XDG_STATE_HOME;
    if (!stateHome) throw new Error("isolated state directory missing");
    const registration = join(stateHome, "opencode", "service.json");
    report.check("standalone: no artificial service registration", !existsSync(registration));
    mkdirSync(join(host.project, ".open-gajae"), { recursive: true });
    writeFileSync(join(host.project, ".open-gajae/open-gajae.jsonc"),
      JSON.stringify({ todo: { continuation: enabled } }));
    const id = await host.createSession({ agent: "open-gajae" });
    const first = terminal(host, id);
    const last = enabled ? terminal(host, id, () => {
      const board = snapshot(host, id);
      return board.phases.flatMap((p) => p.items).every((i) => i.status === "completed");
    }) : first;
    await host.prompt(id, directive({ tag: "same-fixture", todo: "active", steps: [init, { text: "premature yield" }] }));
    await first;
    await last;
    // A separate native request is an event fence, not a quiet-time heuristic.
    await host.turn(await host.createSession({ agent: "open-gajae" }), directive({ tag: "fence", steps: [] }));
    const board = snapshot(host, id);
    const entries = host.provider.thread("same-fixture");
    const calls = new Map<string, { name: string; args: unknown }>();
    for (const entry of entries) for (const message of entry.body.messages)
      for (const call of message.tool_calls ?? [])
        calls.set(call.id, { name: call.function.name, args: JSON.parse(call.function.arguments) });
    const done = [...calls.values()].filter((c) => c.name === "todo" &&
      z.object({ op: z.literal("done") }).safeParse(c.args).success);
    const receipts = entries.flatMap((e) => e.toolResults).flatMap((text) => {
      try {
        const parsed = receiptSchema.safeParse(JSON.parse(text));
        return parsed.success ? [parsed.data] : [];
      } catch { return []; } // Non-todo tool results are not receipts.
    });
    const resumes = resumeEvents(host, id);
    const keys = resumes.map((e) => {
      const m = e.data.item.payload.metadata;
      return `${m.generation}:${m.workEpoch}:${m.eventID}`;
    });
    const succeeded = host.sessionEvents(id).filter((e) => e.type === "session.execution.succeeded");
    const events = host.sessionEvents(id);
    const doneExecutions = ["A", "B"].map((task) => {
      const calledAt = events.findIndex((e) => e.type === "session.tool.called" &&
        e.data?.input?.op === "done" && e.data?.input?.task === task);
      const called = events[calledAt];
      const successAt = called ? events.findIndex((e, i) => i > calledAt &&
        e.type === "session.tool.success" && e.data?.id === called.data?.id) : -1;
      const success = events[successAt];
      const ended = success ? events.slice(successAt + 1).find((e) => e.type === "session.execution.succeeded") : undefined;
      const receipt = success ? z.object({ disposition: z.literal("applied"), view: todoViewSchema })
        .safeParse(JSON.parse(contentText(success.data.content))) : undefined;
      return { task, called, success, ended, receipt: receipt?.success ? receipt.data : undefined };
    });
    report.check(`${enabled ? "on" : "off"}: same fixture real init receipt`, receipts.some((r) =>
      r.disposition === "applied" && r.view.counts?.open === 2), receipts);
    report.check(`${enabled ? "on" : "off"}: premature yield ${enabled ? "recovered" : "preserved"}`,
      enabled ? done.length === 2 && board.phases[0]?.items.every((i) => i.status === "completed")
        : done.length === 0 && board.phases[0]?.items.every((i) => i.status !== "completed"), { done, board });
    report.check(`${enabled ? "on" : "off"}: accepted duplicates zero`,
      keys.length === new Set(keys).size, keys);
    report.check(`${enabled ? "on" : "off"}: native execution receipts`,
      enabled ? succeeded.length === 3 && resumes.length === 2 : succeeded.length === 1 && resumes.length === 0,
      { succeeded, resumes });
    report.check(`${enabled ? "on" : "off"}: resumes reference actual durable succeeded identities`,
      resumes.every((e) => succeeded.some((s) => s.id === e.data.item.payload.metadata.eventID &&
        z.object({ aggregateID: z.literal(id), seq: z.number().int() }).safeParse(s.durable).success)),
      { succeeded, resumes });
    if (enabled) report.check("done A/B have distinct real tool-success and execution-success receipts",
      doneExecutions.every((d) => !!d.called && !!d.success && !!d.ended?.id &&
        d.receipt?.view.status === "ready" && d.receipt.view.phases.some((phase) =>
          phase.items.some((item) => item.task === d.task && item.status === "completed"))) &&
      new Set(doneExecutions.map((d) => d.ended?.id)).size === 2, doneExecutions);
    if (enabled) {
      const lastSuccess = succeeded.at(-1);
      report.check("terminal: no further native resume", !!lastSuccess &&
        !resumes.some((e) => e.t > lastSuccess.t), { lastSuccess, resumes });
      const before = host.sessionFile(id, "state/todo.json");
      const compactRequest = host.provider.waitForEvent((e) =>
        e.messages.some((m) => m.text.startsWith("You MUST summarize") || m.text.startsWith("Update the existing checkpoint")));
      const compactEnded = host.waitForEvent((e) => e.data?.sessionID === id &&
        e.type === "session.compaction.ended");
      const compacted = await host.api("POST", `/api/session/${id}/compact`, {});
      await compactRequest;
      await compactEnded;
      report.check("compaction accepted", compacted.status < 400, compacted);
      report.check("compaction preserves full board", host.sessionFile(id, "state/todo.json") === before);
      await host.stopBackend();
      await host.start();
      report.check("backend restart preserves full snapshot byte for byte",
        host.sessionFile(id, "state/todo.json") === before, { before,
          after: host.sessionFile(id, "state/todo.json"), events: host.sessionEvents(id).map((e) => ({ type: e.type, data: e.data })) });
      const restartTurn = terminal(host, id);
      await host.prompt(id, directive({ tag: "restart-view", steps: [{ tool: "todo", args: { op: "view" } }] }));
      await restartTurn;
      const after = snapshot(host, id);
      report.check("backend restart preserves full phases and closure ledger",
        JSON.stringify(after.phases) === JSON.stringify(board.phases) &&
        JSON.stringify(after.controller.closedLabels) === JSON.stringify(board.controller.closedLabels),
        { before: board, after });
    }
    save(enabled ? "native-on" : "native-off", {
      scope: "actual standalone OpenCode 2.0.26 without service registration",
      serviceRegistrationPresent: existsSync(registration), host: HOST_VERSION, id, board, done, receipts,
      doneExecutions, events: host.sessionEvents(id), provider: entries, acceptedDuplicates: keys.length - new Set(keys).size,
    });
  });
}

async function catalogs(report: Report, scratch: string) {
  await withHost(report, join(scratch, "catalog"), { plugins: [REPO] }, async (host) => {
    const observations = [];
    for (const agent of [...AGENTS, "build", "general"]) {
      const id = await host.createSession({ agent });
      await host.turn(id, directive({ tag: agent, steps: [] }));
      const entry = host.provider.thread(agent)[0];
      const expected = agent === "open-gajae" || agent === "open-gajae-executor";
      report.check(`${agent}: todo ${expected ? "present" : "absent"}`, !!entry &&
        entry.tools.includes("todo") === expected, entry?.tools);
      if (expected) report.check(`${agent}: todo policy present`,
        !!entry?.system.includes(TODO_POLICY));
      observations.push({ agent, tools: entry?.tools, system: entry?.system });
    }
    save("catalogs", observations);
  });
}

async function nativeDisabled(report: Report, scratch: string) {
  const firstCheck = report.checks.length;
  const observations: Array<Record<string, unknown>> = [];
  await withHost(report, join(scratch, "disabled"), { plugins: [REPO] }, async (host) => {
    mkdirSync(join(host.project, ".open-gajae"), { recursive: true });
    writeFileSync(join(host.project, ".open-gajae/open-gajae.jsonc"),
      JSON.stringify({ todo: { enabled: disabledControlEnabled } }));
    const sessions = [];
    for (const agent of ["open-gajae", "open-gajae-executor"]) {
      const id = await host.createSession({ agent });
      const info = await host.api("GET", `/api/session/${id}`);
      const created = epochMillis(info.json.data.time.created);
      sessions.push({ agent, id, created });
    }
    await host.stopBackend();
    // Seed through the canonical store, with the native creation timestamp,
    // before the backend (and its lazy plugin setup) starts again.
    for (const { id, created } of sessions) {
      const result = await new TodoStore(new StateStore(host.project, async () => created)).apply(id, init.args);
      if (result.disposition !== "applied") throw new Error(`disabled seed failed: ${JSON.stringify(result)}`);
    }
    const seeds = sessions.map((session) => ({
      ...session, bytes: host.sessionFile(session.id, "state/todo.json"), board: snapshot(host, session.id),
    }));
    await host.start();
    for (const seed of seeds) {
      const { agent, id } = seed;
      const tag = `disabled-${agent}`;
      const completed = disabledControlEnabled && agent === "open-gajae"
        ? terminal(host, id, () => snapshot(host, id).phases.flatMap((p) => p.items)
          .every((item) => item.status === "completed"))
        : terminal(host, id);
      await host.prompt(id, directive({ tag, todo: "active", steps: [] }));
      const ended = await completed;
      await host.turn(await host.createSession({ agent: "open-gajae" }),
        directive({ tag: `${tag}-fence`, steps: [] }));
      const provider = host.provider.thread(tag);
      const entry = provider[0];
      const rpc = await host.api("POST",
        `/api/rpc/open-gajae.todo/get?directory=${encodeURIComponent(host.project)}`,
        { input: { sessionID: id } });
      const parsed = todoViewSchema.safeParse(rpc.json.output);
      const afterBytes = host.sessionFile(id, "state/todo.json");
      const after = snapshot(host, id);
      const resumes = resumeEvents(host, id);
      report.check(`disabled ${agent}: todo absent from actual catalog`,
        !!entry && !entry.tools.includes("todo"), entry?.tools);
      report.check(`disabled ${agent}: todo policy absent from actual system prompt`,
        !!entry && !entry.system.includes(TODO_POLICY), { marker: TODO_POLICY });
      report.check(`disabled ${agent}: RPC get returns disabled`,
        rpc.status === 200 && parsed.success && parsed.data.status === "disabled", rpc);
      report.check(`disabled ${agent}: seeded bytes unchanged after full turn`,
        afterBytes === seed.bytes, { before: seed.bytes, after: afterBytes });
      report.check(`disabled ${agent}: seeded revision unchanged after full turn`,
        after.revision === seed.board.revision, { before: seed.board.revision, after: after.revision });
      report.check(`disabled ${agent}: no todo continuation`,
        resumes.length === 0 && !provider.some((request) => request.kind === "todo-continuation") &&
        host.sessionEvents(id).filter((event) => event.type === "session.execution.succeeded").length === 1,
        { resumes, ended });
      observations.push({ agent, id, seed, afterBytes, after, rpc, ended, resumes,
        provider, events: host.sessionEvents(id) });
    }
  });
  save("native-disabled", {
    scope: "actual OpenCode 2.0.26; seeded before backend/plugin startup",
    settings: { todo: { enabled: disabledControlEnabled } }, control: disabledControlEnabled,
    observations, checks: report.checks.slice(firstCheck), cleanup: report.cleanup.at(-1),
  });
}

async function nativeHolds(report: Report, scratch: string) {
  await withHost(report, join(scratch, "native-holds"), { plugins: [REPO] }, async (host) => {
    for (const dismiss of [false, true]) {
      const tag = dismiss ? "question-dismissed" : "question-answered";
      const id = await host.createSession({ agent: "open-gajae" });
      const created = host.waitForEvent((e) => e.type === "form.created" && e.data?.form?.sessionID === id);
      const notice = host.waitForEvent((e) => e.type === "session.inbox.enqueued" &&
        e.data?.sessionID === id && e.data?.item?.payload?.metadata?.kind === "notice");
      await host.prompt(id, directive({
        tag, todo: "active", steps: [init, { tool: "question", args: {
          questions: [{ header: "Probe", question: "Continue?", options: [
            { label: "Continue", description: "answer the pending form" },
            { label: "Finish", description: "dismiss the pending form" },
          ] }],
        } }, { text: "premature yield after question" }],
      }));
      const form = await created;
      await notice;
      await host.turn(await host.createSession({ agent: "open-gajae" }), directive({ tag: `${tag}-fence`, steps: [] }));
      const held = snapshot(host, id);
      const heldForms = formState(host, id);
      report.check(`${tag}: unanswered form never authorizes resume`,
        held.controller.hold?.reason === "unanswered_form" && resumeEvents(host, id).length === 0, held);
      const formID = z.string().parse(form.data.form.id);
      const resolved = host.waitForEvent((e) => e.type === (dismiss ? "form.cancelled" : "form.replied") &&
        e.data?.sessionID === id && e.data?.id === formID);
      // Native dismissal also publishes a user interrupt. Releasing the form
      // must not release that independent stop or manufacture a new execution.
      const last = dismiss ? host.waitForEvent((e) =>
        ["session.execution.interrupted", "session.execution.failed", "session.execution.succeeded"].includes(e.type) &&
        e.data?.sessionID === id)
        : terminal(host, id, () =>
          snapshot(host, id).phases.flatMap((p) => p.items).every((i) => i.status === "completed"));
      const reply = await host.api(dismiss ? "DELETE" : "POST",
        `/api/session/${id}/form/${formID}${dismiss ? "" : "/reply"}`,
        dismiss ? undefined : { answer: { q0: "Continue" } });
      save(`${tag}-resolution`, { scope: "native", reply, formID, events: host.sessionEvents(id),
        board: snapshot(host, id) });
      const resolution = await resolved;
      const ended = await last;
      await host.turn(await host.createSession({ agent: "open-gajae" }), directive({ tag: `${tag}-resolved-fence`, steps: [] }));
      const after = snapshot(host, id);
      const afterForms = formState(host, id);
      report.check(`${tag}: no-crash question belongs to the same instance until user resolution`,
        heldForms.instanceID === afterForms.instanceID &&
        heldForms.pending.includes(formID) && !afterForms.pending.includes(formID) &&
        !afterForms.recovery, { heldForms, afterForms });
      report.check(`${tag}: explicit resolution preserves independent stop`, reply.status < 400 &&
        (dismiss ? after.controller.hold?.reason !== "unanswered_form" &&
          after.controller.hold?.reason !== "form_state_unknown" &&
          !resumeEvents(host, id).some((e) => e.t < resolution.t) &&
          (ended.type !== "session.execution.interrupted" || ended.data?.reason !== "user" ||
            after.controller.hold?.reason === "user_stop")
          : after.controller.hold === null), { reply, after });
      save(tag, { scope: "native", held, heldForms, afterForms,
        after: snapshot(host, id), events: host.sessionEvents(id) });
    }
    const id = await host.createSession({ agent: "open-gajae" });
    // Gate the resumed provider request before prompting, not after observing it.
    const gate = host.provider.hold((e) => e.thread === "native-stop" && e.kind === "todo-continuation");
    const accepted = persistedTodo(host, id, (board) => board.controller.reservation?.status === "accepted");
    await host.prompt(id, directive({ tag: "native-stop", todo: "active", steps: [init, { text: "premature yield" }] }));
    await gate.reached;
    const acceptedReceipt = await accepted;
    const beforeStop = snapshot(host, id);
    const beforeStopEvents = host.sessionEvents(id);
    const resumedStart = beforeStopEvents.filter((e) => e.type === "session.execution.started").at(-1);
    report.check("native stop: provider barrier belongs to a real resumed execution",
      beforeStopEvents.filter((e) => e.type === "session.execution.started").length === 2 &&
      beforeStop.controller.reservation?.status === "accepted" && resumeEvents(host, id).length === 1,
      { beforeStop, resumedStart });
    const interrupted = host.waitForEvent((e) => e.type === "session.execution.interrupted" &&
      e.data?.sessionID === id && e.data?.reason === "user");
    const stop = await host.api("POST", `/api/session/${id}/interrupt`);
    const interruptReceipt = await interrupted;
    gate.release();
    await host.turn(await host.createSession({ agent: "open-gajae" }), directive({ tag: "stop-fence", steps: [] }));
    await host.turn(id, directive({ tag: "native-stop-view", steps: [{ tool: "todo", args: { op: "view" } }] }));
    const acceptedAtStop = resumeEvents(host, id).length;
    const board = snapshot(host, id);
    const viewEvent = host.sessionEvents(id).filter((e) => e.type === "session.tool.success").at(-1);
    const viewReceipt = viewEvent ? z.object({ disposition: z.literal("unchanged"), view: todoViewSchema })
      .parse(JSON.parse(contentText(viewEvent.data.content))) : undefined;
    report.check("native stop during resumed execution: no unauthorized generation",
      stop.status < 400 && acceptedAtStop === 1 && board.controller.hold?.reason === "user_stop", { stop, board });
    report.check("native stop: real todo view exposes the persistent hold",
      viewReceipt?.view.status === "ready" && viewReceipt.view.hold?.reason === "user_stop" &&
      viewReceipt.view.counts.open === 2, { viewEvent, viewReceipt });
    const events = host.sessionEvents(id);
    report.check("native stop: user interrupt follows resumed start in durable event order",
      !!resumedStart && events.indexOf(interruptReceipt) > events.indexOf(resumedStart),
      { resumedStart, interruptReceipt });
    save("native-resumed-stop", { scope: "native public interrupt while resumed provider request is blocked",
      id, acceptedReceipt, beforeStop, resumedStart, stop, interruptReceipt, board, viewEvent, viewReceipt, events, acceptedAtStop });
  });
}

async function nativeMutationBoundaries(report: Report, scratch: string) {
  await withHost(report, join(scratch, "mutation-boundaries"), { plugins: [REPO] }, async (host) => {
    // The executor can create an open board but cannot drive root continuation.
    // This keeps the primary's later corruption turn genuinely continuation-on.
    const victim = await host.createSession({ agent: "open-gajae-executor" });
    const initialized = persistedTodo(host, victim, (board) =>
      !!board.controller.activationFence &&
      board.controller.consumedActivationFence?.eventID === board.controller.activationFence.eventID);
    await host.turn(victim, directive({ tag: "native-owner", steps: [init] }));
    const victimCommitReceipt = await initialized;
    const victimResult = host.sessionEvents(victim).filter((e) => e.type === "session.tool.success").at(-1);
    if (!victimResult) throw new Error("missing committed native owner init receipt");
    const victimView = z.object({ view: todoViewSchema }).parse(JSON.parse(contentText(victimResult.data.content))).view;
    const victimBaseline = snapshot(host, victim);
    const victimBefore = host.sessionFile(victim, "state/todo.json");
    report.check("native owner: baseline follows committed init tool revision",
      victimView.status === "ready" && victimView.revision <= victimBaseline.revision &&
      victimCommitReceipt.data.view.revision === victimBaseline.revision,
      { victimResult, victimCommitReceipt, victimBaseline });
    const wrongActor = await host.createSession({ agent: "open-gajae-explore" });
    await host.turn(wrongActor, directive({ tag: "native-wrong-actor", steps: [
      { tool: "todo", args: { op: "done", task: "A" } },
    ] }));
    const actorEntry = host.provider.thread("native-wrong-actor")[0];
    const actorFailures = host.sessionEvents(wrongActor).filter((e) => e.type === "session.tool.failed");
    report.check("native wrong actor: attempted todo is unavailable and rejected",
      !!actorEntry && !actorEntry.tools.includes("todo") && actorFailures.length === 1 &&
      !!actorFailures[0]?.data?.error, actorFailures);
    report.check("native wrong actor: owner bytes unchanged and no attacker board",
      host.sessionFile(victim, "state/todo.json") === victimBefore &&
      snapshot(host, victim).revision === victimBaseline.revision &&
      host.sessionFile(wrongActor, "state/todo.json") === undefined);
    save("native-wrong-actor", { scope: "native model tool call in non-owner agent session",
      victim, wrongActor, victimResult, victimCommitReceipt, victimBaseline,
      victimBefore, victimAfter: host.sessionFile(victim, "state/todo.json"),
      provider: host.provider.thread("native-wrong-actor"), events: host.sessionEvents(wrongActor), actorFailures });

    const foreign = await host.createSession({ agent: "open-gajae-executor" });
    await host.turn(foreign, directive({ tag: "native-foreign-init", steps: [
      { tool: "todo", args: { op: "init", list: [{ phase: "Other", items: ["X", "Y"] }] } },
    ] }));
    for (const selector of [false, true]) {
      const tag = selector ? "native-foreign-selector" : "native-foreign-label";
      const gate = host.provider.hold((e) => e.thread === tag && e.step === 0);
      const beforeTurn = snapshot(host, foreign);
      // Match this genuine delivery, not an older RPC receipt or merely the
      // provider request. Hold the attack until its fence transaction commits.
      const activation = persistedTodo(host, foreign, (board) =>
        board.revision > beforeTurn.revision &&
        board.controller.activationFence?.eventID !== beforeTurn.controller.activationFence?.eventID &&
        host.sessionEvents(foreign).some((event) => event.type === "session.inbox.delivered" &&
          event.id === board.controller.activationFence?.eventID));
      const ended = terminal(host, foreign);
      let foreignBefore: string | undefined;
      let foreignBaseline: TodoSnapshot | undefined;
      let activationReceipt: HostEvent | undefined;
      try {
        await host.prompt(foreign, directive({ tag, steps: [{
          tool: "todo", args: { op: "done", task: "A", ...(selector ? { sessionID: victim } : {}) },
        }] }));
        await gate.reached;
        activationReceipt = await activation;
        foreignBaseline = snapshot(host, foreign);
        foreignBefore = host.sessionFile(foreign, "state/todo.json");
      } finally { gate.release(); }
      await ended;
      const events = host.sessionEvents(foreign);
      const failure = events.filter((e) => e.type === "session.tool.failed").at(-1);
      const success = events.filter((e) => e.type === "session.tool.success").at(-1);
      const receipt = !selector && success ? receiptSchema.parse(JSON.parse(contentText(success.data.content))) : undefined;
      report.check(`${tag}: real mutation rejected`, selector ? !!failure?.data?.error :
        receipt?.disposition === "rejected", { failure, success, receipt });
      report.check(`${tag}: both session boards remain byte-identical`,
        host.sessionFile(victim, "state/todo.json") === victimBefore &&
        snapshot(host, victim).revision === victimBaseline.revision &&
        host.sessionFile(foreign, "state/todo.json") === foreignBefore &&
        snapshot(host, foreign).revision === foreignBaseline?.revision,
        { victimRevision: victimBaseline.revision, foreignBaseline, activationReceipt });
      save(tag, { scope: "native executor session cannot select or mutate another board",
        victim, foreign, selector, victimResult, victimCommitReceipt, victimBaseline, beforeTurn, activationReceipt, foreignBaseline,
        victimBefore, victimAfter: host.sessionFile(victim, "state/todo.json"),
        foreignBefore, foreignAfter: host.sessionFile(foreign, "state/todo.json"),
        failure, success, receipt, events, provider: host.provider.thread(tag) });
    }
    report.check("native ownership attacks: unauthorized continuation zero",
      [victim, wrongActor, foreign].every((id) => resumeEvents(host, id).length === 0));

    const selected = await host.api("POST", `/api/session/${victim}/agent`, { agent: "open-gajae" });
    report.check("native corruption: primary selected for continuation-on turn", selected.status === 204, selected);
    const file = join(await new StateStore(host.project, async () => 1).resolveSessionDir(victim), "state/todo.json");
    const corruptBytes = "{invalid-native-todo";
    writeFileSync(file, corruptBytes);
    const notice = host.waitForEvent((e) => e.type === "session.inbox.enqueued" && e.data?.sessionID === victim &&
      e.data?.item?.payload?.metadata?.source === "open-gajae.todo" &&
      e.data?.item?.payload?.metadata?.kind === "notice");
    await host.turn(victim, directive({ tag: "native-corrupt-view", steps: [{ tool: "todo", args: { op: "view" } }] }));
    const noticeReceipt = await notice;
    await host.turn(await host.createSession({ agent: "open-gajae" }), directive({ tag: "native-corrupt-fence", steps: [] }));
    const events = host.sessionEvents(victim);
    const success = events.filter((e) => e.type === "session.tool.success").at(-1);
    const viewReceipt = success ? z.object({ disposition: z.literal("unchanged"), view: todoViewSchema })
      .parse(JSON.parse(contentText(success.data.content))) : undefined;
    report.check("native corrupt storage: actual todo view is invalid",
      viewReceipt?.view.status === "invalid", { success, viewReceipt });
    report.check("native corrupt storage: exact raw bytes preserved and dispatch zero",
      readFileSync(file, "utf8") === corruptBytes && resumeEvents(host, victim).length === 0);
    report.check("native corrupt storage: one passive invalid-storage notice",
      noticeReceipt.data.item.payload.metadata.kind === "notice" &&
      events.filter((e) => e.type === "session.inbox.enqueued" &&
        e.data?.item?.payload?.metadata?.source === "open-gajae.todo" &&
        e.data?.item?.payload?.metadata?.kind === "notice").length === 1, noticeReceipt);
    save("native-storage-corruption", { scope: "native continuation-on primary turn with between-turn file corruption",
      id: victim, file, selected, corruptBytes, preservedBytes: readFileSync(file, "utf8"),
      success, viewReceipt, noticeReceipt, events, resumes: resumeEvents(host, victim) });
  });
}

async function nativeAcceptedRestart(report: Report, scratch: string) {
  await withHost(report, join(scratch, "accepted-restart"), { plugins: [REPO] }, async (host) => {
    const id = await host.createSession({ agent: "open-gajae" });
    const gate = host.provider.hold((e) => e.thread === "native-accepted-restart" && e.kind === "todo-continuation");
    const accepted = persistedTodo(host, id, (board) => board.controller.reservation?.status === "accepted");
    let before: TodoSnapshot;
    let acceptedReceipt: HostEvent;
    let crash: Record<string, unknown>;
    try {
      await host.prompt(id, directive({ tag: "native-accepted-restart", todo: "stagnant",
        steps: [init, { text: "premature yield" }] }));
      await gate.reached;
      acceptedReceipt = await accepted;
      before = snapshot(host, id);
      const source = before.controller.reservation?.source;
      const succeeded = host.sessionEvents(id).find((e) => e.id === source?.eventID);
      report.check("native accepted restart: persisted reservation has real durable success source",
        before.controller.reservation?.status === "accepted" &&
        before.controller.reservation.source.eventID === before.controller.sourceWatermark?.eventID &&
        succeeded?.type === "session.execution.succeeded" &&
        z.object({ aggregateID: z.literal(id), seq: z.literal(source?.seq) }).safeParse(succeeded.durable).success,
        { before, succeeded });
      const backend = host["server"];
      if (!backend) throw new Error("owned backend missing");
      const port = Number(new URL(host["baseUrl"]).port);
      const closed = waitForEvent("accepted backend crash close", (listener) => {
        backend.once("close", listener);
        return () => { backend.off("close", listener); };
      });
      host["eventAbort"].abort();
      backend.kill("SIGKILL");
      await closed;
      crash = { kind: "backend", pid: backend.pid, signal: backend.signalCode,
        closed: backend.signalCode === "SIGKILL", port, portReleased: releasedPort(port) };
      host.cleanup.push(crash);
      report.check("native accepted restart: owned backend crash closed and port freed",
        crash.closed === true && crash.portReleased === true, crash);
    } finally { gate.release(); }
    const boundary = host.allEvents().length;
    await host.start();
    // Load the actual plugin in the recovered location, without giving this
    // session a new user directive or injecting/replaying an event.
    await host.turn(await host.createSession({ agent: "open-gajae" }), directive({ tag: "native-restart-fence", steps: [] }));
    const context = await host.api("GET", `/api/session/${id}/context`);
    const messages = z.object({ data: z.array(z.object({ id: z.string() }).passthrough()) }).parse(context.json).data;
    const after = snapshot(host, id);
    const reservation = before.controller.reservation;
    const postRestart = host.allEvents().slice(boundary).filter((e) => e.data?.sessionID === id);
    report.check("native accepted restart: durable seq watermark and reservation remain identical",
      JSON.stringify(after.controller.sourceWatermark) === JSON.stringify(before.controller.sourceWatermark) &&
      JSON.stringify(after.controller.reservation) === JSON.stringify(reservation), { before, after });
    report.check("native accepted restart: accepted synthetic retained exactly once",
      context.status === 200 && messages.filter((m) => m.id === reservation?.syntheticID).length === 1,
      { context, syntheticID: reservation?.syntheticID });
    report.check("native accepted restart: no resend or execution without a new user action",
      !postRestart.some((e) => e.type === "session.execution.started" ||
        (e.type === "session.inbox.enqueued" && e.data?.item?.payload?.metadata?.source === "open-gajae.todo" &&
          e.data?.item?.payload?.metadata?.kind !== "notice")) &&
      resumeEvents(host, id).length === 1, postRestart);
    save("native-accepted-restart", { scope: "native accepted continuation SIGKILL/restart with open board; no injected events",
      id, acceptedReceipt, before, after, crash, context, postRestart, events: host.sessionEvents(id), resumes: resumeEvents(host, id) });
  });
}

async function nativeQuestionCrash(report: Report, scratch: string) {
  await withHost(report, join(scratch, "question-crash"), { plugins: [REPO] }, async (host) => {
    const id = await host.createSession({ agent: "open-gajae" });
    const created = host.waitForEvent((e) => e.type === "form.created" && e.data?.form?.sessionID === id);
    const notice = host.waitForEvent((e) => e.type === "session.inbox.enqueued" &&
      e.data?.sessionID === id && e.data?.item?.payload?.metadata?.kind === "notice");
    await host.prompt(id, directive({ tag: "before-crash", steps: [
      init, { tool: "question", args: { questions: [{
        header: "Crash", question: "Continue?", options: [
          { label: "Yes", description: "Continue work" },
          { label: "No", description: "Stop work" },
        ],
      }] } }, { text: "yield" },
    ] }));
    const form = await created;
    await notice;
    const formID = z.string().parse(form.data.form.id);
    const before = { board: snapshot(host, id), forms: formState(host, id),
      pending: await host.api("GET", `/api/session/${id}/form`) };
    report.check("crash: current question is held before backend loss",
      before.board.controller.hold?.reason === "unanswered_form" &&
      before.forms.pending.includes(formID) && resumeEvents(host, id).length === 0, before);

    // Test-only access to this fixture's child, never another worker's host.
    const backend = host["server"];
    if (!backend) throw new Error("owned backend missing");
    const port = Number(new URL(host["baseUrl"]).port);
    const closed = waitForEvent("crashed backend close", (listener) => {
      backend.once("close", listener);
      return () => { backend.off("close", listener); };
    });
    host["eventAbort"].abort();
    backend.kill("SIGKILL");
    await closed;
    const crash = { kind: "backend", pid: backend.pid, exit: backend.exitCode,
      signal: backend.signalCode, closed: backend.signalCode === "SIGKILL",
      port, portReleased: releasedPort(port) };
    host.cleanup.push(crash);
    report.check("crash: owned backend killed and listener released", crash.closed && crash.portReleased, crash);
    await host.start();
    const pending = await host.api("GET", `/api/session/${id}/form`);
    const reply = await host.api("POST", `/api/session/${id}/form/${formID}/reply`, { answer: { q0: "Yes" } });
    const dismiss = await host.api("DELETE", `/api/session/${id}/form/${formID}`);
    report.check("crash: restarted host has no pending forms",
      pending.status === 200 && z.object({ data: z.array(z.unknown()).length(0) }).safeParse(pending.json).success, pending);
    report.check("crash: old question cannot be answered or dismissed",
      reply.status === 404 && dismiss.status === 404, { reply, dismiss });

    // The provider barrier observes recovery before the genuine user's tools
    // run. No state file is edited to make the next turn eligible.
    const gate = host.provider.hold((e) => e.thread === "after-crash" && e.kind === "directive");
    const finished = terminal(host, id, () =>
      snapshot(host, id).phases.flatMap((p) => p.items).every((i) => i.status === "completed"));
    let restored: { board: TodoSnapshot; forms: ReturnType<typeof formState> } | undefined;
    try {
      await host.prompt(id, directive({ tag: "after-crash", todo: "active", steps: [
        { tool: "todo", args: { op: "view" } },
        { tool: "todo", args: { op: "start", task: "A" } },
        { text: "premature yield after restart" },
      ] }));
      await gate.reached;
      restored = { board: snapshot(host, id), forms: formState(host, id) };
      report.check("crash: new instance releases only the vanished question before user tools",
        restored.board.controller.hold === null && restored.forms.pending.length === 0 &&
        !restored.forms.unknown && restored.forms.instanceID !== before.forms.instanceID &&
        restored.forms.recovery?.previousInstanceID === before.forms.instanceID &&
        restored.forms.recovery.discarded === 1, restored);
    } finally { gate.release(); }
    const ended = await finished;
    await host.turn(await host.createSession({ agent: "open-gajae" }), directive({ tag: "crash-fence", steps: [] }));
    const after = snapshot(host, id);
    const events = host.sessionEvents(id);
    const done = ["A", "B"].map((task) => {
      const called = events.find((e) => e.type === "session.tool.called" &&
        e.data?.input?.op === "done" && e.data?.input?.task === task);
      const success = called && events.find((e) => e.type === "session.tool.success" && e.data?.id === called.data.id);
      return { task, called, success, receipt: success ? receiptSchema.parse(JSON.parse(contentText(success.data.content))) : undefined };
    });
    report.check("crash: genuine user turn and real todo A/B complete successfully",
      after.controller.hold === null && done.every((d) => d.receipt?.disposition === "applied") &&
      after.phases.flatMap((p) => p.items).every((i) => i.status === "completed"), { after, done, ended });
    const resumes = resumeEvents(host, id);
    const keys = resumes.map((e) => JSON.stringify(e.data.item.payload.metadata));
    report.check("crash: duplicate resumes zero", new Set(keys).size === keys.length, resumes);
    report.check("crash: no resume after terminal event",
      !resumes.some((e) => events.indexOf(e) > events.indexOf(ended)), { ended, resumes });
    save("question-crash-restart", { scope: "native SIGKILL and restart; no file repair",
      id, formID, before, crash, pending, reply, dismiss, restored, after, done, ended,
      events, resumes, duplicateResumes: keys.length - new Set(keys).size });
  });
}

async function nativeBudgetsAndChild(report: Report, scratch: string) {
  await withHost(report, join(scratch, "native-budgets-child"), { plugins: [REPO] }, async (host) => {
    for (const strategy of ["stagnant", "status-only", "failure"] as const) {
      const id = await host.createSession({ agent: "open-gajae" });
      const held = host.waitForEvent((e) => e.type === "session.inbox.enqueued" &&
        e.data?.sessionID === id && e.data?.item?.payload?.metadata?.kind === "notice");
      await host.prompt(id, directive({ tag: strategy, todo: strategy, steps: [init, { text: "premature yield" }] }));
      await held;
      await host.turn(await host.createSession({ agent: "open-gajae" }), directive({ tag: `${strategy}-fence`, steps: [] }));
      const board = snapshot(host, id);
      const expected = strategy === "failure" ? "execution_error" : "stagnation";
      report.check(`${strategy}: bounded native hold without fake progress`,
        board.controller.hold?.reason === expected && board.controller.closedLabels.length === 0 &&
        resumeEvents(host, id).length === (strategy === "failure" ? 1 : 3), board);
      save(`native-${strategy}`, { scope: "native", board, events: host.sessionEvents(id), provider: host.provider.thread(strategy) });
    }
    const id = await host.createSession({ agent: "open-gajae" });
    const childGate = host.provider.hold((e) => e.thread === "todo-native-child" && e.kind === "directive");
    const parentGate = host.provider.hold((e) => e.thread === "todo-native-parent" && e.kind === "directive" && e.step === 2);
    const parentFirst = terminal(host, id);
    const childStarted = host.waitForEvent((e) => e.type === "session.created" && e.data?.parentID === id);
    await host.prompt(id, directive({ tag: "todo-native-parent", todo: "active", steps: [
      init,
      { tool: "subagent", args: {
        agent: "open-gajae-executor", description: "native child delivery probe", background: true,
        prompt: directive({ tag: "todo-native-child", steps: [init, { text: "child completion receipt" }] }),
      } },
      { text: "premature parent yield" },
    ] }));
    const child = await childStarted;
    await childGate.reached;
    await parentGate.reached;
    parentGate.release();
    await parentFirst;
    report.check("native parent terminal while child pending: unauthorized generation zero",
      resumeEvents(host, id).length === 0, host.sessionEvents(id));
    const childID = z.string().parse(child.data.sessionID);
    const storage = join(host.project, ".open-gajae");
    const before = readdirSync(storage, { recursive: true }).map(String).sort();
    const parentFolder = readdirSync(storage).find((name) => name.endsWith(`-${id}`));
    if (!parentFolder) throw new Error("native parent folder missing");
    const nested = `${parentFolder}/children/${childID}`;
    report.check("pending native child state is nested under lineage root",
      before.includes(`${nested}/state/todo-child-results.json`), before);
    const completed = terminal(host, childID);
    const delivered = host.waitForEvent((e) => e.type === "session.inbox.delivered" &&
      e.data?.sessionID === id && host.sessionEvents(id).some((enqueued) =>
        enqueued.type === "session.inbox.enqueued" && enqueued.data?.inboxID === e.data?.inboxID &&
        enqueued.data?.item?.payload?.metadata?.source === "subagent"));
    childGate.release();
    await completed;
    const delivery = await delivered;
    // A separate native execution fences observation; no timer-based settle.
    await host.turn(await host.createSession({ agent: "open-gajae" }), directive({ tag: "child-fence", steps: [] }));
    report.check("native child completion cannot resume todo before actual inbox delivery",
      !resumeEvents(host, id).some((e) => e.t < delivery.t), { delivery, resumes: resumeEvents(host, id) });
    const after = readdirSync(storage, { recursive: true }).map(String).sort();
    const roots = host.allEvents().filter((e) => e.type === "session.created" && !e.data?.parentID)
      .map((e) => e.data?.sessionID);
    const top = readdirSync(storage).filter((name) => name.startsWith("_session-"));
    report.check("native session top level contains only lineage roots",
      top.every((folder) => roots.some((root) => folder.endsWith(`-${root}`))), { top, roots });
    report.check("native executor board survives under children after terminal ledger cleanup",
      after.includes(`${nested}/state/todo.json`) &&
      !after.includes(`${nested}/state/todo-child-results.json`) &&
      after.includes(`${parentFolder}/state/todo-child-results-fences.json`), after);
    save("session-directories", { sandbox: host.project, before, after, root: id, child: childID });
    save("native-child-delivery", { scope: "native", events: host.sessionEvents(id),
      childEvents: host.sessionEvents(childID), delivery });
    // Stop any remaining legitimate parent execution before shutting down.
    await host.api("POST", `/api/session/${id}/interrupt`);
  });
}

/** Races at the plugin's declared dispatch boundary, not forged native receipts.
 * Real reducers/storage/hooks are used; transport faults and native events are
 * injected deterministically here because the host has no public fault endpoint.
 */
async function adapterRaces(report: Report, scratch: string) {
  type Synthetic = Parameters<HostSession["synthetic"]>[0];
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function fixture(name: string) {
    const dir = join(scratch, "adapter", name);
    mkdirSync(dir, { recursive: true });
    const id = "ses_adapter";
    const store = new StateStore(dir, async () => 1_800_000_000_000);
    const todo = new TodoStore(store);
    let agent = "open-gajae";
    let forms: Array<{ id: string; sessionID: string }> = [];
    const calls: Synthetic[] = [];
    const attempts: Synthetic[] = [];
    const observations: unknown[] = [];
    const messages: Array<{ id: string; type: string }> = [];
    const session: HostSession = {
      async get() { return { agent, location: { directory: dir } }; },
      async context() { return messages; },
      async synthetic(input) {
        calls.push(input);
        if (input.id) messages.push({ id: input.id, type: "synthetic" });
        return {};
      },
    };
    const make = () => {
      const hooks = createHooks(store, session, REPO, dir, dir, { ...settings, failureLimit: 2 });
      hooks.configureTodo({ ...settings, failureLimit: 2 }, async () => {},
        async () => forms);
      return hooks;
    };
    const hooks = make();
    await todo.apply(id, init.args);
    let toolSequence = 0;
    const apply = async (input: Record<string, unknown>) => {
      const callID = `call_adapter_${++toolSequence}`;
      await hooks.executeBefore({ sessionID: id, agent, tool: "todo", id: callID, input });
      const result = await todo.apply(id, input);
      await hooks.executeAfter({ sessionID: id, agent, tool: "todo", id: callID, status: "success" });
      return result;
    };
    const read = async () => {
      const value = await todo.readSnapshot(id);
      if (value.status !== "ready") throw new Error(`${name}: board ${value.status}`);
      return value.snapshot;
    };
    const event = (type: string, seq: number, data: Record<string, unknown> = {}) => ({
      id: `evt_${seq}`, type, durable: { aggregateID: id, seq, version: 1 },
      data: { sessionID: id, ...data },
    });
    const emit = async (type: string, seq: number, data: Record<string, unknown> = {}) => {
      const e = event(type, seq, data);
      observations.push(e);
      await hooks.onEvent(e);
    };
    const user = async (seq: number) => {
      await emit("session.inbox.enqueued", seq, { inboxID: `msg_user_${seq}`,
        item: { type: "user", payload: { text: "continue" } } });
      await emit("session.inbox.delivered", seq + 1, { inboxID: `msg_user_${seq}` });
    };
    return { name, dir, id, store, todo, hooks, session, read, event, emit, user, make, apply, calls, attempts, observations,
      setAgent(value: string) { agent = value; },
      setForms(value: typeof forms) { forms = value; },
      resumes: () => calls.filter((c) => c.resume),
    };
  }
  const scenarios: Array<[string, (f: Fixture) => Promise<void>]> = [
    ["child-completed-not-delivered", async (f) => {
      await f.emit("session.created", 1, { sessionID: "ses_child", parentID: f.id });
      await f.emit("session.execution.started", 2, { sessionID: "ses_child" });
      await f.emit("session.execution.succeeded", 3, { sessionID: "ses_child" });
      await f.emit("session.execution.succeeded", 4);
      report.check("child completed before result delivery: unauthorized generation zero", f.resumes().length === 0);
      await f.emit("session.inbox.enqueued", 5, { inboxID: "msg_child", item: {
        type: "synthetic", payload: { text: "child result",
          metadata: { source: "subagent", childID: "ses_child", state: "completed" } },
      } });
      await f.emit("session.execution.succeeded", 6);
      report.check("child result enqueued but undelivered: unauthorized generation zero", f.resumes().length === 0);
      await f.emit("session.inbox.delivered", 7, { inboxID: "msg_child" });
      await f.emit("session.execution.succeeded", 8);
      report.check("child result actually delivered: exactly one resume", f.resumes().length === 1);
    }],
    ["question-user-start-does-not-answer", async (f) => {
      f.setForms([{ id: "frm_pending", sessionID: f.id }]);
      await f.emit("form.created", 1, { form: { id: "frm_pending", sessionID: f.id } });
      await f.user(2);
      await f.apply({ op: "start", task: "A" });
      await f.emit("session.execution.succeeded", 4);
      report.check("genuine message and explicit start cannot answer pending question",
        f.resumes().length === 0 && (await f.read()).controller.hold?.reason === "unanswered_form");
      f.setForms([]);
      await f.emit("form.cancelled", 5, { id: "frm_pending" });
      await f.emit("session.execution.succeeded", 6);
      report.check("user dismiss releases only question hold", f.resumes().length === 1);
    }],
    ["stop-during-synthetic-dispatch", async (f) => {
      const entered = new EventEmitter();
      const reached = waitForEvent("synthetic dispatch barrier", (listener) => {
        entered.on("dispatch", listener);
        return () => { entered.off("dispatch", listener); };
      });
      const release = barrier();
      const original = f.session.synthetic;
      f.session.synthetic = async (input, options) => {
        if (!input.resume) return original(input, options);
        f.attempts.push(input);
        entered.emit("dispatch", input);
        await release.promise;
        if (options?.signal?.aborted) throw options.signal.reason;
        return original(input, options);
      };
      const dispatch = f.emit("session.execution.succeeded", 1);
      try {
        await reached;
        const stop = f.event("session.execution.interrupted", 2, { reason: "user" });
        f.observations.push(stop);
        f.hooks.observeEvent(stop);
        release.release();
        await dispatch;
        await f.hooks.onEvent(stop);
      } finally { release.release(); await dispatch; }
      await f.emit("session.execution.interrupted", 3, { reason: "user" });
      await f.emit("session.execution.succeeded", 4);
      report.check("stop during synthetic dispatch and repeated interruption: unauthorized generation zero",
        f.resumes().length === 0 && (await f.read()).controller.hold?.reason === "user_stop");
      await f.user(5);
      await f.apply({ op: "view" });
      await f.emit("session.execution.succeeded", 7);
      report.check("status-only user reply cannot release stop", f.resumes().length === 0);
      f.session.synthetic = original;
      await f.apply({ op: "start", task: "B" });
      await f.emit("session.execution.succeeded", 8);
      report.check("cancel/resume needs explicit start after delivery", f.resumes().length === 1);
    }],
    ["wrong-actor", async (f) => {
      f.setAgent("open-gajae-executor");
      await f.emit("session.agent.selected", 1, { agent: "open-gajae-executor" });
      await f.emit("session.execution.succeeded", 2);
      report.check("wrong actor cannot continue ordinary root work", f.resumes().length === 0);
    }],
    ["stale-epoch-and-replay", async (f) => {
      await f.user(10);
      await f.apply({ op: "start", task: "B" });
      await f.emit("session.execution.succeeded", 12);
      const before = await f.read();
      await f.emit("session.execution.interrupted", 1, { reason: "user" });
      await Promise.all([f.emit("session.execution.succeeded", 12), f.emit("session.execution.succeeded", 12)]);
      await f.emit("session.execution.succeeded", 9);
      const after = await f.read();
      report.check("stale epoch and replay produce zero additional accepted effects",
        f.resumes().length === 1 && JSON.stringify(before) === JSON.stringify(after), { before, after });
    }],
    ["storage-corruption", async (f) => {
      const file = join(await f.store.resolveSessionDir(f.id), "state/todo.json");
      writeFileSync(file, "{invalid");
      await f.emit("session.execution.succeeded", 1);
      await f.emit("session.execution.succeeded", 2);
      report.check("invalid bytes preserved with zero generation and one passive notice",
        readFileSync(file, "utf8") === "{invalid" && f.resumes().length === 0 &&
        f.calls.filter((c) => !c.resume && c.text.startsWith("<open-gajae-todo-notice>")).length === 1);
    }],
    ["definite-dispatch-error", async (f) => {
      const original = f.session.synthetic;
      f.session.synthetic = async (input, options) => {
        if (!input.resume) return original(input, options);
        f.attempts.push(input);
        throw { _tag: "InvalidRequestError", message: "definite preaccept rejection" };
      };
      await f.emit("session.execution.succeeded", 1);
      await f.emit("session.execution.succeeded", 1);
      const board = await f.read();
      report.check("definite error bounded retries one reservation zero acceptance",
        f.resumes().length === 0 && f.attempts.length === 2 &&
        new Set(f.attempts.map((c) => c.id)).size === 1 &&
        board.controller.hold?.reason === "dispatch_failure" && board.controller.failures === 2, board);
    }],
    ["ambiguous-dispatch-error-and-restart", async (f) => {
      const original = f.session.synthetic;
      f.session.synthetic = async (input, options) => {
        const result = await original(input, options);
        if (input.resume) throw new Error("connection lost after native accept");
        return result;
      };
      await f.emit("session.execution.succeeded", 1);
      const board = await f.read();
      report.check("ambiguous delivery never retransmitted",
        f.resumes().length === 1 && board.controller.hold?.reason === "ambiguous_delivery", board);
      await f.hooks.dispose();
      const fresh = f.make();
      try {
        await fresh.onEvent(f.event("session.execution.succeeded", 2));
        await fresh.context({ sessionID: f.id, agent: "open-gajae", messages: [] });
        report.check("backend restart restoration cannot dispatch",
          f.resumes().length === 1 && JSON.stringify(board.phases) === JSON.stringify((await f.read()).phases));
      } finally { await fresh.dispose(); }
    }],
  ];
  for (const [name, scenario] of scenarios) {
    const f = await fixture(name);
    const firstCheck = report.checks.length;
    try { await scenario(f); }
    catch (error) { report.check(`${name}: completed`, false, String(error)); }
    finally {
      await f.hooks.dispose();
      save(name, { scope: "deterministic real adapter/storage with injected host boundary; not native transport",
        events: f.observations, attempts: f.attempts, calls: f.calls,
        storedBytes: readFileSync(join(await f.store.resolveSessionDir(f.id), "state/todo.json"), "utf8"),
        view: await f.todo.read(f.id), checks: report.checks.slice(firstCheck) });
    }
  }
}

await runProbe("open-gajae-host-todo-probe", async (report, scratch) => {
  // runProbe adds its final isolation check after this callback. Persist from
  // the exit event so that check and actual sandbox removal are in the receipt,
  // including expected failing fault-control runs.
  process.once("exit", () => {
    rmSync(scratch, { recursive: true, force: true });
    const summary = { checks: report.checks, failed: report.failed, cleanup: report.cleanup,
      sandbox: { root: scratch, removed: !existsSync(scratch) } };
    save("summary", summary);
    const receipt = `run-${process.pid}`;
    save(receipt, summary);
    console.log(`NATIVE_TODO_RECEIPT=${join(evidenceDir, `${receipt}.json`)}`);
  });
  console.log("WORKING: task7a - native closed loop");
  for (const [name, run] of [
    ["native-disabled", () => nativeDisabled(report, scratch)],
    ["catalogs", () => catalogs(report, scratch)],
    ["native-off", () => closedLoop(report, scratch, false)],
    ["native-on", () => closedLoop(report, scratch, true)],
    ["native-holds", () => nativeHolds(report, scratch)],
    ["native-mutation-boundaries", () => nativeMutationBoundaries(report, scratch)],
    ["native-accepted-restart", () => nativeAcceptedRestart(report, scratch)],
    ["question-crash-restart", () => nativeQuestionCrash(report, scratch)],
    ["native-budgets-child", () => nativeBudgetsAndChild(report, scratch)],
    ["adapter-races", () => adapterRaces(report, scratch)],
  ] satisfies Array<[string, () => Promise<void>]>) {
    if (disabledOnly && name !== "native-disabled") continue;
    try { await run(); }
    catch (error) { report.check(`${name}: completed`, false, String(error)); save(`${name}-failure`, { error: String(error) }); }
  }
});
