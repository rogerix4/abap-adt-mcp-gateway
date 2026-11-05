/**
 * JSONC parsing.
 *
 * Configuration files are meant to be read and edited by people, so they allow
 * `//` and `/* *\/` comments plus trailing commas — the same dialect VS Code
 * uses for `settings.json`. Comments are stripped only when they are outside a
 * string, so `"https://host"` survives.
 */

/** A parse failure that names the file it came from. */
export class ConfigParseError extends Error {
  readonly source: string;

  constructor(source: string, message: string) {
    super(`${source}: ${message}`);
    this.name = "ConfigParseError";
    this.source = source;
  }
}

export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let escaped = false;

  while (i < text.length) {
    const ch = text[i] as string;

    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }

    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out.replace(/,(\s*[}\]])/g, "$1");
}

export function parseJsonc(text: string, source: string): unknown {
  const stripped = stripJsonc(text);
  try {
    return JSON.parse(stripped);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigParseError(source, `invalid JSON after removing comments (${detail})`);
  }
}
