import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSidebar, type SidebarOptions } from "../tui-plugin/sidebar";

const ROOT = "ses_x";

/** A gjc `skill-active-state.json` snapshot holding the given entries. */
function snapshot(entries: object[]) {
  return JSON.stringify({
    version: 1,
    active: entries.length > 0,
    skill: entries.length > 0 ? "ralplan" : "",
    phase: "",
    updated_at: "2026-09-28T12:00:00.000Z",
    session_id: ROOT,
    active_skills: entries,
    active_subskills: [],
  });
}

test("sidebar finds the session folder from a subdirectory and follows the snapshot and the locked state phase", async () => {
  const repo = await mkdtemp(join(tmpdir(), "open-gajae-tui-"));
  const stateDir = join(
    repo,
    ".open-gajae",
    `_session-20260928-120000-${ROOT}`,
    "state",
  );
  const file = join(stateDir, "skill-active-state.json");
  const location = join(repo, "packages", "app");
  await mkdir(join(repo, ".git"));
  await mkdir(location, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    file,
    snapshot([
      {
        skill: "ralplan",
        phase: "planner",
        active: true,
        session_id: ROOT,
        hud: {
          version: 1,
          chips: [
            { label: "iter", value: "1", priority: 30 },
            { label: "stage", value: "planner", priority: 10 },
          ],
        },
      },
    ]),
  );

  // The first lookup is a TUI cache miss (one host load requested); later ones
  // place the root session in a subdirectory of the repository.
  let lookups = 0;
  const synced: string[] = [];
  const color = RGBA.fromInts(200, 200, 200);
  const feedback = { base: color, muted: color };
  const ctx = {
    theme: {
      text: {
        base: color,
        muted: color,
        feedback: {
          error: feedback,
          warning: feedback,
          success: feedback,
          info: feedback,
        },
      },
    },
    data: {
      session: {
        root: () => ROOT,
        get: (id: string) =>
          lookups++ === 0
            ? undefined
            : { id, location: { directory: location } },
        sync: async (id: string) => {
          synced.push(id);
        },
      },
    },
  } as unknown as SidebarOptions["ctx"];
  const render = createSidebar({ ctx, pollMs: 10 });
  const app = await testRender(() => render({ sessionID: ROOT }), {
    width: 40,
    height: 10,
  });

  const frameUntil = async (done: (frame: string) => boolean) => {
    const deadline = Date.now() + 2000;
    let frame = "";
    do {
      await Bun.sleep(10);
      await app.renderOnce();
      frame = app.captureCharFrame();
    } while (!done(frame) && Date.now() < deadline);
    return frame;
  };

  try {
    await app.renderOnce();
    expect(lookups).toBe(1);
    expect(synced).toEqual([ROOT]);
    expect(app.captureCharFrame()).not.toContain("ralplan");

    let frame = await frameUntil((text) => text.includes("ralplan"));
    expect(frame).toContain("ralplan");
    expect(frame).toContain("stage=planner");
    expect(frame).toContain("iter=1");
    expect(frame.indexOf("stage=planner")).toBeLessThan(
      frame.indexOf("iter=1"),
    );

    // R-OD15: a locked mode-state phase replaces the entry's stage chip (gjc
    // `withCanonicalRalplanPhase`).
    await writeFile(
      file,
      snapshot([
        {
          skill: "ralplan",
          phase: "revision",
          active: true,
          session_id: ROOT,
          hud: {
            version: 1,
            chips: [{ label: "stage", value: "revision", priority: 10 }],
          },
        },
      ]),
    );
    frame = await frameUntil((text) => text.includes("stage=revision"));
    expect(frame).toContain("stage=revision");
    await writeFile(
      join(stateDir, "ralplan-state.json"),
      JSON.stringify({ skill: "ralplan", active: true, current_phase: "final" }),
    );
    frame = await frameUntil((text) => text.includes("stage=final"));
    expect(frame).toContain("stage=final");
    expect(frame).not.toContain("stage=revision");

    // Inactive but awaiting approval still shows (D-H6).
    await writeFile(
      file,
      snapshot([
        {
          skill: "ralplan",
          phase: "final",
          active: false,
          session_id: ROOT,
          hud: {
            version: 1,
            chips: [
              {
                label: "pending",
                value: "approval",
                priority: 5,
                severity: "warning",
              },
              { label: "iter", value: "2", priority: 30 },
            ],
          },
        },
      ]),
    );
    frame = await frameUntil((text) => text.includes("pending=approval"));
    expect(frame).toContain("pending=approval");
    expect(frame).toContain("iter=2");
    expect(frame).not.toContain("stage=planner");

    await writeFile(file, snapshot([]));
    frame = await frameUntil((text) => !text.includes("ralplan"));
    expect(frame).not.toContain("ralplan");
  } finally {
    app.renderer.destroy();
    await rm(repo, { recursive: true, force: true });
  }
});
