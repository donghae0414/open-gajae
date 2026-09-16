import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

/**
 * Parse JSON with comments and trailing commas while retaining syntax errors.
 * Ported from oh-my-claudecode@5281b19e0d64f8e6dc6767f2130299a88af2dc71
 * src/utils/jsonc.ts, using the project's jsonc-parser dependency.
 */
export function parseJsonc(content: string): unknown {
  const errors: ParseError[] = [];
  const value = parse(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (errors.length > 0) {
    const error = errors[0];
    throw new SyntaxError(
      `Invalid JSONC at offset ${error.offset}: ${printParseErrorCode(error.error)}`,
    );
  }

  return value;
}
