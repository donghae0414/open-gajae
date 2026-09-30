// The workflow HUD summary an active row carries (`hud`), shared by the
// workflow skills: its types, the chip helpers the skill builders use, and
// the normalizer every row write applies (DR-9). Pure. Moved from
// `src/ralplan-runtime/hud.ts`, which keeps the ralplan builder (plan S1).
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/`:
// - `skill-state/active-state.ts:27-43` (`WorkflowHudSeverity`,
//   `WorkflowHudChip`, `WorkflowHudSummary`), `:133-203`
//   (`normalizeWorkflowHudSummary`: at most 6 chips in array order, values at
//   most 80 characters)
// - `skill-state/workflow-hud.ts:3-7` (`WorkflowGateHudState`), `:61-81`
//   (`chip`, `gateChips`, `compactChips`)

export type WorkflowHudSeverity = "info" | "warning" | "blocked" | "error" | "success";

export interface WorkflowHudChip {
  label: string;
  value?: string;
  priority?: number;
  severity?: WorkflowHudSeverity;
}

export interface WorkflowHudSummary {
  version: 1;
  summary?: string;
  chips?: WorkflowHudChip[];
  details?: WorkflowHudChip[];
  severity?: WorkflowHudSeverity;
  updated_at?: string;
}

export interface WorkflowGateHudState {
  approvalStatus?: string;
  blockedReason?: string;
  nextAction?: string;
}

export function chip(
  label: string,
  value: string | undefined,
  priority: number,
  severity?: WorkflowHudChip["severity"],
): WorkflowHudChip | null {
  if (!value) return null;
  return { label, value, priority, ...(severity ? { severity } : {}) };
}

export function gateChips(
  state: WorkflowGateHudState,
  gatePriority: number,
): Array<WorkflowHudChip | null> {
  return [
    chip(
      "gate",
      state.approvalStatus,
      gatePriority,
      state.approvalStatus === "approved" ? "success" : "warning",
    ),
    chip("blocked", state.blockedReason, gatePriority + 10, "blocked"),
    chip("next", state.nextAction, gatePriority + 20),
  ];
}

export function compactChips(chips: Array<WorkflowHudChip | null>): WorkflowHudChip[] {
  return chips.filter((item): item is WorkflowHudChip => item !== null);
}

const HUD_TEXT_LIMIT = 80;
const HUD_CHIP_LIMIT = 6;
const HUD_DETAIL_LIMIT = 12;
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const HUD_SEVERITIES = new Set<WorkflowHudSeverity>([
  "info",
  "warning",
  "blocked",
  "error",
  "success",
]);

function safeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sanitizeHudString(value: unknown, limit = HUD_TEXT_LIMIT): string | undefined {
  const normalized = safeString(value)
    .replace(ANSI_PATTERN, "")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  if (!normalized) return undefined;
  return normalized.length > limit ? normalized.slice(0, limit) : normalized;
}

function normalizeSeverity(value: unknown): WorkflowHudSeverity | undefined {
  return typeof value === "string" && HUD_SEVERITIES.has(value as WorkflowHudSeverity)
    ? (value as WorkflowHudSeverity)
    : undefined;
}

function normalizeHudChip(raw: unknown): WorkflowHudChip | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const label = sanitizeHudString(record.label, 32);
  if (!label) return null;
  const value = sanitizeHudString(record.value, HUD_TEXT_LIMIT);
  const priority =
    typeof record.priority === "number" && Number.isFinite(record.priority)
      ? record.priority
      : undefined;
  const severity = normalizeSeverity(record.severity);
  return {
    label,
    ...(value ? { value } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(severity ? { severity } : {}),
  };
}

function normalizeHudChips(raw: unknown, limit: number): WorkflowHudChip[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const chips = raw
    .map(normalizeHudChip)
    .filter((item): item is WorkflowHudChip => item !== null)
    .slice(0, limit);
  return chips.length > 0 ? chips : undefined;
}

/** DR-9: the summary as it is stored on the active row. */
export function normalizeWorkflowHudSummary(raw: unknown): WorkflowHudSummary | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) return undefined;
  const summary = sanitizeHudString(record.summary);
  const chips = normalizeHudChips(record.chips, HUD_CHIP_LIMIT);
  const details = normalizeHudChips(record.details, HUD_DETAIL_LIMIT);
  const severity = normalizeSeverity(record.severity);
  const updatedAt = sanitizeHudString(record.updated_at, 40);
  return {
    version: 1,
    ...(summary ? { summary } : {}),
    ...(chips ? { chips } : {}),
    ...(details ? { details } : {}),
    ...(severity ? { severity } : {}),
    ...(updatedAt ? { updated_at: updatedAt } : {}),
  };
}
