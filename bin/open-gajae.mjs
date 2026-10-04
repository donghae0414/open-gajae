#!/usr/bin/env node
import { homedir } from "node:os";
import { install, resolveConfigDir } from "./installer.mjs";

const usage = `Usage: open-gajae install

Adds open-gajae to your OpenCode global config (opencode.jsonc, or
opencode.json) and creates ~/.open-gajae/open-gajae.jsonc if it is missing.
Existing values are kept, and a changed config file is backed up first.`;

const args = process.argv.slice(2);
if (args.length === 0 || ["help", "--help", "-h"].includes(args[0])) {
  console.log(usage);
} else if (args.length !== 1 || args[0] !== "install") {
  console.error(usage);
  process.exitCode = 1;
} else {
  try {
    const { lines } = await install({
      configDir: resolveConfigDir(process.env, homedir()),
      home: homedir(),
      now: () => new Date(),
    });
    for (const line of lines) console.log(line);
  } catch (error) {
    console.error(`open-gajae: ${error.message}`);
    process.exitCode = 1;
  }
}
