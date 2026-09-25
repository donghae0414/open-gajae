import { test, expect } from "bun:test";
import { join } from "node:path";
import {
  artifactPathsOf,
  isUltragoalOwned,
  projectRelative,
  sessionArtifactOwner,
} from "../src/artifact-guard";

const PROJECT = "/tmp/open-gajae-guard-fixture";
const SUB = join(PROJECT, "sub");
const OWNER = "_session-20260918-030958-ses_root";

function patch(...lines: string[]) {
  return ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
}

test("artifactPathsOf reads write and edit paths and ignores other tools", () => {
  expect(artifactPathsOf("write", { path: "a.md", content: "x" })).toEqual([
    "a.md",
  ]);
  expect(
    artifactPathsOf("edit", { path: "/abs/b.md", oldString: "x" }),
  ).toEqual(["/abs/b.md"]);
  // A missing, empty, or non-string path is nothing this guard can judge.
  expect(artifactPathsOf("write", { content: "x" })).toEqual([]);
  expect(artifactPathsOf("write", { path: "" })).toEqual([]);
  expect(artifactPathsOf("write", { path: 7 })).toEqual([]);
  expect(artifactPathsOf("write", undefined)).toEqual([]);
  // v1 input names and tools are not v2 artifact inputs.
  expect(artifactPathsOf("write", { filePath: "a.md" })).toEqual([]);
  for (const tool of ["read", "shell", "subagent", "skill", "apply_patch"])
    expect(artifactPathsOf(tool, { path: "a.md" })).toEqual([]);
});

test("artifactPathsOf reads all four patch markers, including indented ones", () => {
  const patchText = patch(
    "*** Add File: added.md",
    "+hello",
    "  *** Update File: src/updated.ts",
    "\t*** Move to: src/moved.ts  ",
    "@@",
    "-old",
    "+new",
    " *** Delete File: gone.md",
  );
  expect(artifactPathsOf("patch", { patchText })).toEqual([
    "added.md",
    "src/updated.ts",
    "src/moved.ts",
    "gone.md",
  ]);
  // CRLF patches and a non-string argument.
  expect(
    artifactPathsOf("patch", {
      patchText: "*** Begin Patch\r\n*** Add File: crlf.md\r\n+x\r\n",
    }),
  ).toEqual(["crlf.md"]);
  expect(artifactPathsOf("patch", { patchText: 3 })).toEqual([]);
  expect(artifactPathsOf("patch", { patchText: patch() })).toEqual([]);
  // An added line whose content looks like a marker is content.
  expect(
    artifactPathsOf("patch", {
      patchText: patch("*** Add File: real.md", "+*** Add File: quoted.md"),
    }),
  ).toEqual(["real.md"]);
});

test("projectRelative resolves against the location and relativizes to the project", () => {
  expect(projectRelative(PROJECT, PROJECT, "src/x.ts")).toBe("src/x.ts");
  expect(projectRelative(PROJECT, PROJECT, join(PROJECT, "src/x.ts"))).toBe(
    "src/x.ts",
  );
  expect(projectRelative(PROJECT, PROJECT, PROJECT)).toBe("");
  // A subdirectory launch: relative input resolves against the location.
  expect(projectRelative(SUB, PROJECT, "x.ts")).toBe("sub/x.ts");
  expect(projectRelative(SUB, PROJECT, "../x.ts")).toBe("x.ts");
  expect(projectRelative(SUB, PROJECT, "../../x.ts")).toBeUndefined();
  expect(projectRelative(PROJECT, PROJECT, "/elsewhere/x.ts")).toBeUndefined();
  expect(projectRelative(PROJECT, PROJECT, "../x.ts")).toBeUndefined();
  // A sibling whose name starts with ".." is still inside.
  expect(projectRelative(PROJECT, PROJECT, "..data/x")).toBe("..data/x");
  expect(projectRelative(PROJECT, PROJECT, "")).toBeUndefined();
});

test("sessionArtifactOwner names the owning session folder for plans and drafts", () => {
  for (const kind of ["plans", "drafts"]) {
    const relative = `.open-gajae/${OWNER}/${kind}/plan.md`;
    expect(sessionArtifactOwner(PROJECT, PROJECT, relative)).toBe(OWNER);
    expect(
      sessionArtifactOwner(PROJECT, PROJECT, join(PROJECT, relative)),
    ).toBe(OWNER);
    expect(
      sessionArtifactOwner(
        PROJECT,
        PROJECT,
        `.open-gajae/${OWNER}/${kind}/deep/plan.md`,
      ),
    ).toBe(OWNER);
    expect(sessionArtifactOwner(PROJECT, PROJECT, `./${relative}`)).toBe(OWNER);
    // From a subdirectory location, `../` reaches the project's folder (A3).
    expect(sessionArtifactOwner(SUB, PROJECT, `../${relative}`)).toBe(OWNER);
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
    "/etc/passwd",
    `../other/.open-gajae/${OWNER}/plans/plan.md`,
    `.open-gajae/${OWNER}/plans/../../../escape.md`,
    join(PROJECT, ".."),
  ])
    expect(sessionArtifactOwner(PROJECT, PROJECT, path)).toBeUndefined();
  expect(sessionArtifactOwner(PROJECT, PROJECT, "")).toBeUndefined();
  expect(sessionArtifactOwner(PROJECT, PROJECT, PROJECT)).toBeUndefined();
  // From a subdirectory, a path without `../` is under `sub/`, not a session.
  expect(
    sessionArtifactOwner(SUB, PROJECT, `.open-gajae/${OWNER}/plans/p.md`),
  ).toBeUndefined();
  // Traversal that lands back inside is judged by where it lands.
  expect(
    sessionArtifactOwner(
      PROJECT,
      PROJECT,
      `.open-gajae/other/../${OWNER}/plans/plan.md`,
    ),
  ).toBe(OWNER);
});

test("ultragoal files and state are owned by the ultragoal tool from any location", () => {
  const table: [string, string, boolean][] = [
    [PROJECT, `.open-gajae/${OWNER}/ultragoal/goals.json`, true],
    [PROJECT, `.open-gajae/${OWNER}/ultragoal/progress.txt`, true],
    [PROJECT, `.open-gajae/${OWNER}/ultragoal`, true],
    [PROJECT, `.open-gajae/${OWNER}/state/ultragoal-state.json`, true],
    [SUB, `../.open-gajae/${OWNER}/ultragoal/goals.json`, true],
    [PROJECT, join(PROJECT, `.open-gajae/${OWNER}/state/ultragoal-state.json`), true],
    [PROJECT, `.open-gajae/${OWNER}/state/ralplan-state.json`, false],
    [PROJECT, `.open-gajae/${OWNER}/plans/ultragoal.md`, false],
    [PROJECT, "src/ultragoal.ts", false],
  ];
  for (const [location, path, owned] of table)
    expect(`${path}: ${isUltragoalOwned(location, PROJECT, path)}`).toBe(
      `${path}: ${owned}`,
    );
});
