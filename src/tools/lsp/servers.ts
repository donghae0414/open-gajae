import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, extname, isAbsolute, join, parse, resolve } from "path";

export interface LspServerConfig {
  name: string;
  command: string;
  args: string[];
  extensions: string[];
  installHint: string;
  initializationOptions?: Record<string, unknown>;
  initializeTimeoutMs?: number;
}

const TYPESCRIPT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
];

const TYPESCRIPT_CLASSIC_SERVER: LspServerConfig = {
  name: "TypeScript Language Server",
  command: "typescript-language-server",
  args: ["--stdio"],
  extensions: TYPESCRIPT_EXTENSIONS,
  installHint: "npm install -g typescript-language-server typescript",
};

function findTypeScriptPackageRoot(workspaceRoot: string): string | null {
  let dir = resolve(workspaceRoot);
  while (true) {
    const packagePath = join(dir, "node_modules", "typescript", "package.json");
    if (existsSync(packagePath)) return dirname(packagePath);
    if (parse(dir).root === dir) return null;
    dir = dirname(dir);
  }
}

function shouldUseNativeTypeScriptServer(packageRoot: string): boolean {
  try {
    const packageJson = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as { version?: unknown };
    const version =
      typeof packageJson.version === "string"
        ? Number.parseInt(packageJson.version.split(".")[0] ?? "", 10)
        : NaN;
    if (!Number.isNaN(version) && version >= 7) return true;
  } catch {
    // Fall through to source-compatible file checks.
  }
  return (
    existsSync(join(packageRoot, "lib", "getExePath.js")) ||
    !existsSync(join(packageRoot, "lib", "tsserver.js"))
  );
}

/** Source-compatible TypeScript 7 project-local server selection. */
export function getTypeScriptServerForWorkspace(
  workspaceRoot: string,
): LspServerConfig {
  const packageRoot = findTypeScriptPackageRoot(workspaceRoot);
  if (!packageRoot || !shouldUseNativeTypeScriptServer(packageRoot))
    return TYPESCRIPT_CLASSIC_SERVER;

  const executable = process.platform === "win32" ? "tsc.cmd" : "tsc";
  const localTsc = join(
    dirname(dirname(packageRoot)),
    "node_modules",
    ".bin",
    executable,
  );
  if (!existsSync(localTsc)) return TYPESCRIPT_CLASSIC_SERVER;

  return {
    name: "TypeScript 7 Native Language Server (typescript-go)",
    command: localTsc,
    args: ["--lsp", "--stdio"],
    extensions: TYPESCRIPT_EXTENSIONS,
    installHint:
      "Install TypeScript 7 locally so node_modules/.bin/tsc is available",
  };
}

/**
 * OMC server catalogue ported from commit 5281b19e0d64f8e6dc6767f2130299a88af2dc71.
 * Source: src/tools/lsp/servers.ts. It reports availability only; it never
 * installs a server.
 */
export const LSP_SERVERS: Record<string, LspServerConfig> = {
  typescript: TYPESCRIPT_CLASSIC_SERVER,
  python: {
    name: "Python Language Server (ty)",
    command: "ty",
    args: ["server"],
    extensions: [".py", ".pyw"],
    installHint: "Install ty from https://github.com/astral-sh/ty",
  },
  rust: {
    name: "Rust Analyzer",
    command: "rust-analyzer",
    args: [],
    extensions: [".rs"],
    installHint: "rustup component add rust-analyzer",
  },
  go: {
    name: "gopls",
    command: "gopls",
    args: ["serve"],
    extensions: [".go"],
    installHint: "go install golang.org/x/tools/gopls@latest",
  },
  c: {
    name: "clangd",
    command: "clangd",
    args: [],
    extensions: [".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hxx"],
    installHint: "Install clangd from your package manager or LLVM",
  },
  java: {
    name: "Eclipse JDT Language Server",
    command: "jdtls",
    args: [],
    extensions: [".java"],
    installHint: "Install from https://github.com/eclipse/eclipse.jdt.ls",
  },
  json: {
    name: "JSON Language Server",
    command: "vscode-json-language-server",
    args: ["--stdio"],
    extensions: [".json", ".jsonc"],
    installHint: "npm install -g vscode-langservers-extracted",
  },
  html: {
    name: "HTML Language Server",
    command: "vscode-html-language-server",
    args: ["--stdio"],
    extensions: [".html", ".htm"],
    installHint: "npm install -g vscode-langservers-extracted",
  },
  css: {
    name: "CSS Language Server",
    command: "vscode-css-language-server",
    args: ["--stdio"],
    extensions: [".css", ".scss", ".less"],
    installHint: "npm install -g vscode-langservers-extracted",
  },
  vue: {
    name: "Vue Language Server (Volar)",
    command: "vue-language-server",
    args: ["--stdio"],
    extensions: [".vue"],
    installHint: "npm install -g @vue/language-server",
  },
  yaml: {
    name: "YAML Language Server",
    command: "yaml-language-server",
    args: ["--stdio"],
    extensions: [".yaml", ".yml"],
    installHint: "npm install -g yaml-language-server",
  },
  php: {
    name: "PHP Language Server (Intelephense)",
    command: "intelephense",
    args: ["--stdio"],
    extensions: [".php", ".phtml"],
    installHint: "npm install -g intelephense",
  },
  ruby: {
    name: "Ruby Language Server (Solargraph)",
    command: "solargraph",
    args: ["stdio"],
    extensions: [".rb", ".rake", ".gemspec", ".erb"],
    installHint: "gem install solargraph",
  },
  lua: {
    name: "Lua Language Server",
    command: "lua-language-server",
    args: [],
    extensions: [".lua"],
    installHint: "Install from https://github.com/LuaLS/lua-language-server",
  },
  kotlin: {
    name: "Kotlin Language Server",
    command: "kotlin-lsp",
    args: ["--stdio"],
    extensions: [".kt", ".kts"],
    installHint:
      "Install from https://github.com/Kotlin/kotlin-lsp (brew install JetBrains/utils/kotlin-lsp)",
    initializeTimeoutMs: 5 * 60 * 1000,
  },
  elixir: {
    name: "ElixirLS",
    command: "elixir-ls",
    args: [],
    extensions: [".ex", ".exs", ".heex", ".eex"],
    installHint: "Install from https://github.com/elixir-lsp/elixir-ls",
  },
  csharp: {
    name: "OmniSharp",
    command: "omnisharp",
    args: ["-lsp"],
    extensions: [".cs"],
    installHint: "dotnet tool install -g omnisharp",
  },
  dart: {
    name: "Dart Analysis Server",
    command: "dart",
    args: ["language-server", "--protocol=lsp"],
    extensions: [".dart"],
    installHint:
      "Install Dart SDK from https://dart.dev/get-dart or Flutter SDK from https://flutter.dev",
  },
  swift: {
    name: "SourceKit-LSP",
    command: "sourcekit-lsp",
    args: [],
    extensions: [".swift"],
    installHint: "Install Swift from https://swift.org/download or via Xcode",
  },
  verilog: {
    name: "Verible Verilog Language Server",
    command: "verible-verilog-ls",
    args: ["--rules_config_search"],
    extensions: [".v", ".vh", ".sv", ".svh"],
    installHint:
      "Download from https://github.com/chipsalliance/verible/releases",
  },
};

const BASEDPYRIGHT_SERVER: LspServerConfig = {
  name: "Python Language Server (basedpyright)",
  command: "basedpyright-langserver",
  args: ["--stdio"],
  extensions: [".py", ".pyw"],
  installHint: "uv tool install basedpyright",
};

/** OPEN_GAJAE_PYTHON_LSP=basedpyright is the product rename of OMC_PYTHON_LSP. */
export function resolvePythonServer(): LspServerConfig {
  return process.env.OPEN_GAJAE_PYTHON_LSP === "basedpyright"
    ? BASEDPYRIGHT_SERVER
    : LSP_SERVERS.python;
}

export function commandExists(command: string): boolean {
  if (isAbsolute(command)) return existsSync(command);
  const result = spawnSync(
    process.platform === "win32" ? "where" : "which",
    [command],
    { stdio: "ignore" },
  );
  return result.status === 0;
}

export function getServerForFile(
  filePath: string,
  workspaceRoot?: string,
): LspServerConfig | null {
  const extension = extname(filePath).toLowerCase();
  if (TYPESCRIPT_EXTENSIONS.includes(extension) && workspaceRoot)
    return getTypeScriptServerForWorkspace(workspaceRoot);

  for (const [key, config] of Object.entries(LSP_SERVERS)) {
    if (config.extensions.includes(extension))
      return key === "python" ? resolvePythonServer() : config;
  }
  return null;
}

export function getAllServers(): Array<
  LspServerConfig & { installed: boolean }
> {
  return Object.values(LSP_SERVERS).map((config) => {
    const selected =
      config === LSP_SERVERS.python ? resolvePythonServer() : config;
    return { ...selected, installed: commandExists(selected.command) };
  });
}

export function getServerForLanguage(language: string): LspServerConfig | null {
  const aliases: Record<string, string> = {
    javascript: "typescript",
    typescript: "typescript",
    tsx: "typescript",
    jsx: "typescript",
    python: "python",
    rust: "rust",
    go: "go",
    golang: "go",
    c: "c",
    cpp: "c",
    "c++": "c",
    java: "java",
    json: "json",
    html: "html",
    css: "css",
    scss: "css",
    less: "css",
    vue: "vue",
    yaml: "yaml",
    php: "php",
    phtml: "php",
    ruby: "ruby",
    rb: "ruby",
    rake: "ruby",
    gemspec: "ruby",
    erb: "ruby",
    lua: "lua",
    kotlin: "kotlin",
    kt: "kotlin",
    kts: "kotlin",
    elixir: "elixir",
    ex: "elixir",
    exs: "elixir",
    heex: "elixir",
    eex: "elixir",
    csharp: "csharp",
    "c#": "csharp",
    cs: "csharp",
    dart: "dart",
    flutter: "dart",
    swift: "swift",
    verilog: "verilog",
    systemverilog: "verilog",
    sv: "verilog",
    v: "verilog",
  };
  const key = aliases[language.toLowerCase()];
  if (!key || !LSP_SERVERS[key]) return null;
  return key === "python" ? resolvePythonServer() : LSP_SERVERS[key];
}
