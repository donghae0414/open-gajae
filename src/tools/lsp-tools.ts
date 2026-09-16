// OMC v5.4.0 src/tools/lsp-tools.ts, readonly subset (MIT).
// Baseline 5281b19e0d64f8e6dc6767f2130299a88af2dc71.
import { tool, type ToolContext } from "@opencode-ai/plugin";
import { lspManager } from "./lsp/client.js";
import { getAllServers, getServerForFile } from "./lsp/servers.js";
import {
  formatLocations,
  formatDocumentSymbols,
  formatWorkspaceSymbols,
} from "./lsp/utils.js";
import {
  assertCodeReader,
  authorizeOperation,
  authorizePath,
} from "./permissions.js";

type Client = NonNullable<
  Awaited<ReturnType<typeof lspManager.getClientForFile>>
>;
async function withLspClient(
  context: ToolContext,
  input: string,
  operation: string,
  fn: (client: Client, file: string) => Promise<string>,
): Promise<string> {
  assertCodeReader(context);
  const file = await authorizePath(context, input);
  await authorizeOperation(context, "lsp");
  // Native authorization is outside the backend error transformation.
  if (!getServerForFile(file))
    throw new Error(
      `No language server available for file type: ${file}\n\nUse lsp_servers tool to see available language servers.`,
    );
  try {
    return await lspManager.runWithClientLease(file, (client) =>
      fn(client, file),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      message.includes("not found")
        ? message
        : `Error in ${operation}: ${message}`,
      { cause: error },
    );
  }
}
export const lspFindReferencesTool = tool({
  description:
    "Find all references to a symbol across the codebase using a language server. Read-only.",
  args: {
    file: tool.schema.string(),
    line: tool.schema.number().int().min(1),
    character: tool.schema.number().int().min(0),
    includeDeclaration: tool.schema.boolean().optional(),
  },
  execute(args, context) {
    return withLspClient(
      context,
      args.file,
      "find references",
      async (client, file) => {
        const locations = await client.references(
          file,
          args.line - 1,
          args.character,
          args.includeDeclaration ?? true,
        );
        return !locations?.length
          ? "No references found"
          : `Found ${locations.length} reference(s):\n\n${formatLocations(locations)}`;
      },
    );
  },
});
export const lspDocumentSymbolsTool = tool({
  description:
    "Get a hierarchical outline of file symbols using a language server. Read-only.",
  args: { file: tool.schema.string() },
  execute(args, context) {
    return withLspClient(
      context,
      args.file,
      "document symbols",
      async (client, file) =>
        formatDocumentSymbols(await client.documentSymbols(file)),
    );
  },
});
export const lspWorkspaceSymbolsTool = tool({
  description:
    "Search workspace symbols by name. The file selects a language server; authorization is LSP operation-level, not a sandbox for server internal reads.",
  args: { query: tool.schema.string(), file: tool.schema.string() },
  execute(args, context) {
    return withLspClient(
      context,
      args.file,
      "workspace symbols",
      async (client) => {
        const symbols = await client.workspaceSymbols(args.query);
        return !symbols?.length
          ? `No symbols found matching: ${args.query}`
          : `Found ${symbols.length} symbol(s) matching "${args.query}":\n\n${formatWorkspaceSymbols(symbols)}`;
      },
    );
  },
});
export const lspServersTool = tool({
  description:
    "Report known language servers and installation status. Does not install servers.",
  args: {},
  async execute(_args, context) {
    await authorizeOperation(context, "lsp");
    const servers = getAllServers();
    const installed = servers.filter((server) => server.installed);
    const missing = servers.filter((server) => !server.installed);
    let text = "## Language Server Status\n\n";
    if (installed.length) {
      text += "### Installed:\n";
      for (const server of installed)
        text += `- ${server.name} (${server.command})\n  Extensions: ${server.extensions.join(", ")}\n`;
      text += "\n";
    }
    if (missing.length) {
      text += "### Not Installed:\n";
      for (const server of missing)
        text += `- ${server.name} (${server.command})\n  Extensions: ${server.extensions.join(", ")}\n  Install: ${server.installHint}\n`;
    }
    return text;
  },
});
