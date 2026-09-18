import { test, expect } from "bun:test";
import { join } from "node:path";
import {
  artifactPathsOf,
  sessionArtifactOwner,
  worktreeRelativePath,
} from "../src/artifact-guard";

const WORKTREE = "/tmp/open-gajae-guard-fixture";
const OWNER = "_session-20260918-030958-ses_root";

function patch(...lines: string[]) {
  return ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
}

test("artifactPathsOf reads write and edit file paths and ignores other tools", () => {
  expect(artifactPathsOf("write", { filePath: "a.md", content: "x" })).toEqual([
    "a.md",
  ]);
  expect(
    artifactPathsOf("edit", { filePath: "/abs/b.md", oldString: "x" }),
  ).toEqual(["/abs/b.md"]);
  // A missing, empty, or non-string path is nothing this guard can judge.
  expect(artifactPathsOf("write", { content: "x" })).toEqual([]);
  expect(artifactPathsOf("write", { filePath: "" })).toEqual([]);
  expect(artifactPathsOf("write", { filePath: 7 })).toEqual([]);
  expect(artifactPathsOf("write", undefined)).toEqual([]);
  for (const tool of ["read", "bash", "task", "skill", "state_write"])
    expect(artifactPathsOf(tool, { filePath: "a.md" })).toEqual([]);
});

test("artifactPathsOf reads all four apply_patch markers", () => {
  const patchText = patch(
    "*** Add File: added.md",
    "+hello",
    "*** Update File: src/updated.ts",
    "*** Move to: src/moved.ts",
    "@@",
    "-old",
    "+new",
    "*** Delete File: gone.md",
  );
  expect(artifactPathsOf("apply_patch", { patchText })).toEqual([
    "added.md",
    "src/updated.ts",
    "src/moved.ts",
    "gone.md",
  ]);
  // CRLF patches and a non-string argument.
  expect(
    artifactPathsOf("apply_patch", {
      patchText: "*** Begin Patch\r\n*** Add File: crlf.md\r\n+x\r\n",
    }),
  ).toEqual(["crlf.md"]);
  expect(artifactPathsOf("apply_patch", { patchText: 3 })).toEqual([]);
  expect(artifactPathsOf("apply_patch", { patchText: patch() })).toEqual([]);
  // A marker inside patch content, not at the start of a line, is content.
  expect(
    artifactPathsOf("apply_patch", {
      patchText: patch("*** Add File: real.md", "+*** Add File: quoted.md"),
    }),
  ).toEqual(["real.md"]);
});

test("sessionArtifactOwner names the owning session folder for plans and drafts", () => {
  for (const kind of ["plans", "drafts"]) {
    const relative = `.open-gajae/${OWNER}/${kind}/plan.md`;
    expect(sessionArtifactOwner(WORKTREE, relative)).toBe(OWNER);
    expect(sessionArtifactOwner(WORKTREE, join(WORKTREE, relative))).toBe(
      OWNER,
    );
    // A nested file under plans still belongs to the same session.
    expect(
      sessionArtifactOwner(WORKTREE, `${relative.slice(0, -8)}/deep/plan.md`),
    ).toBe(OWNER);
    expect(sessionArtifactOwner(WORKTREE, `./${relative}`)).toBe(OWNER);
  }
});

test("sessionArtifactOwner leaves every other path to the static rules", () => {
  for (const path of [
    `.open-gajae/${OWNER}/specs/spec.md`,
    `.open-gajae/${OWNER}/state/ralplan-state.json`,
    `.open-gajae/${OWNER}/plans`,
    ".open-gajae/open-gajae.jsonc",
    ".open-gajae/plans/plan.md",
    "src/x.ts",
    "plans/plan.md",
    // Outside the worktree, absolute or by traversal.
    "/etc/passwd",
    `../other/.open-gajae/${OWNER}/plans/plan.md`,
    `.open-gajae/${OWNER}/plans/../../../escape.md`,
    join(WORKTREE, ".."),
  ])
    expect(sessionArtifactOwner(WORKTREE, path)).toBeUndefined();
  expect(sessionArtifactOwner(WORKTREE, "")).toBeUndefined();
  // The worktree itself is not a file under it.
  expect(sessionArtifactOwner(WORKTREE, WORKTREE)).toBeUndefined();
  // Traversal that lands back inside is judged by where it lands.
  expect(
    sessionArtifactOwner(
      WORKTREE,
      `.open-gajae/other/../${OWNER}/plans/plan.md`,
    ),
  ).toBe(OWNER);
});

test("worktreeRelativePath normalizes into the worktree or refuses", () => {
  expect(worktreeRelativePath(WORKTREE, join(WORKTREE, "src/x.ts"))).toBe(
    "src/x.ts",
  );
  expect(worktreeRelativePath(WORKTREE, "src/x.ts")).toBe("src/x.ts");
  expect(worktreeRelativePath(WORKTREE, "/elsewhere/x.ts")).toBeUndefined();
  expect(worktreeRelativePath(WORKTREE, "../x.ts")).toBeUndefined();
});
