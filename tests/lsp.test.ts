import { test, expect, spyOn } from "bun:test";
import { mkdtemp, writeFile, rm, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LspClient, lspManager } from "../src/tools/lsp/client";
import { lspTools } from "../src/tools/lsp-tools";
import type { ToolCallContext } from "../src/tools/define";

// Deterministic protocol peer, confined to a disposable fixture. Not a shipped backend.
const peer = `
let buffer=Buffer.alloc(0);let uri;let content;
const send=(m)=>{let s=JSON.stringify(m);process.stdout.write('Content-Length: '+Buffer.byteLength(s)+'\\r\\n\\r\\n'+s)};
process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);for(;;){let h=buffer.indexOf('\\r\\n\\r\\n');if(h<0)return;let len=Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0,h).toString())[1]);if(buffer.length<h+4+len)return;let m=JSON.parse(buffer.subarray(h+4,h+4+len));buffer=buffer.subarray(h+4+len);if(m.method==='textDocument/didOpen'){uri=m.params.textDocument.uri;content=m.params.textDocument.text;send({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri,diagnostics:[{range:{start:{line:0,character:6},end:{line:0,character:12}},severity:2,source:'fixture',code:7,message:'unused '+(content.includes('answer')?'answer':'value')}]}});continue}if(m.method==='exit'){process.exit(0)}if(m.id===undefined)continue;let result=null;if(m.method==='initialize')result={capabilities:{referencesProvider:true,documentSymbolProvider:true,workspaceSymbolProvider:true}};else if(m.method==='textDocument/definition')result={uri:uri,range:{start:{line:0,character:6},end:{line:0,character:12}}};else if(m.method==='textDocument/hover')result={contents:{kind:'markdown',value:'const answer: 42'},range:{start:m.params.position,end:m.params.position}};else if(m.method==='textDocument/references')result=[{uri:uri,range:{start:m.params.position,end:{line:m.params.position.line,character:m.params.position.character+1}}}];else if(m.method==='textDocument/documentSymbol')result=[{name:content.includes('answer')?'answer':'missing-document',kind:13,range:{start:{line:0,character:0},end:{line:0,character:6}},selectionRange:{start:{line:0,character:0},end:{line:0,character:6}}}];else if(m.method==='workspace/symbol'){if(m.params.query==='crash'){process.exit(7)}if(m.params.query==='hang')continue;if(m.params.query==='error'){send({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'fixture server error'}});continue}result=[{name:m.params.query,kind:13,location:{uri,range:{start:{line:0,character:0},end:{line:0,character:6}}}}]};send({jsonrpc:'2.0',id:m.id,result})}});
`;
async function fixture(
  run: (root: string, file: string, client: LspClient) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "open-gajae-lsp-")));
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
function context(agent = "open-gajae"): ToolCallContext {
  return { agent, sessionID: "s", signal: new AbortController().signal };
}
/** The tools for a project at `root`, by name. */
function tools(root: string) {
  const list = lspTools({ locationDir: root, projectDir: root });
  return {
    names: list.map((tool) => tool.name),
    async call(name: string, args: Record<string, unknown>, ctx = context()) {
      const tool = list.find((candidate) => candidate.name === name)!;
      return (await tool.execute(tool.input.parse(args) as never, ctx)).content;
    },
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
    const definition = await client.definition(file, 0, 0);
    expect(definition).toEqual({
      uri: pathToFileURL(file).href,
      range: {
        start: { line: 0, character: 6 },
        end: { line: 0, character: 12 },
      },
    });
    const hover = await client.hover(file, 0, 6);
    expect(hover?.contents).toEqual({
      kind: "markdown",
      value: "const answer: 42",
    });
    // The fixture publishes on didOpen, which the requests above triggered.
    await client.waitForDiagnostics(file, 1000);
    expect(client.getDiagnostics(file)[0]?.message).toBe("unused answer");
    expect(client.supportsPullDiagnostics).toBe(false);
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
test("actor and project-boundary refusals are content and precede backend calls", async () =>
  fixture(async (root, file) => {
    const lease = spyOn(lspManager, "runWithClientLease");
    try {
      const { call, names } = tools(root);
      expect(names).toEqual([
        "lsp_goto_definition",
        "lsp_hover",
        "lsp_find_references",
        "lsp_document_symbols",
        "lsp_workspace_symbols",
        "lsp_diagnostics",
        "lsp_servers",
      ]);
      for (const agent of ["open-gajae-planner", "open-gajae-document-specialist", "build"]) {
        const refused = context(agent);
        expect(await call("lsp_document_symbols", { file }, refused)).toContain(
          "cannot use open-gajae code tools",
        );
        expect(await call("lsp_servers", {}, refused)).toContain("cannot use");
      }
      await writeFile(join(root, ".env"), "SECRET=1");
      for (const outside of ["/etc/hosts", "../x.ts", ".env"]) {
        const output = await call("lsp_hover", {
          file: outside,
          line: 1,
          character: 0,
        });
        expect(output).toStartWith("Error: ");
      }
      expect(lease).not.toHaveBeenCalled();
      expect(await call("lsp_servers", {}, context("open-gajae-critic"))).toContain(
        "Language Server Status",
      );
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
      // The three new read-only tools, end to end through the manager.
      const { call } = tools(root);
      const position = { file: "input.json", line: 1, character: 6 };
      expect(await call("lsp_goto_definition", position)).toBe(
        `${file}:1:7-1:13`,
      );
      expect(await call("lsp_hover", position)).toBe(
        "const answer: 42\n\nRange: 1:7",
      );
      expect(await call("lsp_diagnostics", { file: "input.json" })).toBe(
        `Found 1 diagnostic(s):\n\nWarning (7)[fixture]: unused answer\n  at ${file}:1:7-1:13`,
      );
      expect(
        await call("lsp_diagnostics", { file: "input.json", severity: "error" }),
      ).toBe(`No error diagnostics in ${file}`);
      await lspManager.disconnectAll();
      expect(a?.isUsable).toBe(false);
    } finally {
      await lspManager.disconnectAll();
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  }));
