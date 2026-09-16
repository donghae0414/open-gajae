import { spawnSync } from "child_process";
import { existsSync, readFileSync, readdirSync } from "fs";
import { basename, dirname, join, parse, relative, resolve, sep } from "path";
import { posix } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { parseJsonc } from "../../utils/jsonc.js";

// Ported from oh-my-claudecode@5281b19e0d64f8e6dc6767f2130299a88af2dc71
// src/tools/lsp/devcontainer.ts; only the product environment prefix differs.
const PRIMARY_CONFIG_PATH = [".devcontainer", "devcontainer.json"] as const;
const DOTFILE_NAME = ".devcontainer.json";
const CONFIG_DIR = ".devcontainer";
const LOCAL_FOLDER_LABELS = ["devcontainer.local_folder", "vsch.local.folder"];
const CONFIG_FILE_LABELS = ["devcontainer.config_file", "vsch.config.file"];

interface DockerInspectMount {
  Source?: string;
  Destination?: string;
}

interface DockerInspectResult {
  Id?: string;
  Config?: { Labels?: Record<string, string> };
  Mounts?: DockerInspectMount[];
  State?: { Running?: boolean };
}

interface DevContainerJson {
  workspaceFolder?: string;
}

export interface DevContainerContext {
  containerId: string;
  hostWorkspaceRoot: string;
  containerWorkspaceRoot: string;
  configFilePath?: string;
}

/**
 * Resolve the running development container that owns this workspace.
 * OPEN_GAJAE_LSP_CONTAINER_ID is the product-specific equivalent of OMC's
 * container override; OMC environment variables are intentionally ignored.
 */
export function resolveDevContainerContext(
  workspaceRoot: string,
): DevContainerContext | null {
  const hostWorkspaceRoot = resolve(workspaceRoot);
  const configFilePath = resolveDevContainerConfigPath(hostWorkspaceRoot);
  const config = readDevContainerConfig(configFilePath);
  const containerId = process.env.OPEN_GAJAE_LSP_CONTAINER_ID?.trim();

  if (containerId) {
    return buildContextFromContainer(
      containerId,
      hostWorkspaceRoot,
      configFilePath,
      config,
    );
  }

  let bestMatch: { score: number; context: DevContainerContext } | undefined;
  for (const id of listRunningContainerIds()) {
    const inspect = inspectContainer(id);
    if (!inspect) continue;

    const score = scoreContainerMatch(
      inspect,
      hostWorkspaceRoot,
      configFilePath,
    );
    if (score <= 0) continue;

    const context = buildContextFromInspect(
      inspect,
      hostWorkspaceRoot,
      configFilePath,
      config,
    );
    if (context && (!bestMatch || score > bestMatch.score)) {
      bestMatch = { score, context };
    }
  }

  return bestMatch?.context ?? null;
}

export function hostPathToContainerPath(
  filePath: string,
  context: DevContainerContext | null | undefined,
): string {
  if (!context) return resolve(filePath);

  const resolvedPath = resolve(filePath);
  const relativePath = relative(context.hostWorkspaceRoot, resolvedPath);
  if (relativePath === "") return context.containerWorkspaceRoot;
  if (isOutsideHostWorkspace(relativePath)) return resolvedPath;

  return posix.join(
    context.containerWorkspaceRoot,
    relativePath.split(sep).join("/"),
  );
}

export function containerPathToHostPath(
  filePath: string,
  context: DevContainerContext | null | undefined,
): string {
  if (!context) return resolve(filePath);

  const normalizedPath = normalizeContainerPath(filePath);
  const relativePath = posix.relative(
    context.containerWorkspaceRoot,
    normalizedPath,
  );
  if (relativePath === "") return context.hostWorkspaceRoot;
  if (relativePath.startsWith("..") || relativePath.includes("../"))
    return normalizedPath;

  return resolve(context.hostWorkspaceRoot, ...relativePath.split("/"));
}

export function hostUriToContainerUri(
  uri: string,
  context: DevContainerContext | null | undefined,
): string {
  if (!context || !uri.startsWith("file://")) return uri;
  return containerPathToFileUri(
    hostPathToContainerPath(fileURLToPath(uri), context),
  );
}

export function containerUriToHostUri(
  uri: string,
  context: DevContainerContext | null | undefined,
): string {
  if (!context || !uri.startsWith("file://")) return uri;
  return pathToFileURL(containerPathToHostPath(fileURLToPath(uri), context))
    .href;
}

function resolveDevContainerConfigPath(
  workspaceRoot: string,
): string | undefined {
  let dir = workspaceRoot;
  while (true) {
    const configPath = resolveDevContainerConfigPathAt(dir);
    if (configPath) return configPath;
    if (parse(dir).root === dir) return undefined;
    dir = dirname(dir);
  }
}

function resolveDevContainerConfigPathAt(dir: string): string | undefined {
  const primary = join(dir, ...PRIMARY_CONFIG_PATH);
  if (existsSync(primary)) return primary;

  const dotfile = join(dir, DOTFILE_NAME);
  if (existsSync(dotfile)) return dotfile;

  const configDir = join(dir, CONFIG_DIR);
  if (!existsSync(configDir)) return undefined;

  return readdirSync(configDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(configDir, entry.name, "devcontainer.json"))
    .filter(existsSync)
    .sort((left, right) => left.localeCompare(right))[0];
}

function readDevContainerConfig(configPath?: string): DevContainerJson | null {
  if (!configPath || !existsSync(configPath)) return null;
  try {
    const parsed = parseJsonc(readFileSync(configPath, "utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as DevContainerJson)
      : null;
  } catch {
    return null;
  }
}

function listRunningContainerIds(): string[] {
  const result = runDocker(["ps", "-q"]);
  if (!result || result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function inspectContainer(containerId: string): DockerInspectResult | null {
  const result = runDocker(["inspect", containerId]);
  if (!result || result.status !== 0) return null;
  try {
    const inspect = JSON.parse(result.stdout) as DockerInspectResult[];
    return inspect[0]?.Id && inspect[0].State?.Running !== false
      ? inspect[0]
      : null;
  } catch {
    return null;
  }
}

function buildContextFromContainer(
  containerId: string,
  hostRoot: string,
  configPath?: string,
  config?: DevContainerJson | null,
): DevContainerContext | null {
  const inspect = inspectContainer(containerId);
  return inspect
    ? buildContextFromInspect(inspect, hostRoot, configPath, config)
    : null;
}

function buildContextFromInspect(
  inspect: DockerInspectResult,
  hostRoot: string,
  configPath?: string,
  config?: DevContainerJson | null,
): DevContainerContext | null {
  const containerWorkspaceRoot = deriveContainerWorkspaceRoot(
    inspect,
    hostRoot,
    config?.workspaceFolder,
  );
  if (!inspect.Id || !containerWorkspaceRoot) return null;
  return {
    containerId: inspect.Id,
    hostWorkspaceRoot: hostRoot,
    containerWorkspaceRoot,
    configFilePath: configPath,
  };
}

function deriveContainerWorkspaceRoot(
  inspect: DockerInspectResult,
  hostRoot: string,
  workspaceFolder?: string,
): string | null {
  let bestMount: { sourceLength: number; destination: string } | undefined;
  for (const mount of inspect.Mounts ?? []) {
    const source = mount.Source ? resolve(mount.Source) : "";
    const destination = mount.Destination
      ? normalizeContainerPath(mount.Destination)
      : "";
    if (!source || !destination) continue;
    if (source === hostRoot) return destination;

    const relativePath = relative(source, hostRoot);
    if (isOutsideHostWorkspace(relativePath)) continue;
    if (!bestMount || source.length > bestMount.sourceLength) {
      bestMount = {
        sourceLength: source.length,
        destination: posix.join(destination, relativePath.split(sep).join("/")),
      };
    }
  }
  return (
    bestMount?.destination ??
    (workspaceFolder ? normalizeContainerPath(workspaceFolder) : null)
  );
}

function scoreContainerMatch(
  inspect: DockerInspectResult,
  hostRoot: string,
  configPath?: string,
): number {
  const labels = inspect.Config?.Labels ?? {};
  const expectedFolder = configPath
    ? deriveHostDevContainerRoot(configPath)
    : resolve(hostRoot);
  let score = 0;
  let hasLabelMatch = false;

  for (const label of LOCAL_FOLDER_LABELS) {
    if (labels[label] && resolve(labels[label]) === expectedFolder) {
      score += 4;
      hasLabelMatch = true;
    }
  }
  if (configPath) {
    for (const label of CONFIG_FILE_LABELS) {
      if (labels[label] && resolve(labels[label]) === configPath) {
        score += 3;
        hasLabelMatch = true;
      }
    }
  }
  if (
    deriveContainerWorkspaceRoot(inspect, hostRoot) &&
    (configPath || hasLabelMatch)
  )
    score += 1;
  return score;
}

function deriveHostDevContainerRoot(configPath: string): string {
  const resolvedPath = resolve(configPath);
  if (basename(resolvedPath) === DOTFILE_NAME) return dirname(resolvedPath);
  const parent = dirname(resolvedPath);
  if (basename(parent) === CONFIG_DIR) return dirname(parent);
  const grandparent = dirname(parent);
  return basename(grandparent) === CONFIG_DIR ? dirname(grandparent) : parent;
}

function isOutsideHostWorkspace(relativePath: string): boolean {
  return relativePath.startsWith("..") || relativePath.includes(`..${sep}`);
}

function normalizeContainerPath(filePath: string): string {
  return posix.normalize(filePath.replace(/\\/g, "/"));
}

function containerPathToFileUri(filePath: string): string {
  const encodedPath = normalizeContainerPath(filePath)
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `file://${encodedPath.startsWith("/") ? encodedPath : `/${encodedPath}`}`;
}

function runDocker(
  args: string[],
): { status: number | null; stdout: string } | null {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error) return null;
  const stdout = result.stdout ?? "";
  return { status: result.status, stdout };
}
