import { spawn, type ChildProcess } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, join, parse, resolve } from "path";
import { pathToFileURL } from "url";
import {
  containerUriToHostUri,
  hostUriToContainerUri,
  resolveDevContainerContext,
  type DevContainerContext,
} from "./devcontainer.js";
import {
  commandExists,
  getServerForFile,
  type LspServerConfig,
} from "./servers.js";

/** Product rename of OMC_LSP_TIMEOUT_MS; OMC configuration is not read. */
export const DEFAULT_LSP_REQUEST_TIMEOUT_MS = readPositiveIntEnv(
  "OPEN_GAJAE_LSP_TIMEOUT_MS",
  15_000,
);
export const IDLE_TIMEOUT_MS = readPositiveIntEnv(
  "OPEN_GAJAE_LSP_IDLE_TIMEOUT_MS",
  5 * 60 * 1000,
);
export const IDLE_CHECK_INTERVAL_MS = readPositiveIntEnv(
  "OPEN_GAJAE_LSP_IDLE_CHECK_INTERVAL_MS",
  60 * 1000,
);

export function getLspRequestTimeout(
  serverConfig: Pick<LspServerConfig, "initializeTimeoutMs">,
  method: string,
  baseTimeout = DEFAULT_LSP_REQUEST_TIMEOUT_MS,
): number {
  return method === "initialize" && serverConfig.initializeTimeoutMs
    ? Math.max(baseTimeout, serverConfig.initializeTimeoutMs)
    : baseTimeout;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

function fileUri(filePath: string): string {
  return pathToFileURL(resolve(filePath)).href;
}

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

export interface Hover {
  contents:
    | string
    | { kind: string; value: string }
    | Array<string | { kind: string; value: string }>;
  range?: Range;
}

export interface Diagnostic {
  range: Range;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

export interface DocumentSymbol {
  name: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

export interface SymbolInformation {
  name: string;
  kind: number;
  location: Location;
  containerName?: string;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcServerRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * JSON-RPC 2.0 LSP client over stdio.
 *
 * This is a focused port of oh-my-claudecode@5281b19e0d64f8e6dc6767f2130299a88af2dc71
 * src/tools/lsp/client.ts. The public request surface is deliberately limited
 * to the read-only requests: definition, hover, references, document symbols,
 * workspace symbols, and diagnostics (published or pulled).
 */
export class LspClient {
  private static readonly MAX_BUFFER_SIZE = 50 * 1024 * 1024;
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private buffer = Buffer.alloc(0);
  private writeTail: Promise<void> = Promise.resolve();
  private writeGeneration = 0;
  private writeWaiterRejectors = new Set<(error: Error) => void>();
  private openDocuments = new Set<string>();
  private documentOpenPromises = new Map<string, Promise<void>>();
  private diagnostics = new Map<string, Diagnostic[]>();
  private diagnosticWaiters = new Map<string, Array<(error?: Error) => void>>();
  private _supportsPullDiagnostics = false;
  private readonly workspaceRoot: string;
  private readonly serverConfig: LspServerConfig;
  private readonly devContainerContext: DevContainerContext | null;
  private disconnected = false;
  private initialized = false;
  private connectionGeneration = 0;
  private terminalError: Error | null = null;

  constructor(
    workspaceRoot: string,
    serverConfig: LspServerConfig,
    devContainerContext: DevContainerContext | null = null,
  ) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.serverConfig = serverConfig;
    this.devContainerContext = devContainerContext;
  }

  get isUsable(): boolean {
    return !this.disconnected;
  }

  async connect(): Promise<void> {
    if (this.process) return;

    this.disconnected = false;
    this.terminalError = null;
    this.initialized = false;
    const generation = ++this.connectionGeneration;
    this.buffer = Buffer.alloc(0);
    this.openDocuments.clear();
    this.documentOpenPromises.clear();

    const spawnCommand = this.devContainerContext
      ? "docker"
      : this.serverConfig.command;
    if (!commandExists(spawnCommand)) {
      throw new Error(
        this.devContainerContext
          ? `Docker CLI not found. Required to start '${this.serverConfig.command}' inside container ${this.devContainerContext.containerId}.`
          : `Language server '${this.serverConfig.command}' not found.\nInstall with: ${this.serverConfig.installHint}`,
      );
    }

    await new Promise<void>((resolveConnection, rejectConnection) => {
      const command = this.devContainerContext
        ? "docker"
        : this.serverConfig.command;
      const args = this.devContainerContext
        ? [
            "exec",
            "-i",
            "-w",
            this.devContainerContext.containerWorkspaceRoot,
            this.devContainerContext.containerId,
            this.serverConfig.command,
            ...this.serverConfig.args,
          ]
        : this.serverConfig.args;
      const child = spawn(command, args, {
        cwd: this.workspaceRoot,
        stdio: ["pipe", "pipe", "pipe"],
        // Server commands come from the static registry, never tool arguments.
        shell: !this.devContainerContext && process.platform === "win32",
      });
      this.process = child;

      child.stdout?.on("data", (data: Buffer) => {
        if (this.isCurrentConnection(child, generation)) this.handleData(data);
      });
      child.stderr?.on("data", (data: Buffer) => {
        if (this.isCurrentConnection(child, generation))
          console.error(`LSP stderr: ${data.toString()}`);
      });
      child.stdin?.on("error", (error) => {
        if (this.isCurrentConnection(child, generation))
          this.handleTransportFailure(error);
      });
      child.stdin?.on("close", () => {
        if (this.isCurrentConnection(child, generation))
          this.handleTransportFailure(new Error("LSP stdin closed"));
      });
      child.on("error", (error) => {
        if (!this.isCurrentConnection(child, generation)) return;
        this.handleTransportFailure(error);
        rejectConnection(
          new Error(`Failed to start LSP server: ${error.message}`),
        );
      });
      child.on("exit", (code) => {
        if (!this.isCurrentConnection(child, generation)) return;
        this.process = null;
        this.handleTransportFailure(
          new Error(`LSP server exited (code ${code})`),
        );
        if (code !== 0) console.error(`LSP server exited with code ${code}`);
      });

      this.initialize()
        .then(() => {
          if (!this.isCurrentConnection(child, generation)) {
            rejectConnection(
              new Error("LSP server was replaced during initialization"),
            );
            return;
          }
          this.initialized = true;
          resolveConnection();
        })
        .catch((error) => {
          if (this.isCurrentConnection(child, generation)) {
            this.forceKill();
          } else {
            try {
              child.kill("SIGKILL");
            } catch {
              // A retired process may already be gone.
            }
          }
          rejectConnection(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
    });
  }

  /** Synchronous cleanup for process exit and signal handlers. */
  forceKill(): void {
    const error = new Error("LSP client force-killed");
    this.connectionGeneration++;
    this.terminalError = error;
    this.disconnected = true;
    this.cancelPendingWrites(error);
    this.rejectPendingRequests(error);
    this.cancelDiagnosticWaiters(error);
    if (this.process) {
      try {
        this.process.kill("SIGKILL");
      } catch {
        // Process cleanup is best-effort during termination.
      }
      this.process = null;
    }
    this.clearConnectionState();
  }

  async disconnect(): Promise<void> {
    const child = this.process;
    const generation = this.connectionGeneration;
    try {
      if (child && this.isCurrentConnection(child, generation)) {
        await this.request("shutdown", null, 3000);
        if (this.isCurrentConnection(child, generation)) {
          await Promise.race([
            this.notifyWithBackpressure("exit", null),
            new Promise<void>((resolveTimeout) =>
              setTimeout(resolveTimeout, 250),
            ),
          ]);
        }
      }
    } catch {
      // Shutdown errors do not prevent process cleanup.
    } finally {
      if (this.process !== child || this.connectionGeneration !== generation) {
        try {
          child?.kill();
        } catch {
          // Retired process cleanup is best-effort.
        }
        return;
      }

      const error = new Error("LSP client disconnected");
      this.connectionGeneration++;
      this.terminalError = error;
      this.disconnected = true;
      this.cancelPendingWrites(error);
      try {
        child?.kill();
      } catch {
        // The process can have exited between the shutdown request and kill.
      }
      this.process = null;
      this.rejectPendingRequests(error);
      this.cancelDiagnosticWaiters(error);
      this.clearConnectionState();
    }
  }

  async hover(
    filePath: string,
    line: number,
    character: number,
  ): Promise<Hover | null> {
    const uri = await this.prepareDocument(filePath);
    const result = await this.request<Hover | null>("textDocument/hover", {
      textDocument: { uri },
      position: { line, character },
    });
    return this.translateIncomingPayload(result);
  }

  async definition(
    filePath: string,
    line: number,
    character: number,
  ): Promise<Location | Location[] | null> {
    const uri = await this.prepareDocument(filePath);
    const result = await this.request<Location | Location[] | null>(
      "textDocument/definition",
      { textDocument: { uri }, position: { line, character } },
    );
    return this.translateIncomingPayload(result);
  }

  async references(
    filePath: string,
    line: number,
    character: number,
    includeDeclaration = true,
  ): Promise<Location[] | null> {
    const uri = await this.prepareDocument(filePath);
    const result = await this.request<Location[] | null>(
      "textDocument/references",
      {
        textDocument: { uri },
        position: { line, character },
        context: { includeDeclaration },
      },
    );
    return this.translateIncomingPayload(result);
  }

  async documentSymbols(
    filePath: string,
  ): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
    const uri = await this.prepareDocument(filePath);
    const result = await this.request<
      DocumentSymbol[] | SymbolInformation[] | null
    >("textDocument/documentSymbol", {
      textDocument: { uri },
    });
    return this.translateIncomingPayload(result);
  }

  async workspaceSymbols(query: string): Promise<SymbolInformation[] | null> {
    const result = await this.request<SymbolInformation[] | null>(
      "workspace/symbol",
      { query },
    );
    return this.translateIncomingPayload(result);
  }

  /** Diagnostics last published for a file (push model). */
  getDiagnostics(filePath: string): Diagnostic[] {
    return this.diagnostics.get(fileUri(filePath)) ?? [];
  }

  /** Whether the server supports LSP 3.17 pull diagnostics. */
  get supportsPullDiagnostics(): boolean {
    return this._supportsPullDiagnostics;
  }

  /** `textDocument/diagnostic` (pull model); only when supported. */
  async pullDiagnostics(filePath: string): Promise<Diagnostic[]> {
    const uri = this.toServerUri(fileUri(filePath));
    const result = await this.request<{
      kind?: string;
      items?: Array<Record<string, unknown>>;
    }>("textDocument/diagnostic", { textDocument: { uri } });
    return (result?.items ?? []).map((d) => ({
      range: d.range as Range,
      message: d.message as string,
      severity: d.severity as number | undefined,
      source: d.source as string | undefined,
      code: d.code as string | number | undefined,
    }));
  }

  /**
   * Resolve once `textDocument/publishDiagnostics` arrives for the file, or
   * after `timeoutMs`, whichever comes first. Rejects on a transport failure.
   */
  waitForDiagnostics(filePath: string, timeoutMs = 2000): Promise<void> {
    const uri = fileUri(filePath);
    try {
      this.throwIfTerminal();
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.diagnostics.has(uri)) return Promise.resolve();
    return new Promise<void>((resolveWait, rejectWait) => {
      let settled = false;
      const waiter = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) rejectWait(error);
        else resolveWait();
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const remaining = (this.diagnosticWaiters.get(uri) ?? []).filter(
          (candidate) => candidate !== waiter,
        );
        if (remaining.length) this.diagnosticWaiters.set(uri, remaining);
        else this.diagnosticWaiters.delete(uri);
        resolveWait();
      }, timeoutMs);
      const waiters = this.diagnosticWaiters.get(uri) ?? [];
      waiters.push(waiter);
      this.diagnosticWaiters.set(uri, waiters);
    });
  }

  private async initialize(): Promise<void> {
    const child = this.process;
    const generation = this.connectionGeneration;
    const initResult = await this.request<{
      capabilities?: Record<string, unknown>;
    } | null>(
      "initialize",
      {
        processId: process.pid,
        rootUri: this.toServerUri(pathToFileURL(this.workspaceRoot).href),
        rootPath:
          this.devContainerContext?.containerWorkspaceRoot ??
          this.workspaceRoot,
        capabilities: {
          textDocument: {
            hover: { contentFormat: ["markdown", "plaintext"] },
            definition: { linkSupport: true },
            references: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            publishDiagnostics: {
              relatedInformation: true,
              tagSupport: { valueSet: [1, 2] },
            },
          },
          workspace: { symbol: {}, workspaceFolders: true },
        },
        initializationOptions: this.serverConfig.initializationOptions ?? {},
      },
      getLspRequestTimeout(this.serverConfig, "initialize"),
    );
    this.assertCurrentConnection(child, generation);
    this._supportsPullDiagnostics =
      !!initResult?.capabilities?.diagnosticProvider;
    await this.notifyWithBackpressure("initialized", {});
    this.assertCurrentConnection(child, generation);
  }

  private async prepareDocument(filePath: string): Promise<string> {
    await this.openDocument(filePath);
    return this.toServerUri(fileUri(filePath));
  }

  async openDocument(filePath: string): Promise<void> {
    const hostUri = fileUri(filePath);
    if (this.openDocuments.has(hostUri)) return;
    const pending = this.documentOpenPromises.get(hostUri);
    if (pending) return pending;

    const opening = this.performDocumentOpen(filePath, hostUri).finally(() => {
      if (this.documentOpenPromises.get(hostUri) === opening)
        this.documentOpenPromises.delete(hostUri);
    });
    this.documentOpenPromises.set(hostUri, opening);
    return opening;
  }

  private async performDocumentOpen(
    filePath: string,
    hostUri: string,
  ): Promise<void> {
    this.throwIfTerminal();
    if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

    const child = this.process;
    const generation = this.connectionGeneration;
    // A reopened document needs fresh diagnostics, not a stale cached result.
    this.diagnostics.delete(hostUri);
    await this.notifyWithBackpressure("textDocument/didOpen", {
      textDocument: {
        uri: this.toServerUri(hostUri),
        languageId: this.getLanguageId(filePath),
        version: 1,
        text: readFileSync(filePath, "utf8"),
      },
    });
    this.assertCurrentConnection(child, generation);
    this.openDocuments.add(hostUri);
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));
    this.assertCurrentConnection(child, generation);
    this.throwIfTerminal();
  }

  private getLanguageId(filePath: string): string {
    const extension = parse(filePath).ext.slice(1).toLowerCase();
    const languageIds: Record<string, string> = {
      ts: "typescript",
      tsx: "typescriptreact",
      js: "javascript",
      jsx: "javascriptreact",
      mts: "typescript",
      cts: "typescript",
      mjs: "javascript",
      cjs: "javascript",
      py: "python",
      pyw: "python",
      rs: "rust",
      go: "go",
      c: "c",
      h: "c",
      cpp: "cpp",
      cc: "cpp",
      cxx: "cpp",
      hpp: "cpp",
      hxx: "cpp",
      java: "java",
      json: "json",
      jsonc: "jsonc",
      html: "html",
      htm: "html",
      css: "css",
      scss: "scss",
      less: "less",
      vue: "vue",
      yaml: "yaml",
      yml: "yaml",
      php: "php",
      phtml: "php",
      rb: "ruby",
      rake: "ruby",
      gemspec: "ruby",
      erb: "ruby",
      lua: "lua",
      kt: "kotlin",
      kts: "kotlin",
      ex: "elixir",
      exs: "elixir",
      heex: "elixir",
      eex: "elixir",
      cs: "csharp",
      dart: "dart",
      swift: "swift",
      v: "verilog",
      vh: "verilog",
      sv: "systemverilog",
      svh: "systemverilog",
    };
    return languageIds[extension] ?? extension;
  }

  private async request<T>(
    method: string,
    params: unknown,
    timeout?: number,
  ): Promise<T> {
    this.throwIfTerminal();
    if (!this.process?.stdin) throw new Error("LSP server not connected");

    const id = ++this.requestId;
    const content = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    } satisfies JsonRpcRequest);
    const message = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`;
    const effectiveTimeout =
      timeout ?? getLspRequestTimeout(this.serverConfig, method);

    return new Promise<T>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        rejectRequest(
          new Error(
            `LSP request '${method}' timed out after ${effectiveTimeout}ms`,
          ),
        );
      }, effectiveTimeout);
      this.pendingRequests.set(id, {
        resolve: (value) => resolveRequest(value as T),
        reject: rejectRequest,
        timeout: timer,
      });
      void this.enqueueOutboundWrite(() => {
        if (!this.pendingRequests.has(id))
          throw new Error(`LSP request '${method}' is no longer pending`);
        return this.writeMessage(message);
      }).catch((error) => {
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(id);
        pending.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    });
  }

  private notify(method: string, params: unknown): boolean {
    const content = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
    } satisfies JsonRpcNotification);
    return this.writeMessage(
      `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`,
    );
  }

  private notifyWithBackpressure(
    method: string,
    params: unknown,
  ): Promise<void> {
    return this.enqueueOutboundWrite(() => this.notify(method, params));
  }

  private enqueueOutboundWrite(write: () => boolean): Promise<void> {
    const generation = this.writeGeneration;
    const queued = this.writeTail.then(() => {
      if (generation !== this.writeGeneration)
        throw new Error("LSP write cancelled before send");
      return this.writeWithBackpressure(write);
    });
    this.writeTail = queued.catch(() => undefined);
    return queued;
  }

  private writeMessage(message: string): boolean {
    if (!this.process?.stdin) throw new Error("LSP client is not connected");
    try {
      return this.process.stdin.write(message);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.handleTransportFailure(failure);
      throw failure;
    }
  }

  private async writeWithBackpressure(write: () => boolean): Promise<void> {
    const stdin = this.process?.stdin;
    if (
      write() ||
      !stdin ||
      typeof stdin.once !== "function" ||
      typeof stdin.off !== "function"
    )
      return;

    await new Promise<void>((resolveDrain, rejectDrain) => {
      const cleanup = () => {
        stdin.off("drain", onDrain);
        stdin.off("error", onError);
        stdin.off("close", onClose);
        this.writeWaiterRejectors.delete(onCancel);
      };
      const onDrain = () => {
        cleanup();
        resolveDrain();
      };
      const onError = (error: Error) => {
        cleanup();
        rejectDrain(error);
      };
      const onClose = () => onError(new Error("LSP stdin closed before drain"));
      const onCancel = (error: Error) => onError(error);
      this.writeWaiterRejectors.add(onCancel);
      stdin.once("drain", onDrain);
      stdin.once("error", onError);
      stdin.once("close", onClose);
    });
  }

  private handleData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    if (this.buffer.length > LspClient.MAX_BUFFER_SIZE) {
      this.buffer = Buffer.alloc(0);
      this.rejectPendingRequests(new Error("LSP response buffer overflow"));
      return;
    }

    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString();
      const match = header.match(/Content-Length: (\d+)/i);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const start = headerEnd + 4;
      const end = start + Number.parseInt(match[1], 10);
      if (this.buffer.length < end) return;
      const content = this.buffer.subarray(start, end).toString();
      this.buffer = this.buffer.subarray(end);
      try {
        this.handleMessage(
          JSON.parse(content) as
            | JsonRpcResponse
            | JsonRpcNotification
            | JsonRpcServerRequest,
        );
      } catch {
        // Source behavior: malformed server messages are discarded, not misrouted.
      }
    }
  }

  private handleMessage(
    message: JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest,
  ): void {
    const record = message as unknown as Record<string, unknown>;
    const hasMethod = Object.prototype.hasOwnProperty.call(record, "method");
    const hasId = Object.prototype.hasOwnProperty.call(record, "id");
    if (hasMethod && typeof record.method === "string") {
      if (
        hasId &&
        (typeof record.id === "string" ||
          (typeof record.id === "number" && Number.isInteger(record.id)))
      ) {
        this.handleServerRequest(message as JsonRpcServerRequest);
      } else if (!hasId) {
        this.handleNotification(message as JsonRpcNotification);
      }
      return;
    }
    if (!hasMethod && hasId && typeof record.id === "number") {
      const response = message as JsonRpcResponse;
      const pending = this.pendingRequests.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(response.id);
      response.error
        ? pending.reject(new Error(response.error.message))
        : pending.resolve(response.result);
    }
  }

  private handleNotification(notification: JsonRpcNotification): void {
    if (notification.method !== "textDocument/publishDiagnostics") return;
    const params = this.translateIncomingPayload(notification.params) as {
      uri?: unknown;
      diagnostics?: unknown;
    } | null;
    if (typeof params?.uri !== "string" || !Array.isArray(params.diagnostics))
      return;
    this.diagnostics.set(params.uri, params.diagnostics as Diagnostic[]);
    const waiters = this.diagnosticWaiters.get(params.uri);
    if (!waiters?.length) return;
    this.diagnosticWaiters.delete(params.uri);
    for (const wake of waiters) wake();
  }

  private handleServerRequest(request: JsonRpcServerRequest): void {
    const error =
      request.method === "client/registerCapability"
        ? {
            code: -32803,
            message: "Dynamic capability registration is not supported",
          }
        : { code: -32601, message: "Method not found" };
    const content = JSON.stringify({ jsonrpc: "2.0", id: request.id, error });
    void this.enqueueOutboundWrite(() =>
      this.writeMessage(
        `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`,
      ),
    ).catch(() => {
      // Teardown separately rejects client requests and closes stdin.
    });
  }

  private handleTransportFailure(error: Error): void {
    if (this.disconnected) return;
    this.connectionGeneration++;
    this.disconnected = true;
    this.terminalError = error;
    this.cancelPendingWrites(error);
    this.rejectPendingRequests(error);
    this.cancelDiagnosticWaiters(error);
    if (this.process) {
      try {
        this.process.kill("SIGKILL");
      } catch {
        // Broken transport cleanup is best-effort.
      }
      this.process = null;
    }
    this.clearConnectionState();
  }

  private rejectPendingRequests(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  private cancelPendingWrites(error: Error): void {
    this.writeGeneration++;
    for (const reject of this.writeWaiterRejectors) reject(error);
  }

  private cancelDiagnosticWaiters(error: Error): void {
    for (const waiters of this.diagnosticWaiters.values())
      for (const wake of waiters) wake(error);
    this.diagnosticWaiters.clear();
  }

  private clearConnectionState(): void {
    this.initialized = false;
    this.openDocuments.clear();
    this.documentOpenPromises.clear();
    this.diagnostics.clear();
    this.buffer = Buffer.alloc(0);
  }

  private isCurrentConnection(
    child: ChildProcess | null,
    generation: number,
  ): boolean {
    return (
      child !== null &&
      this.process === child &&
      this.connectionGeneration === generation &&
      !this.disconnected
    );
  }

  private assertCurrentConnection(
    child: ChildProcess | null,
    generation: number,
  ): void {
    if (!this.isCurrentConnection(child, generation))
      throw this.terminalError ?? new Error("LSP connection was replaced");
  }

  private throwIfTerminal(): void {
    if (this.terminalError) throw this.terminalError;
    if (this.disconnected) throw new Error("LSP client is disconnected");
  }

  private toServerUri(uri: string): string {
    return hostUriToContainerUri(uri, this.devContainerContext);
  }

  private translateIncomingPayload<T>(value: T): T {
    if (!this.devContainerContext || value === null || value === undefined)
      return value;
    return this.translateIncomingValue(value) as T;
  }

  private translateIncomingValue(value: unknown): unknown {
    if (Array.isArray(value))
      return value.map((item) => this.translateIncomingValue(item));
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => {
        if (
          (key === "uri" ||
            key === "targetUri" ||
            key === "newUri" ||
            key === "oldUri") &&
          typeof entry === "string"
        ) {
          return [key, containerUriToHostUri(entry, this.devContainerContext)];
        }
        if (
          key === "changes" &&
          entry &&
          typeof entry === "object" &&
          !Array.isArray(entry)
        ) {
          return [
            key,
            Object.fromEntries(
              Object.entries(entry as Record<string, unknown>).map(
                ([uri, change]) => [
                  containerUriToHostUri(uri, this.devContainerContext),
                  this.translateIncomingValue(change),
                ],
              ),
            ),
          ];
        }
        return [key, this.translateIncomingValue(entry)];
      }),
    );
  }
}

/** Pool LSP clients per workspace/server, preserving lease-based idle eviction. */
export class LspClientManager {
  private clients = new Map<string, LspClient>();
  private pendingClients = new Map<
    string,
    { client: LspClient; promise: Promise<LspClient> }
  >();
  private lastUsed = new Map<string, number>();
  private inFlightCount = new Map<string, number>();
  private idleDeadlines = new Map<string, ReturnType<typeof setTimeout>>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private clientGeneration = 0;
  private disconnecting: Promise<void> | null = null;

  constructor() {
    this.startIdleCheck();
    this.registerCleanupHandlers();
  }

  async getClientForFile(filePath: string): Promise<LspClient | null> {
    const workspaceRoot = this.findWorkspaceRoot(filePath);
    const server = getServerForFile(filePath, workspaceRoot);
    if (!server) return null;
    const context = resolveDevContainerContext(workspaceRoot);
    const key = this.clientKey(workspaceRoot, server, context);
    while (true) {
      const client = await this.acquireClient(
        key,
        workspaceRoot,
        server,
        context,
      );
      if (
        this.clients.get(key) === client &&
        client.isUsable &&
        !this.disconnecting
      )
        return client;
    }
  }

  async runWithClientLease<T>(
    filePath: string,
    fn: (client: LspClient) => Promise<T>,
  ): Promise<T> {
    const workspaceRoot = this.findWorkspaceRoot(filePath);
    const server = getServerForFile(filePath, workspaceRoot);
    if (!server)
      throw new Error(`No language server available for: ${filePath}`);
    const context = resolveDevContainerContext(workspaceRoot);
    const key = this.clientKey(workspaceRoot, server, context);
    const client = await this.acquireClientLease(
      key,
      workspaceRoot,
      server,
      context,
    );
    try {
      return await fn(client);
    } finally {
      if (this.clients.get(key) === client) {
        const next = (this.inFlightCount.get(key) ?? 1) - 1;
        if (next <= 0) this.inFlightCount.delete(key);
        else this.inFlightCount.set(key, next);
        this.touchClient(key);
      }
    }
  }

  async disconnectAll(): Promise<void> {
    if (this.disconnecting) return this.disconnecting;
    const teardown = Promise.resolve().then(() => this.performDisconnectAll());
    this.disconnecting = teardown;
    try {
      await teardown;
    } finally {
      if (this.disconnecting === teardown) this.disconnecting = null;
    }
  }

  getInFlightCount(key: string): number {
    return this.inFlightCount.get(key) ?? 0;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  triggerEviction(): void {
    this.evictIdleClients();
  }

  private async acquireClient(
    key: string,
    workspaceRoot: string,
    server: LspServerConfig,
    context: DevContainerContext | null,
  ): Promise<LspClient> {
    while (true) {
      if (this.disconnecting) await this.disconnecting;
      const generation = this.clientGeneration;
      this.startIdleCheck();
      const existing = this.clients.get(key);
      if (existing?.isUsable) {
        this.touchClient(key);
        return existing;
      }
      const client = await this.getOrCreateClient(
        key,
        workspaceRoot,
        server,
        context,
      );
      if (
        generation === this.clientGeneration &&
        !this.disconnecting &&
        client.isUsable
      ) {
        this.touchClient(key);
        return client;
      }
    }
  }

  private async acquireClientLease(
    key: string,
    workspaceRoot: string,
    server: LspServerConfig,
    context: DevContainerContext | null,
  ): Promise<LspClient> {
    while (true) {
      if (this.disconnecting) await this.disconnecting;
      const generation = this.clientGeneration;
      this.startIdleCheck();
      const existing = this.clients.get(key);
      if (existing?.isUsable) {
        this.touchClient(key);
        this.inFlightCount.set(key, (this.inFlightCount.get(key) ?? 0) + 1);
        return existing;
      }
      const client = await this.getOrCreateClient(
        key,
        workspaceRoot,
        server,
        context,
      );
      if (
        generation === this.clientGeneration &&
        !this.disconnecting &&
        client.isUsable
      ) {
        this.touchClient(key);
        this.inFlightCount.set(key, (this.inFlightCount.get(key) ?? 0) + 1);
        return client;
      }
    }
  }

  private getOrCreateClient(
    key: string,
    workspaceRoot: string,
    server: LspServerConfig,
    context: DevContainerContext | null,
  ): Promise<LspClient> {
    const existing = this.clients.get(key);
    if (existing?.isUsable) return Promise.resolve(existing);
    if (existing) {
      existing.forceKill();
      this.removeClient(key);
    }

    let pending = this.pendingClients.get(key);
    if (!pending) {
      const client = new LspClient(workspaceRoot, server, context);
      const generation = this.clientGeneration;
      const promise = client
        .connect()
        .then(() => {
          if (generation !== this.clientGeneration) {
            client.forceKill();
            throw new Error("LSP client manager shut down during connection");
          }
          this.clients.set(key, client);
          return client;
        })
        .finally(() => {
          if (this.pendingClients.get(key)?.client === client)
            this.pendingClients.delete(key);
        });
      pending = { client, promise };
      this.pendingClients.set(key, pending);
    }
    return pending.promise;
  }

  private findWorkspaceRoot(filePath: string): string {
    let dir = dirname(resolve(filePath));
    const markers = [
      "build.gradle",
      "build.gradle.kts",
      "settings.gradle",
      "settings.gradle.kts",
      "pom.xml",
      "package.json",
      "tsconfig.json",
      "pyproject.toml",
      "Cargo.toml",
      "go.mod",
      ".git",
    ];
    while (true) {
      if (parse(dir).root === dir) break;
      if (markers.some((marker) => existsSync(join(dir, marker)))) return dir;
      dir = dirname(dir);
    }
    return dirname(resolve(filePath));
  }

  private clientKey(
    workspaceRoot: string,
    server: LspServerConfig,
    context: DevContainerContext | null,
  ): string {
    return `${workspaceRoot}:${server.command}:${context?.containerId ?? "host"}`;
  }

  private touchClient(key: string): void {
    this.lastUsed.set(key, Date.now());
    this.scheduleIdleDeadline(key);
  }

  private startIdleCheck(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(
      () => this.evictIdleClients(),
      IDLE_CHECK_INTERVAL_MS,
    );
    if (typeof this.idleTimer === "object" && "unref" in this.idleTimer)
      this.idleTimer.unref();
  }

  private scheduleIdleDeadline(key: string): void {
    this.clearIdleDeadline(key);
    const timer = setTimeout(() => {
      this.idleDeadlines.delete(key);
      this.evictClientIfIdle(key);
    }, IDLE_TIMEOUT_MS);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    this.idleDeadlines.set(key, timer);
  }

  private clearIdleDeadline(key: string): void {
    const timer = this.idleDeadlines.get(key);
    if (timer) clearTimeout(timer);
    this.idleDeadlines.delete(key);
  }

  private evictIdleClients(): void {
    for (const key of this.lastUsed.keys()) this.evictClientIfIdle(key);
  }

  private evictClientIfIdle(key: string): void {
    const lastUsed = this.lastUsed.get(key);
    if (lastUsed === undefined) {
      this.clearIdleDeadline(key);
      return;
    }
    if (Date.now() - lastUsed <= IDLE_TIMEOUT_MS) {
      if (!this.idleDeadlines.has(key)) this.scheduleIdleDeadline(key);
      return;
    }
    if ((this.inFlightCount.get(key) ?? 0) > 0) {
      this.scheduleIdleDeadline(key);
      return;
    }
    const client = this.clients.get(key);
    this.removeClient(key);
    void client?.disconnect().catch(() => {
      // Eviction never hides errors from an active request; no request holds a lease here.
    });
  }

  private removeClient(key: string): void {
    this.clearIdleDeadline(key);
    this.clients.delete(key);
    this.lastUsed.delete(key);
    this.inFlightCount.delete(key);
  }

  private async performDisconnectAll(): Promise<void> {
    this.clientGeneration++;
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    for (const timer of this.idleDeadlines.values()) clearTimeout(timer);
    this.idleDeadlines.clear();

    for (const { client } of this.pendingClients.values()) {
      try {
        client.forceKill();
      } catch {
        // Continue disconnecting clients that were not still connecting.
      }
    }
    this.pendingClients.clear();
    const clients = Array.from(this.clients.entries());
    this.clients.clear();
    this.lastUsed.clear();
    this.inFlightCount.clear();
    const results = await Promise.allSettled(
      clients.map(([, client]) => client.disconnect()),
    );
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected")
        console.warn(
          `LSP disconnectAll: failed to disconnect client "${clients[index][0]}": ${result.reason}`,
        );
    }
  }

  private registerCleanupHandlers(): void {
    const forceKillAll = () => {
      if (this.idleTimer) clearInterval(this.idleTimer);
      this.idleTimer = null;
      for (const timer of this.idleDeadlines.values()) clearTimeout(timer);
      this.idleDeadlines.clear();
      for (const client of this.clients.values()) {
        try {
          client.forceKill();
        } catch {
          // Process termination must continue cleaning up the remaining clients.
        }
      }
      for (const { client } of this.pendingClients.values()) {
        try {
          client.forceKill();
        } catch {
          // Process termination must continue cleaning up the remaining clients.
        }
      }
      this.clientGeneration++;
      this.clients.clear();
      this.pendingClients.clear();
      this.lastUsed.clear();
      this.inFlightCount.clear();
    };
    process.on("exit", forceKillAll);
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
      process.on(signal, forceKillAll);
  }
}

const MANAGER_KEY = "__openGajaeLspManager";
type GlobalWithLspManager = typeof globalThis & {
  [MANAGER_KEY]?: LspClientManager;
};
const globalWithLspManager = globalThis as GlobalWithLspManager;

/** Process-global manager, preventing duplicate pools after module indirection. */
export const lspManager =
  globalWithLspManager[MANAGER_KEY] ??
  (globalWithLspManager[MANAGER_KEY] = new LspClientManager());

export async function disconnectAll(): Promise<void> {
  return lspManager.disconnectAll();
}
