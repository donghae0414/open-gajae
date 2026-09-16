import { test, expect, spyOn } from "bun:test";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolContext } from "@opencode-ai/plugin";
import { LspClient, lspManager } from "../src/tools/lsp/client";
import {
  lspDocumentSymbolsTool,
  lspFindReferencesTool,
  lspWorkspaceSymbolsTool,
  lspServersTool,
} from "../src/tools/lsp-tools";

// Deterministic protocol peer, confined to a disposable fixture. Not a shipped backend.
const peer = `
let buffer=Buffer.alloc(0);let uri;let content;
const send=(m)=>{let s=JSON.stringify(m);process.stdout.write('Content-Length: '+Buffer.byteLength(s)+'\\r\\n\\r\\n'+s)};
process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);for(;;){let h=buffer.indexOf('\\r\\n\\r\\n');if(h<0)return;let len=Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0,h).toString())[1]);if(buffer.length<h+4+len)return;let m=JSON.parse(buffer.subarray(h+4,h+4+len));buffer=buffer.subarray(h+4+len);if(m.method==='textDocument/didOpen'){uri=m.params.textDocument.uri;content=m.params.textDocument.text;continue}if(m.method==='exit'){process.exit(0)}if(m.id===undefined)continue;let result=null;if(m.method==='initialize')result={capabilities:{referencesProvider:true,documentSymbolProvider:true,workspaceSymbolProvider:true}};else if(m.method==='textDocument/references')result=[{uri:uri,range:{start:m.params.position,end:{line:m.params.position.line,character:m.params.position.character+1}}}];else if(m.method==='textDocument/documentSymbol')result=[{name:content.includes('answer')?'answer':'missing-document',kind:13,range:{start:{line:0,character:0},end:{line:0,character:6}},selectionRange:{start:{line:0,character:0},end:{line:0,character:6}}}];else if(m.method==='workspace/symbol'){if(m.params.query==='crash'){process.exit(7)}if(m.params.query==='hang')continue;if(m.params.query==='error'){send({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'fixture server error'}});continue}result=[{name:m.params.query,kind:13,location:{uri,range:{start:{line:0,character:0},end:{line:0,character:6}}}}]};send({jsonrpc:'2.0',id:m.id,result})}});
`;
async function fixture(
  run: (root: string, file: string, client: LspClient) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "open-gajae-lsp-"));
  const file = join(root, "input.ts");
  await writeFile(file, "const answer = 42;\n");
  const client = new LspClient(root, {
    name: "fixture",
    command: process.execPath,
    args: ["-e", peer],
    extensions: [".ts"],
    installHint: "fixture only",
  });
  try {
    await run(root, file, client);
  } finally {
    await client.disconnect();
    await rm(root, { recursive: true, force: true });
  }
}
function context(
  root: string,
  ask: ToolContext["ask"] = async () => {},
): ToolContext {
  return {
    agent: "open-gajae",
    sessionID: "s",
    messageID: "m",
    directory: root,
    worktree: root,
    abort: new AbortController().signal,
    metadata() {},
    ask,
  };
}
test("real stdio initialize/didOpen/references/symbols/shutdown", async () =>
  fixture(async (_root, file, client) => {
    await client.connect();
    const refs = await client.references(file, 0, 6, false);
    expect(refs).toEqual([
      {
        uri: pathToFileURL(file).href,
        range: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 7 },
        },
      },
    ]);
    const symbols = await client.documentSymbols(file);
    expect(symbols?.[0]?.name).toBe("answer");
    const workspace = await client.workspaceSymbols("needle");
    expect(workspace?.[0]?.name).toBe("needle");
    await expect(client.workspaceSymbols("error")).rejects.toThrow(
      "fixture server error",
    );
    expect((await client.workspaceSymbols("after-error"))?.[0]?.name).toBe(
      "after-error",
    );
    await client.disconnect();
    expect(client.isUsable).toBe(false);
  }));
test("server exit rejects in-flight work instead of hanging", async () =>
  fixture(async (_root, _file, client) => {
    await client.connect();
    await expect(client.workspaceSymbols("crash")).rejects.toThrow();
    expect(client.isUsable).toBe(false);
  }));
test("force kill rejects pending requests", async () =>
  fixture(async (_root, _file, client) => {
    await client.connect();
    const pending = client
      .workspaceSymbols("hang")
      .catch((error: unknown) => error);
    client.forceKill();
    const failure = await pending;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("force-killed");
  }));
test("missing executable reports installation hint", async () =>
  fixture(async (root) => {
    const client = new LspClient(root, {
      name: "missing",
      command: "open-gajae-no-such-test-server",
      args: [],
      extensions: [".bad"],
      installHint: "fixture installation hint",
    });
    await expect(client.connect()).rejects.toThrow("fixture installation hint");
    client.forceKill();
  }));
test("LSP native permission and actor denial precede backend calls", async () =>
  fixture(async (root, file) => {
    const lease = spyOn(lspManager, "runWithClientLease");
    try {
      const denied = context(root, async (input) => {
        if (input.permission === "lsp") throw new Error("lsp denied");
      });
      await expect(
        lspDocumentSymbolsTool.execute({ file }, denied),
      ).rejects.toThrow("lsp denied");
      await expect(
        lspFindReferencesTool.execute({ file, line: 1, character: 0 }, denied),
      ).rejects.toThrow("lsp denied");
      await expect(
        lspWorkspaceSymbolsTool.execute({ file, query: "x" }, denied),
      ).rejects.toThrow("lsp denied");
      await expect(
        lspServersTool.execute({}, { ...context(root), agent: "build" }),
      ).rejects.toThrow("cannot use");
      expect(lease).not.toHaveBeenCalled();
    } finally {
      lease.mockRestore();
    }
  }));
test("manager deduplicates concurrent connections and releases failed leases", async () =>
  fixture(async (root) => {
    const oldPath = process.env.PATH;
    const bin = join(root, "bin");
    await mkdir(bin);
    await mkdir(join(root, ".git"));
    const file = join(root, "input.json");
    await writeFile(file, '{"answer":42}');
    await writeFile(
      join(bin, "vscode-json-language-server"),
      `#!${process.execPath}\n${peer}`,
      { mode: 0o700 },
    );
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
    try {
      const [a, b] = await Promise.all([
        lspManager.getClientForFile(file),
        lspManager.getClientForFile(file),
      ]);
      expect(a).not.toBeNull();
      expect(a).toBe(b);
      await expect(
        lspManager.runWithClientLease(file, async () => {
          throw new Error("lease operation failed");
        }),
      ).rejects.toThrow("lease operation failed");
      const result = await lspManager.runWithClientLease(file, (client) =>
        client.documentSymbols(file),
      );
      expect(result?.[0]?.name).toBe("answer");
      await lspManager.disconnectAll();
      expect(a?.isUsable).toBe(false);
    } finally {
      await lspManager.disconnectAll();
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  }));
