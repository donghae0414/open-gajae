import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const base = await mkdtemp(join(tmpdir(), "open-gajae-package-"));
const consumer = join(base, "consumer"),
  home = join(base, "home");
const evidence: {
  command: string[];
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}[] = [];
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, "config"),
  XDG_CACHE_HOME: join(home, "cache"),
  XDG_DATA_HOME: join(home, "data"),
  XDG_STATE_HOME: join(home, "state"),
};
async function run(command: string[], cwd: string) {
  const child = Bun.spawn(command, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 60000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    evidence.push({ command, cwd, exitCode, stdout, stderr });
    if (exitCode !== 0)
      throw new Error(`${command.join(" ")} exited ${exitCode}\n${stderr}`);
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}
try {
  await mkdir(consumer);
  await mkdir(home);
  await run([process.execPath, "pm", "pack", "--destination", base], root);
  const archive = (await readdir(base)).find((name) => name.endsWith(".tgz"));
  if (!archive) throw new Error("Package archive was not produced");
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "open-gajae-fixture-consumer",
      private: true,
      type: "module",
    }),
  );
  await run([process.execPath, "add", join(base, archive)], consumer);
  const script = `
import plugin from 'open-gajae';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const worktree=process.cwd();
// The plugin resolves each session's creation time through the host client.
const client={session:{get:async({path})=>({data:{id:path.id,time:{created:Date.parse('2026-09-18T03:09:58+09:00')}},error:undefined})}};
const hooks=await plugin({worktree,client});
const config={agent:{build:{prompt:'unchanged'}},permission:{read:'allow'}};
await hooks.config(config);
if(config.agent.build.prompt!=='unchanged')throw new Error('Unrelated primary changed');
for(const name of ['open-gajae','open-gajae-explore','open-gajae-document-specialist'])if(!config.agent[name]?.prompt)throw new Error('Missing packaged role '+name);
const ctx={agent:'open-gajae',sessionID:'package-session',messageID:'m',directory:worktree,worktree,abort:new AbortController().signal,metadata(){},async ask(){}};
const result=JSON.parse(await hooks.tool.state_write.execute({mode:'deep-interview',state:{consumer:true}},ctx));
if(result.state.consumer!==true)throw new Error('Packaged state API failed');
await writeFile(join(worktree,'sample.ts'),'console.log(42);');
const found=await hooks.tool.ast_grep_search.execute({pattern:'console.log($X)',language:'typescript',path:'sample.ts'},ctx);
if(!found.includes('Found 1 match'))throw new Error('Packaged native dependency failed: '+found);
await mkdir(result.specsDir,{recursive:true});const doc=join(result.specsDir,'deep-interview-package.md');await writeFile(doc,'# Consumer spec');
await hooks.tool.state_clear.execute({mode:'deep-interview'},ctx);
if(await readFile(doc,'utf8')!=='# Consumer spec')throw new Error('Clear deleted document');
console.log(JSON.stringify({status:'passed',tools:Object.keys(hooks.tool),skillPaths:config.skills.paths,roles:Object.keys(config.agent),statePath:result.statePath}));
`;
  await writeFile(join(consumer, "verify.mjs"), script);
  await run([process.execPath, "verify.mjs"], consumer);
  console.log(
    JSON.stringify(
      {
        kind: "package-consumer-report",
        status: "passed",
        evidence,
        limitations: [
          "Consumer process is standalone Bun; installed OpenCode coverage is separate.",
          "No registry publication was performed.",
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        kind: "package-consumer-report",
        status: "failed",
        error: String(error),
        evidence,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  await rm(base, { recursive: true, force: true });
}
