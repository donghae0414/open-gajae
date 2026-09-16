// Read-only port of OMC v5.4.0 src/tools/ast-tools.ts (MIT).
// Baseline: 5281b19e0d64f8e6dc6767f2130299a88af2dc71.
// Host changes: ToolContext path/permissions, async guarded traversal, no replace tool.
import { createRequire } from "node:module";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { tool, type ToolContext } from "@opencode-ai/plugin";
import {
  assertCodeReader,
  authorizeOperation,
  authorizePath,
  ReadPermissionError,
} from "./permissions.js";

export const SUPPORTED_LANGUAGES = [
  "javascript",
  "typescript",
  "tsx",
  "python",
  "ruby",
  "go",
  "rust",
  "java",
  "kotlin",
  "swift",
  "c",
  "cpp",
  "csharp",
  "html",
  "css",
  "json",
  "yaml",
] as const;
const EXT_TO_LANG: Record<string, string> = {
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
};
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "__pycache__",
  ".venv",
  "venv",
]);
const RECOVERY =
  "Restore this plugin's required @ast-grep/napi dependency and restart OpenCode. The tool does not install it automatically.";
let sgModule: typeof import("@ast-grep/napi") | undefined;
let sgLoadError: string | undefined;
async function getSgModule() {
  if (sgLoadError !== undefined) return undefined;
  if (!sgModule) {
    try {
      sgModule = createRequire(import.meta.url)("@ast-grep/napi");
    } catch {
      try {
        sgModule = await import("@ast-grep/napi");
      } catch (error) {
        sgLoadError = error instanceof Error ? error.message : String(error);
      }
    }
  }
  return sgModule;
}
function toLangEnum(sg: typeof import("@ast-grep/napi"), language: string) {
  const map: Record<string, import("@ast-grep/napi").Lang> = {
    javascript: sg.Lang.JavaScript,
    typescript: sg.Lang.TypeScript,
    tsx: sg.Lang.Tsx,
    python: sg.Lang.Python,
    ruby: sg.Lang.Ruby,
    go: sg.Lang.Go,
    rust: sg.Lang.Rust,
    java: sg.Lang.Java,
    kotlin: sg.Lang.Kotlin,
    swift: sg.Lang.Swift,
    c: sg.Lang.C,
    cpp: sg.Lang.Cpp,
    csharp: sg.Lang.CSharp,
    html: sg.Lang.Html,
    css: sg.Lang.Css,
    json: sg.Lang.Json,
    yaml: sg.Lang.Yaml,
  };
  const lang = map[language];
  if (!lang)
    throw new Error(
      `Unsupported language: ${language}. The loaded @ast-grep/napi runtime does not provide this language.\n${RECOVERY}`,
    );
  return lang;
}

async function getFilesForLanguage(
  target: string,
  language: string,
  context: ToolContext,
): Promise<string[]> {
  const files: string[] = [];
  const visited = new Set<string>();
  async function walk(requested: string, top = false): Promise<void> {
    if (files.length >= 1000) return;
    // Authorize the requested and canonical targets before readdir/readFile.
    const canonical = await authorizePath(context, requested, { read: true });
    const info = await stat(canonical);
    if (info.isFile()) {
      if (top || EXT_TO_LANG[extname(requested).toLowerCase()] === language)
        files.push(canonical);
      return;
    }
    if (!info.isDirectory() || visited.has(canonical)) return;
    visited.add(canonical);
    await authorizePath(context, canonical, { directory: true, read: true });
    let entries;
    try {
      entries = await readdir(canonical, { withFileTypes: true });
    } catch (error) {
      if (top) throw error;
      return; // Source skips inaccessible subdirectories; native denials occurred above.
    }
    for (const entry of entries) {
      if (files.length >= 1000) break;
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      if (
        entry.isDirectory() ||
        entry.isSymbolicLink() ||
        (entry.isFile() &&
          EXT_TO_LANG[extname(entry.name).toLowerCase()] === language)
      )
        await walk(join(canonical, entry.name));
    }
  }
  await walk(target, true);
  return files;
}
function formatMatch(
  file: string,
  start: number,
  end: number,
  context: number,
  content: string,
): string {
  const lines = content.split("\n");
  const first = Math.max(0, start - context - 1);
  const last = Math.min(lines.length, end + context);
  return `${file}:${start}\n${lines
    .slice(first, last)
    .map((line, i) => {
      const number = first + i + 1;
      return `${number >= start && number <= end ? ">" : " "} ${number.toString().padStart(4)}: ${line}`;
    })
    .join("\n")}`;
}
export const astGrepSearchTool = tool({
  description:
    "Search code using AST patterns: $NAME matches a node, $$$ARGS matches multiple nodes. Patterns must be valid AST nodes. Read-only; no replacement operation.",
  args: {
    pattern: tool.schema.string(),
    language: tool.schema.enum(SUPPORTED_LANGUAGES),
    path: tool.schema.string().optional(),
    context: tool.schema.number().int().min(0).max(10).optional(),
    maxResults: tool.schema.number().int().min(1).max(100).optional(),
  },
  async execute(args, context) {
    assertCodeReader(context);
    await authorizeOperation(context, "ast_grep_search");
    const input = args.path ?? context.directory;
    const path = await authorizePath(context, input, { read: true });
    try {
      const sg = await getSgModule();
      if (!sg)
        return `@ast-grep/napi is not available.\n${RECOVERY}\nError: ${sgLoadError}`;
      const files = await getFilesForLanguage(path, args.language, context);
      if (!files.length) return `No ${args.language} files found in ${input}`;
      const lang = toLangEnum(sg, args.language);
      const results: string[] = [];
      const limit = args.maxResults ?? 20;
      for (const file of files) {
        if (results.length >= limit) break;
        const target = await authorizePath(context, file, { read: true });
        context.abort.throwIfAborted();
        try {
          const content = await readFile(target, "utf8");
          const matches = sg.parse(lang, content).root().findAll(args.pattern);
          for (const match of matches) {
            if (results.length >= limit) break;
            const range = match.range();
            results.push(
              formatMatch(
                target,
                range.start.line + 1,
                range.end.line + 1,
                args.context ?? 2,
                content,
              ),
            );
          }
        } catch {
          // Preserve source per-file read/parse skips, never native permission denial.
        }
      }
      if (!results.length)
        return `No matches found for pattern: ${args.pattern}\n\nSearched ${files.length} ${args.language} file(s) in ${input}\n\nTip: Ensure the pattern is a valid AST node. For example:\n- Use "function $NAME" not just "$NAME"\n- Use "console.log($X)" not "console.log"`;
      return `Found ${results.length} match(es) in ${files.length} file(s)\nPattern: ${args.pattern}\n\n${results.join("\n\n---\n\n")}`;
    } catch (error) {
      if (error instanceof ReadPermissionError || context.abort.aborted)
        throw error;
      return `Error in AST search: ${error instanceof Error ? error.message : String(error)}\n\nCommon issues:\n- Pattern must be a complete AST node\n- Language must match file type\n- Check that @ast-grep/napi is installed`;
    }
  },
});
