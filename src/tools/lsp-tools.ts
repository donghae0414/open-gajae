// OMC v5.4.0 src/tools/lsp-tools.ts, readonly subset (MIT).
// Baseline 5281b19e0d64f8e6dc6767f2130299a88af2dc71.
// Host changes: v2 tool shape, project-boundary path checks instead of host
// ask, errors returned as content. No rename or code-action tools.
import { z } from "zod";
import { lspManager } from "./lsp/client.js";
import { getAllServers, getServerForFile } from "./lsp/servers.js";
import {
  formatDiagnostics,
  formatDocumentSymbols,
  formatHover,
  formatLocations,
  formatWorkspaceSymbols,
} from "./lsp/utils.js";
import { defineTool, type ToolCallContext } from "./define.js";
import {
  assertCodeReader,
  type CodeToolPaths,
  errorText,
  resolveProjectPath,
} from "./permissions.js";

type Client = NonNullable<
  Awaited<ReturnType<typeof lspManager.getClientForFile>>
>;

async function withLspClient(
  paths: CodeToolPaths,
  context: ToolCallContext,
  input: string,
  operation: string,
  fn: (client: Client, file: string) => Promise<string>,
): Promise<string> {
  assertCodeReader(context);
  const file = await resolveProjectPath(paths, input);
  if (!getServerForFile(file))
    return `No language server available for file type: ${file}\n\nUse lsp_servers tool to see available language servers.`;
  try {
    return await lspManager.runWithClientLease(file, (client) =>
      fn(client, file),
    );
  } catch (error) {
    const message = errorText(error);
    return message.includes("not found")
      ? message
      : `Error in ${operation}: ${message}`;
  }
}

const position = {
  file: z.string().describe("Path to the source file"),
  line: z.number().int().min(1).describe("Line number (1-indexed)"),
  character: z
    .number()
    .int()
    .min(0)
    .describe("Character position in the line (0-indexed)"),
};

export function lspTools(paths: CodeToolPaths) {
  return [
    defineTool({
      name: "lsp_goto_definition",
      permission: "lsp",
      description:
        "Find the definition location of a symbol (function, variable, class, etc.). Returns the file path and position where the symbol is defined. Read-only.",
      input: z.object(position),
      execute: (args, context) =>
        withLspClient(
          paths,
          context,
          args.file,
          "goto definition",
          async (client, file) =>
            formatLocations(
              await client.definition(file, args.line - 1, args.character),
            ),
        ),
    }),
    defineTool({
      name: "lsp_hover",
      permission: "lsp",
      description:
        "Get type information, documentation, and signature at a specific position in a file. Useful for understanding what a symbol represents. Read-only.",
      input: z.object(position),
      execute: (args, context) =>
        withLspClient(paths, context, args.file, "hover", async (client, file) =>
          formatHover(await client.hover(file, args.line - 1, args.character)),
        ),
    }),
    defineTool({
      name: "lsp_find_references",
      permission: "lsp",
      description:
        "Find all references to a symbol across the codebase using a language server. Read-only.",
      input: z.object({
        ...position,
        includeDeclaration: z
          .boolean()
          .optional()
          .describe("Include the declaration in results (default: true)"),
      }),
      execute: (args, context) =>
        withLspClient(
          paths,
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
        ),
    }),
    defineTool({
      name: "lsp_document_symbols",
      permission: "lsp",
      description:
        "Get a hierarchical outline of file symbols using a language server. Read-only.",
      input: z.object({ file: z.string().describe("Path to the source file") }),
      execute: (args, context) =>
        withLspClient(
          paths,
          context,
          args.file,
          "document symbols",
          async (client, file) =>
            formatDocumentSymbols(await client.documentSymbols(file)),
        ),
    }),
    defineTool({
      name: "lsp_workspace_symbols",
      permission: "lsp",
      description:
        "Search workspace symbols by name. The file selects a language server; the project boundary applies to that file, not to the server's own reads.",
      input: z.object({
        query: z.string().describe("Symbol name or pattern to search"),
        file: z
          .string()
          .describe(
            "Any file in the workspace (used to determine which language server to use)",
          ),
      }),
      execute: (args, context) =>
        withLspClient(
          paths,
          context,
          args.file,
          "workspace symbols",
          async (client) => {
            const symbols = await client.workspaceSymbols(args.query);
            return !symbols?.length
              ? `No symbols found matching: ${args.query}`
              : `Found ${symbols.length} symbol(s) matching "${args.query}":\n\n${formatWorkspaceSymbols(symbols)}`;
          },
        ),
    }),
    defineTool({
      name: "lsp_diagnostics",
      permission: "lsp",
      description:
        "Get language server diagnostics (errors, warnings, hints) for a file. Useful for finding issues without running the compiler. Read-only.",
      input: z.object({
        file: z.string().describe("Path to the source file"),
        severity: z
          .enum(["error", "warning", "info", "hint"])
          .optional()
          .describe("Filter by severity level"),
      }),
      execute: (args, context) =>
        withLspClient(
          paths,
          context,
          args.file,
          "diagnostics",
          async (client, file) => {
            await client.openDocument(file);
            let diagnostics;
            if (client.supportsPullDiagnostics)
              diagnostics = await client.pullDiagnostics(file);
            else {
              await client.waitForDiagnostics(file, 30_000);
              diagnostics = client.getDiagnostics(file);
            }
            if (args.severity) {
              const severity = { error: 1, warning: 2, info: 3, hint: 4 }[
                args.severity
              ];
              diagnostics = diagnostics.filter((d) => d.severity === severity);
            }
            if (diagnostics.length === 0)
              return args.severity
                ? `No ${args.severity} diagnostics in ${file}`
                : `No diagnostics in ${file}`;
            return `Found ${diagnostics.length} diagnostic(s):\n\n${formatDiagnostics(diagnostics, file)}`;
          },
        ),
    }),
    defineTool({
      name: "lsp_servers",
      permission: "lsp",
      description:
        "Report known language servers and installation status. Does not install servers.",
      input: z.object({}),
      async execute(_args, context) {
        assertCodeReader(context);
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
    }),
  ];
}
