import { test, expect } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentNames, loadSettings } from "../src/config";

const lib = await import(new URL("../bin/installer.mjs", import.meta.url).href);
const now = () => new Date("2026-10-04T12:00:00");

// A temp config folder and a temp home, so no test touches the real
// ~/.config/opencode or ~/.open-gajae.
async function fixture(
  files: Record<string, string>,
  run: (configDir: string, home: string, root: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "open-gajae-installer-"));
  try {
    const configDir = join(root, "opencode");
    const home = join(root, "home");
    await mkdir(configDir);
    await mkdir(home);
    for (const [name, text] of Object.entries(files))
      await writeFile(join(configDir, name), text);
    await run(configDir, home, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const T2_JSON = '{\n  "theme": "tokyonight"\n}\n';
const T2_FIXTURE = `{
  // my settings
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["other-plugin"],
  /* provider block */
  "provider": {
    "x": { "a": 1 },
  },
  "theme": "tokyonight" // tail
}
`;
const T2_GOLDEN = `{
  // my settings
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "other-plugin",
    "open-gajae"
  ],
  /* provider block */
  "provider": {
    "x": { "a": 1 },
  },
  "theme": "tokyonight",
  "default_agent": "open-gajae",
  "experimental": {
    "subagent_depth": 2
  } // tail
}
`;

test("T-1: a missing config folder gets a new opencode.jsonc with the three entries", async () => {
  await fixture({}, async (_, home, root) => {
    const configDir = join(root, "missing", "opencode");
    await lib.install({ configDir, home, now });
    expect(await readFile(join(configDir, "opencode.jsonc"), "utf8")).toBe(
      '{\n  "plugins": [\n    "open-gajae"\n  ],\n  "default_agent": "open-gajae",\n  "experimental": {\n    "subagent_depth": 2\n  }\n}\n',
    );
    expect(await readdir(configDir)).toEqual(["opencode.jsonc"]);
  });
});

test("T-2: with both files only opencode.jsonc changes, outside the edited paths byte for byte", async () => {
  await fixture(
    { "opencode.json": T2_JSON, "opencode.jsonc": T2_FIXTURE },
    async (configDir, home) => {
      const { lines } = await lib.install({ configDir, home, now });
      expect(await readFile(join(configDir, "opencode.json"), "utf8")).toBe(T2_JSON);
      expect(await readFile(join(configDir, "opencode.jsonc"), "utf8")).toBe(T2_GOLDEN);
      expect(
        lines.some((line: string) => line.startsWith("warning: opencode.json also exists")),
      ).toBe(true);
    },
  );
});

test("T-3: a second install leaves both files and the backups as they are", async () => {
  await fixture(
    { "opencode.json": T2_JSON, "opencode.jsonc": T2_FIXTURE },
    async (configDir, home) => {
      await lib.install({ configDir, home, now });
      const entries = await readdir(configDir);
      const { lines } = await lib.install({ configDir, home, now });
      expect(await readFile(join(configDir, "opencode.json"), "utf8")).toBe(T2_JSON);
      expect(await readFile(join(configDir, "opencode.jsonc"), "utf8")).toBe(T2_GOLDEN);
      expect(lines).toContain(`config: ${join(configDir, "opencode.jsonc")} (unchanged)`);
      expect((await readdir(configDir)).sort()).toEqual(entries.sort());
    },
  );
});

test("T-4: existing values are kept, with a notice", async () => {
  const done = {
    plugins: ["open-gajae"],
    default_agent: "open-gajae",
    experimental: { subagent_depth: 2 },
  };
  const cases: [Record<string, unknown>, string][] = [
    [{ ...done, default_agent: "build" }, 'default_agent: kept "build"'],
    [
      { ...done, experimental: { subagent_depth: 1 } },
      "experimental.subagent_depth: kept 1 (the planner needs 2 or more to delegate research)",
    ],
    [
      { ...done, plugins: ["open-gajae@0.1.0"] },
      'plugins: kept "open-gajae@0.1.0" (already present)',
    ],
    [
      { ...done, plugins: ["/abs/path/open-gajae"] },
      'plugins: kept "/abs/path/open-gajae" (already present)',
    ],
    [
      { ...done, plugins: undefined, plugin: ["open-gajae"] },
      'plugins: kept "open-gajae" (already present)',
    ],
  ];
  for (const [config, notice] of cases) {
    const text = JSON.stringify(config, null, 2) + "\n";
    await fixture({ "opencode.json": text }, async (configDir, home) => {
      const { lines } = await lib.install({ configDir, home, now });
      expect(await readFile(join(configDir, "opencode.json"), "utf8")).toBe(text);
      expect(lines).toContain(notice);
    });
  }
});

test("T-5: a changed file is backed up first, with -1 when the name is taken", async () => {
  const text = '{\n  "theme": "tokyonight"\n}\n';
  await fixture({ "opencode.jsonc": text }, async (configDir, home) => {
    await lib.install({ configDir, home, now });
    expect(
      await readFile(join(configDir, "opencode.jsonc.bak-20261004-120000"), "utf8"),
    ).toBe(text);
  });
  await fixture(
    { "opencode.jsonc": text, "opencode.jsonc.bak-20261004-120000": "taken" },
    async (configDir, home) => {
      await lib.install({ configDir, home, now });
      expect(
        await readFile(join(configDir, "opencode.jsonc.bak-20261004-120000"), "utf8"),
      ).toBe("taken");
      expect(
        await readFile(join(configDir, "opencode.jsonc.bak-20261004-120000-1"), "utf8"),
      ).toBe(text);
    },
  );
});

test("T-6: the settings template is created only when missing and sets nothing", async () => {
  await fixture({}, async (configDir, home, root) => {
    const settingsFile = join(home, ".open-gajae", "open-gajae.jsonc");
    const worktree = join(root, "worktree");
    const emptyHome = join(root, "empty-home");
    await mkdir(worktree);
    await mkdir(emptyHome);
    const first = await lib.install({ configDir, home, now });
    expect(first.lines).toContain(`settings: ${settingsFile} (created)`);
    const { agents, ...settings } = await loadSettings(worktree, home);
    const { agents: _, ...defaults } = await loadSettings(worktree, emptyHome);
    expect(settings).toEqual(defaults);
    expect(Object.keys(agents)).toEqual([...agentNames]);
    for (const agent of Object.values(agents)) expect(agent).toEqual({});

    const template = await readFile(settingsFile, "utf8");
    const second = await lib.install({ configDir, home, now });
    expect(await readFile(settingsFile, "utf8")).toBe(template);
    expect(second.lines).toContain(`settings: ${settingsFile} (kept)`);
  });
  await fixture({}, async (configDir, home) => {
    const settingsFile = join(home, ".open-gajae", "open-gajae.jsonc");
    await mkdir(join(home, ".open-gajae"));
    await writeFile(settingsFile, "{}\n");
    const { lines } = await lib.install({ configDir, home, now });
    expect(await readFile(settingsFile, "utf8")).toBe("{}\n");
    expect(lines).toContain(`settings: ${settingsFile} (kept)`);
  });
  const done = JSON.stringify(
    { plugins: ["open-gajae"], default_agent: "open-gajae", experimental: { subagent_depth: 2 } },
    null,
    2,
  );
  await fixture({ "opencode.json": done }, async (configDir, home) => {
    const { lines } = await lib.install({ configDir, home, now });
    expect(lines).toContain(`config: ${join(configDir, "opencode.json")} (unchanged)`);
    expect(lines).toContain(
      `settings: ${join(home, ".open-gajae", "open-gajae.jsonc")} (created)`,
    );
    expect(lines).not.toContain("Restart OpenCode to load open-gajae.");
  });
});
