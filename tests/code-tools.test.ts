import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { astGrepSearchTool } from "../src/tools/ast-tools";
import type { ToolCallContext } from "../src/tools/define";
import {
  type CodeToolPaths,
  resolveProjectPath,
} from "../src/tools/permissions";

async function fixture(run: (root: string, outside: string) => Promise<void>) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "open-gajae-code-tools-")),
  );
  const root = join(base, "project");
  const outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  try {
    await run(root, outside);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}
function context(agent = "open-gajae-explore"): ToolCallContext {
  return { agent, sessionID: "s", signal: new AbortController().signal };
}
const at = (root: string, locationDir = root): CodeToolPaths => ({
  locationDir,
  projectDir: root,
});
async function search(
  paths: CodeToolPaths,
  args: Record<string, unknown>,
  ctx = context(),
) {
  const tool = astGrepSearchTool(paths);
  return (await tool.execute(tool.input.parse(args), ctx)).content;
}
const TS = { pattern: "console.log($X)", language: "typescript" };

describe("OMC read-only AST search inside the project boundary", () => {
  test("real napi finds bounded matches with source line context", async () =>
    fixture(async (root) => {
      await writeFile(
        join(root, "input.ts"),
        "const x = 1;\nconsole.log(x);\nconsole.log(2);\n",
      );
      const output = await search(at(root), { ...TS, context: 0, maxResults: 1 });
      expect(output).toContain("Found 1 match(es) in 1 file(s)");
      expect(output).toContain("input.ts:2");
      expect(output).toContain(">    2: console.log(x);");
      expect(output).not.toContain("console.log(2)");
    }));
  test("distinguishes no files and no matches", async () =>
    fixture(async (root) => {
      expect(await search(at(root), TS)).toContain("No typescript files found");
      await writeFile(join(root, "input.ts"), "export const x = 1;");
      expect(await search(at(root), TS)).toContain(
        "No matches found for pattern",
      );
    }));
  test("defaults to the location directory and skips excluded source directories", async () =>
    fixture(async (root) => {
      const cwd = join(root, "sub");
      await mkdir(cwd);
      await mkdir(join(cwd, "node_modules"));
      await writeFile(join(root, "parent.ts"), "console.log('parent');");
      await writeFile(
        join(cwd, "node_modules", "ignored.ts"),
        "console.log('ignored');",
      );
      await writeFile(join(cwd, "child.ts"), "console.log('child');");
      const output = await search(at(root, cwd), TS);
      expect(output).toContain("child.ts");
      expect(output).not.toContain("parent.ts");
      expect(output).not.toContain("ignored.ts");
      // `../x` from a subdirectory location stays inside the project.
      expect(await search(at(root, cwd), { ...TS, path: "../parent.ts" })).toContain(
        "parent.ts",
      );
    }));
  test("all six owned roles may search; a non-owned agent gets refusal content", async () =>
    fixture(async (root) => {
      await writeFile(join(root, "input.ts"), "console.log(1);");
      for (const agent of [
        "open-gajae",
        "open-gajae-explore",
        "open-gajae-architect",
        "open-gajae-critic",
        "open-gajae-planner",
        "open-gajae-document-specialist",
      ])
        expect(await search(at(root), TS, context(agent))).toContain(
          "Found 1 match",
        );
      expect(await search(at(root), TS, context("build"))).toContain(
        "cannot use open-gajae code tools",
      );
    }));
  test("an outside path, an escaping symlink, .env and .env.local are refused as content", async () =>
    fixture(async (root, outside) => {
      await writeFile(join(outside, "external.ts"), "console.log('outside');");
      await symlink(join(outside, "external.ts"), join(root, "linked.ts"));
      await writeFile(join(root, ".env"), "SECRET=1");
      await writeFile(join(root, ".env.local"), "SECRET=2");
      for (const path of [
        join(outside, "external.ts"),
        "../outside/external.ts",
        "linked.ts",
        ".env",
        ".env.local",
      ]) {
        const output = await search(at(root), { ...TS, path });
        expect(output).toStartWith("Error: ");
        expect(output).not.toContain("outside');");
      }
      // During traversal the escaping link is skipped, not followed.
      await writeFile(join(root, "inside.ts"), "console.log('inside');");
      const output = await search(at(root), TS);
      expect(output).toContain("inside.ts");
      expect(output).not.toContain("external.ts");
    }));
  test("ast_grep_search returns nothing from .env* files and cycles terminate", async () =>
    fixture(async (root) => {
      // `.env.ts` has a searchable extension but an environment-file name.
      await writeFile(join(root, ".env.ts"), "console.log('secret');");
      await symlink(root, join(root, "cycle"));
      expect(await search(at(root), TS)).toContain("No typescript files found");
    }));
  test("schema rejects out-of-range and unsupported inputs", () => {
    const schema = astGrepSearchTool(at("/")).input;
    for (const extra of [
      { context: -1 },
      { context: 11 },
      { maxResults: 0 },
      { maxResults: 101 },
      { maxResults: 1.5 },
      { language: "nonsense" },
    ])
      expect(
        schema.safeParse({ pattern: "$X", language: "typescript", ...extra })
          .success,
      ).toBe(false);
    for (const context of [0, 10])
      for (const maxResults of [1, 100])
        expect(
          schema.safeParse({
            pattern: "$X",
            language: "typescript",
            context,
            maxResults,
          }).success,
        ).toBe(true);
  });
  test("missing files produce a real path failure", async () =>
    fixture(async (root) => {
      await expect(resolveProjectPath(at(root), "missing.ts")).rejects.toThrow();
    }));
});
