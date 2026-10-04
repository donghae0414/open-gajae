// `open-gajae install`: adds open-gajae to the OpenCode global config and
// creates the user settings template. Importing this file has no side effects;
// bin/open-gajae.mjs is the CLI.
import { constants, existsSync, realpathSync, statSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import jsonc from "jsonc-parser";

const { applyEdits, modify, parse, printParseErrorCode } = jsonc;

// Every setting is a comment, so the code defaults keep applying.
const SETTINGS_TEMPLATE = `{
  // open-gajae user settings. Every setting is commented out, so the defaults apply.
  // To change a setting, remove the // in front of it.
  // A project's .open-gajae/open-gajae.jsonc overrides this file, key by key.
  // Unknown keys and invalid values are errors. Restart OpenCode after editing.
  "deepInterview": {
    // Default 0.05; a number greater than 0 and at most 1.
    // "ambiguityThreshold": 0.05
  },
  "ralplan": {
    // Default 5; an integer from 1 to 20.
    // "maxIterations": 5,
    // Default 1; an integer from 1 to 10.
    // "maxReviewPassesPerLane": 1,
    // Default "off"; "off" or "ultragoal".
    // "autoHandoff": "off"
  },
  "agents": {
    // Without a model, OpenCode picks one. model is "provider/model";
    // variant is a name the model supports and needs a model for the same role.
    "open-gajae": {
      // "model": "provider/model",
      // "variant": "high"
    },
    "open-gajae-explore": {},
    "open-gajae-document-specialist": {},
    "open-gajae-planner": {},
    "open-gajae-architect": {},
    "open-gajae-critic": {},
    "open-gajae-executor": {},
    "open-gajae-cleaner": {},
    "open-gajae-lateral-reviewer": {}
  }
}
`;

const PO = { allowTrailingComma: true };
const formatOptions = (t) => { const ind = /^([ \t]+)"/m.exec(t)?.[1] ?? "  ";
  return { formattingOptions: { insertSpaces: ind[0] !== "\t", tabSize: ind[0] === "\t" ? 1 : ind.length, eol: t.includes("\r\n") ? "\r\n" : "\n" } }; };
const setPath = (t, path, value, extra) => applyEdits(t, modify(t, path, value, { ...formatOptions(t), ...extra }));
function addPlugin(t, spec) {
  const plugins = parse(t, [], PO)?.plugins;
  return Array.isArray(plugins) ? setPath(t, ["plugins", plugins.length], spec, { isArrayInsertion: true }) : setPath(t, ["plugins"], [spec]);
}

/** The host's global config folder (OpenCode v2.0.15 `util/src/global.ts`). */
export function resolveConfigDir(env, home) {
  if (env.OPENCODE_CONFIG_DIR) return env.OPENCODE_CONFIG_DIR;
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
}

// An npm spec `open-gajae` or `open-gajae@…`, or a local path whose last
// segment is `open-gajae`; objects carry it in `.package`, tuples in `[0]`.
function pluginSpec(entry) {
  const spec = typeof entry === "string" ? entry : Array.isArray(entry) ? entry[0] : entry?.package;
  if (typeof spec !== "string") return undefined;
  if (spec === "open-gajae" || spec.startsWith("open-gajae@")) return spec;
  if (/^(\/|\.\/|\.\.\/|file:\/\/)/.test(spec) && spec.replace(/\/+$/, "").split("/").pop() === "open-gajae") return spec;
  return undefined;
}

function parseObject(text, file) {
  const errors = [];
  const root = parse(text, errors, PO);
  if (errors.length) throw new Error(`${file}:${errors[0].offset}: ${printParseErrorCode(errors[0].error)}`);
  if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error(`${file}: expected an object`);
  return root;
}

function timestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export async function install({ configDir, home, now }) {
  // 1. Compute and verify; a failure here writes nothing.
  const jsoncFile = join(configDir, "opencode.jsonc");
  const jsonFile = join(configDir, "opencode.json");
  // jsonc if present, else json if present; a new file is jsonc, as the host's own `Config.update` makes.
  const file = existsSync(jsoncFile) || !existsSync(jsonFile) ? jsoncFile : jsonFile;
  const exists = existsSync(file);
  const original = exists ? await readFile(file, "utf8") : "";
  const text = original.trim() ? original : "{}\n";
  const root = parseObject(text, file);
  for (const key of ["plugins", "plugin"])
    if (root[key] !== undefined && !Array.isArray(root[key])) throw new Error(`${file}: "${key}" is not an array`);
  const experimental = root.experimental;
  if (experimental !== undefined && (!experimental || typeof experimental !== "object" || Array.isArray(experimental)))
    throw new Error(`${file}: "experimental" is not an object`);

  let next = text;
  const present = [...(root.plugins ?? []), ...(root.plugin ?? [])].map(pluginSpec).find((spec) => spec !== undefined);
  let pluginsLine;
  if (present === undefined) {
    next = addPlugin(next, "open-gajae");
    pluginsLine = 'plugins: added "open-gajae"';
  } else pluginsLine = `plugins: kept ${JSON.stringify(present)} (already present)`;
  let agentLine;
  if (root.default_agent === undefined) {
    next = setPath(next, ["default_agent"], "open-gajae");
    agentLine = 'default_agent: set to "open-gajae"';
  } else agentLine = `default_agent: kept ${JSON.stringify(root.default_agent)}`;
  const depth = experimental?.subagent_depth;
  let depthLine;
  if (depth === undefined) {
    next = setPath(next, ["experimental", "subagent_depth"], 2);
    depthLine = "experimental.subagent_depth: set to 2";
  } else if (typeof depth === "number" && depth >= 2) depthLine = `experimental.subagent_depth: kept ${depth}`;
  else depthLine = `experimental.subagent_depth: kept ${JSON.stringify(depth)} (the planner needs 2 or more to delegate research)`;
  parseObject(next, file);
  const changed = next !== original;
  if (exists && process.getuid && statSync(realpathSync(file)).uid !== process.getuid())
    throw new Error(`${realpathSync(file)} is owned by another user; run without sudo`);

  // 2. The settings template, only when it is missing.
  const settingsFile = join(home, ".open-gajae", "open-gajae.jsonc");
  await mkdir(dirname(settingsFile), { recursive: true });
  let settingsLine;
  try { await writeFile(settingsFile, SETTINGS_TEMPLATE, { flag: "wx" }); settingsLine = `settings: ${settingsFile} (created)`; }
  catch (e) { if (e.code !== "EEXIST") throw e; settingsLine = `settings: ${settingsFile} (kept)`; }

  let backup;
  if (exists && changed) {
    // 3. Back up the file next to the path the user sees.
    const real = await realpath(file);
    const stem = join(dirname(file), `${basename(file)}.bak-${timestamp(now())}`);
    for (let n = 0; ; n++) {
      backup = n ? `${stem}-${n}` : stem;
      try { await copyFile(real, backup, constants.COPYFILE_EXCL); break; }
      catch (e) { if (e.code !== "EEXIST") throw e; }
    }
    // 4. Write: a 0600 temp file renamed over the real file keeps links and mode.
    const st = await stat(real);
    const tmp = join(dirname(real), `.${basename(real)}.${process.pid}.tmp`);
    try { await writeFile(tmp, next, { flag: "wx", mode: 0o600 }); await chmod(tmp, st.mode & 0o7777); await rename(tmp, real); }
    catch (e) { await rm(tmp, { force: true }); throw e; }
  } else if (!exists) {
    await mkdir(configDir, { recursive: true });
    await writeFile(file, next, { flag: "wx", mode: 0o600 });
  }

  const lines = [`config: ${file} (${!exists ? "created" : changed ? "updated" : "unchanged"})`];
  if (file === jsoncFile && existsSync(jsonFile))
    lines.push("warning: opencode.json also exists and was not changed; OpenCode reads both files and combines their plugins");
  if (backup) lines.push(`backup: ${backup}`);
  lines.push(pluginsLine, agentLine, depthLine, settingsLine);
  if (changed) lines.push("Restart OpenCode to load open-gajae.");
  return { lines };
}
