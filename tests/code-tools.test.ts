import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ToolContext } from "@opencode-ai/plugin";
import { astGrepSearchTool } from "../src/tools/ast-tools";
import { authorizePath } from "../src/tools/permissions";

async function fixture(run: (root: string, outside: string) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), "open-gajae-code-tools-"));
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
function context(
  root: string,
  ask: ToolContext["ask"] = async () => {},
): ToolContext {
  return {
    agent: "open-gajae-explore",
    sessionID: "s",
    messageID: "m",
    directory: root,
    worktree: root,
    abort: new AbortController().signal,
    metadata() {},
    ask,
  };
}
async function search(
  root: string,
  args: Record<string, unknown>,
  ctx = context(root),
) {
  return astGrepSearchTool.execute(
    z.object(astGrepSearchTool.args).parse(args),
    ctx,
  );
}
describe("OMC read-only AST search through native permissions", () => {
  test("real napi finds bounded matches with source line context", async () =>
    fixture(async (root) => {
      await writeFile(
        join(root, "input.ts"),
        "const x = 1;\nconsole.log(x);\nconsole.log(2);\n",
      );
      const output = await search(root, {
        pattern: "console.log($X)",
        language: "typescript",
        context: 0,
        maxResults: 1,
      });
      expect(output).toContain("Found 1 match(es) in 1 file(s)");
      expect(output).toContain("input.ts:2");
      expect(output).toContain(">    2: console.log(x);");
      expect(output).not.toContain("console.log(2)");
    }));
  test("distinguishes no files and no matches", async () =>
    fixture(async (root) => {
      expect(
        await search(root, {
          pattern: "console.log($X)",
          language: "typescript",
        }),
      ).toContain("No typescript files found");
      await writeFile(join(root, "input.ts"), "export const x = 1;");
      expect(
        await search(root, {
          pattern: "console.log($X)",
          language: "typescript",
        }),
      ).toContain("No matches found for pattern");
    }));
  test("uses caller directory and skips excluded source directories", async () =>
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
      const output = await search(
        root,
        { pattern: "console.log($X)", language: "typescript" },
        { ...context(root), directory: cwd },
      );
      expect(output).toContain("child.ts");
      expect(output).not.toContain("parent.ts");
      expect(output).not.toContain("ignored.ts");
    }));
  test("rejects nonowned actors and tool denials before parsing", async () =>
    fixture(async (root) => {
      const args = { pattern: "console.log($X)", language: "typescript" };
      let asked = false;
      await expect(
        search(root, args, {
          ...context(root, async () => {
            asked = true;
          }),
          agent: "build",
        }),
      ).rejects.toThrow("cannot use");
      expect(asked).toBe(false);
      await expect(
        search(
          root,
          args,
          context(root, async () => {
            throw new Error("operation denied");
          }),
        ),
      ).rejects.toThrow("operation denied");
    }));
  test("recursive read denial is never converted to no matches", async () =>
    fixture(async (root) => {
      await writeFile(join(root, "secret.ts"), "console.log('private');");
      const ctx = context(root, async (input) => {
        if (
          input.permission === "read" &&
          input.patterns.some((p) => p.endsWith("secret.ts"))
        )
          throw new Error("read denied");
      });
      await expect(
        search(
          root,
          { pattern: "console.log($X)", language: "typescript" },
          ctx,
        ),
      ).rejects.toThrow("permission was denied");
    }));
  test("canonical external symlink requires permission and cycles terminate", async () =>
    fixture(async (root, outside) => {
      await writeFile(join(outside, "external.ts"), "console.log('outside');");
      await symlink(join(outside, "external.ts"), join(root, "linked.ts"));
      const denied = context(root, async (input) => {
        if (input.permission === "external_directory")
          throw new Error("external denied");
      });
      await expect(
        search(
          root,
          { pattern: "console.log($X)", language: "typescript" },
          denied,
        ),
      ).rejects.toThrow("permission was denied");
      await rm(join(root, "linked.ts"));
      await symlink(root, join(root, "cycle"));
      expect(
        await search(root, {
          pattern: "console.log($X)",
          language: "typescript",
        }),
      ).toContain("No typescript files found");
    }));
  test("schema rejects out-of-range and unsupported inputs", () => {
    const schema = z.object(astGrepSearchTool.args);
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
      await expect(
        authorizePath(context(root), "missing.ts"),
      ).rejects.toThrow();
    }));
});
