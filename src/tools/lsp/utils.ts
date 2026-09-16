import type {
  DocumentSymbol,
  Location,
  SymbolInformation,
  Range,
} from "./client.js";

// Focused formatter port from oh-my-claudecode@5281b19e0d64f8e6dc6767f2130299a88af2dc71
// src/tools/lsp/utils.ts.
const SYMBOL_KINDS: Record<number, string> = {
  1: "File",
  2: "Module",
  3: "Namespace",
  4: "Package",
  5: "Class",
  6: "Method",
  7: "Property",
  8: "Field",
  9: "Constructor",
  10: "Enum",
  11: "Interface",
  12: "Function",
  13: "Variable",
  14: "Constant",
  15: "String",
  16: "Number",
  17: "Boolean",
  18: "Array",
  19: "Object",
  20: "Key",
  21: "Null",
  22: "EnumMember",
  23: "Struct",
  24: "Event",
  25: "Operator",
  26: "TypeParameter",
};

export function uriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  try {
    return decodeURIComponent(uri.slice(7));
  } catch {
    return uri.slice(7);
  }
}

export function formatPosition(line: number, character: number): string {
  return `${line + 1}:${character + 1}`;
}

export function formatRange(range: Range): string {
  const start = formatPosition(range.start.line, range.start.character);
  const end = formatPosition(range.end.line, range.end.character);
  return start === end ? start : `${start}-${end}`;
}

export function formatLocation(location: Location): string {
  const link = location as Location & {
    targetUri?: string;
    targetRange?: Range;
    targetSelectionRange?: Range;
  };
  const uri = link.uri || link.targetUri;
  if (!uri) return "Unknown location";
  const range = link.range || link.targetRange || link.targetSelectionRange;
  return range ? `${uriToPath(uri)}:${formatRange(range)}` : uriToPath(uri);
}

/** Format LSP references using the OMC text contract. */
export function formatLocations(
  locations: Location | Location[] | null,
): string {
  if (!locations) return "No locations found";
  const items = Array.isArray(locations) ? locations : [locations];
  return items.length > 0
    ? items.map(formatLocation).join("\n")
    : "No locations found";
}

/** Format hierarchical document symbols using the OMC text contract. */
export function formatDocumentSymbols(
  symbols: DocumentSymbol[] | SymbolInformation[] | null,
  indent = 0,
): string {
  if (!symbols || symbols.length === 0) return "No symbols found";

  const lines: string[] = [];
  const prefix = "  ".repeat(indent);
  for (const symbol of symbols) {
    const kind = SYMBOL_KINDS[symbol.kind] || "Unknown";
    if ("range" in symbol) {
      lines.push(
        `${prefix}${kind}: ${symbol.name} [${formatRange(symbol.range)}]`,
      );
      if (symbol.children?.length)
        lines.push(formatDocumentSymbols(symbol.children, indent + 1));
    } else {
      const container = symbol.containerName
        ? ` (in ${symbol.containerName})`
        : "";
      lines.push(
        `${prefix}${kind}: ${symbol.name}${container} [${formatLocation(symbol.location)}]`,
      );
    }
  }
  return lines.join("\n");
}

export function formatWorkspaceSymbols(
  symbols: SymbolInformation[] | null,
): string {
  if (!symbols || symbols.length === 0) return "No symbols found";
  return symbols
    .map((symbol) => {
      const kind = SYMBOL_KINDS[symbol.kind] || "Unknown";
      const container = symbol.containerName
        ? ` (in ${symbol.containerName})`
        : "";
      return `${kind}: ${symbol.name}${container}\n  ${formatLocation(symbol.location)}`;
    })
    .join("\n\n");
}
