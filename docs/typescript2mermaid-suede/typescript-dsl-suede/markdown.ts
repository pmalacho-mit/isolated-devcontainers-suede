/**
 * Embedding generated output into Markdown, idempotently.
 *
 * An author marks a spot with an HTML comment — invisible when the Markdown is
 * rendered — and the tool fills the region beneath it:
 *
 *   <!-- diagram: DeploymentPipeline -->
 *   ```mermaid
 *   flowchart TD
 *       …
 *   ```
 *   <!-- /diagram -->
 *
 * The author only ever writes the opening line; the closing marker is inserted
 * on the first run and is what makes every later run a replace rather than an
 * append.
 *
 * Pure string in, string out — no filesystem — so it is trivially testable and
 * a caller can decide what "write" means (disk, a check-only diff, a
 * `WorkspaceEdit`).
 *
 * Nothing here is Mermaid-specific: the marker keyword, the fence language, and
 * how a name resolves to content are all supplied by the caller.
 */

/** One `<!-- marker: name … -->` site found in a document. */
export interface EmbedTarget {
  /** The name the marker asks for. */
  name: string;
  /** Any `key=value` attributes on the marker line. */
  attrs: Record<string, string>;
  /** 0-based line of the opening marker. */
  line: number;
  /** The marker line, verbatim. */
  source: string;
  /**
   * True when a closing marker was found, i.e. this site already holds
   * generated content. Without one, the region is treated as empty and no
   * author-written text is ever removed.
   */
  populated: boolean;
  /** Existing generated region (between the markers), or `""` when new. */
  current: string;
}

export interface EmbedOptions {
  /** Marker keyword: `<!-- diagram: Name -->`. Default `"embed"`. */
  marker?: string;
  /** Fence language for generated blocks. Default: no language. */
  language?: string;
  /** Override how resolved content becomes Markdown. Default: a fenced block. */
  block?(content: string, target: EmbedTarget): string;
}

export interface EmbedResult {
  /** The updated document. */
  text: string;
  /** True when `text` differs from the input. */
  changed: boolean;
  /** Targets that resolved and were written. */
  embedded: EmbedTarget[];
  /** Targets whose name resolved to nothing — left untouched, never wiped. */
  unresolved: EmbedTarget[];
}

/**
 * Resolves a marker to the content that belongs there. Returning `undefined`
 * leaves the region exactly as it was: a renamed or deleted declaration should
 * surface as a reported problem, not as silently deleted documentation.
 */
export type Resolve = (target: EmbedTarget) => string | undefined;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const openRe = (marker: string) =>
  new RegExp(
    `^[ \\t]*<!--[ \\t]*${escapeRe(marker)}[ \\t]*:[ \\t]*([^\\s>]+)([^>]*?)-->[ \\t]*$`,
  );

const closeRe = (marker: string) =>
  new RegExp(`^[ \\t]*<!--[ \\t]*/[ \\t]*${escapeRe(marker)}[ \\t]*-->[ \\t]*$`);

const ATTR = /([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;

function parseAttrs(rest: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const [, key, quoted, single, bare] of rest.matchAll(ATTR))
    attrs[key!] = quoted ?? single ?? bare ?? "";
  return attrs;
}

/**
 * Tracks fenced code blocks so a marker *documented inside* a code block is not
 * mistaken for a real one. Generated blocks are balanced, so a populated region
 * still scans correctly.
 */
const fence = {
  open: (line: string): string | undefined =>
    /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1],
  closes: (line: string, open: string): boolean =>
    new RegExp(`^[ \\t]*${open[0] === "`" ? "`" : "~"}{${open.length},}[ \\t]*$`).test(
      line,
    ),
};

const EOL = /\r\n/;

/** Every marker site in a document, in order. */
export function targets(
  markdown: string,
  { marker = "embed" }: EmbedOptions = {},
): EmbedTarget[] {
  const open = openRe(marker);
  const close = closeRe(marker);
  const lines = markdown.split(/\r?\n/);
  const found: EmbedTarget[] = [];

  let openFence: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (openFence !== undefined) {
      if (fence.closes(line, openFence)) openFence = undefined;
      continue;
    }

    const match = open.exec(line);
    if (!match) {
      const started = fence.open(line);
      if (started) openFence = started;
      continue;
    }

    // Find the end of this site's generated region. A missing close marker —
    // or another open marker first — means the region is empty, so hand-written
    // content below an un-terminated marker is never swallowed.
    let end = -1;
    let scanFence: string | undefined;
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j]!;
      if (scanFence !== undefined) {
        if (fence.closes(candidate, scanFence)) scanFence = undefined;
        continue;
      }
      if (close.test(candidate)) {
        end = j;
        break;
      }
      if (open.test(candidate)) break;
      const started = fence.open(candidate);
      if (started) scanFence = started;
    }

    found.push({
      name: match[1]!,
      attrs: parseAttrs(match[2] ?? ""),
      line: i,
      source: line,
      populated: end !== -1,
      current: end === -1 ? "" : lines.slice(i + 1, end).join("\n"),
    });

    if (end !== -1) i = end;
  }

  return found;
}

/**
 * Fence the content, widening the delimiter past any backtick run inside it.
 *
 * Standard Markdown practice, and load-bearing here: a block that closes early
 * would leave the region unbalanced, so the next run could not find its own
 * closing marker and would append instead of replace.
 */
const fencedBlock =
  (language: string) =>
  (content: string): string => {
    const longest = Math.max(
      0,
      ...[...content.matchAll(/`+/g)].map((m) => m[0].length),
    );
    const ticks = "`".repeat(Math.max(3, longest + 1));
    return `${ticks}${language}\n${content}\n${ticks}`;
  };

/** Fill every marker site whose name resolves. */
export function embed(
  markdown: string,
  resolve: Resolve,
  options: EmbedOptions = {},
): EmbedResult {
  const { marker = "embed", language = "", block = fencedBlock(language) } =
    options;
  const sites = targets(markdown, options);
  if (sites.length === 0)
    return { text: markdown, changed: false, embedded: [], unresolved: [] };

  const eol = EOL.test(markdown) ? "\r\n" : "\n";
  const lines = markdown.split(/\r?\n/);
  const close = closeRe(marker);

  const embedded: EmbedTarget[] = [];
  const unresolved: EmbedTarget[] = [];
  const out: string[] = [];
  let cursor = 0;

  for (const site of sites) {
    out.push(...lines.slice(cursor, site.line + 1));
    cursor = site.line + 1;

    // Skip past the old region (and its closing marker) in the input.
    let end = cursor;
    if (site.populated) {
      while (end < lines.length && !close.test(lines[end]!)) end++;
      cursor = Math.min(end + 1, lines.length);
    }

    const content = resolve(site);
    if (content === undefined) {
      // Leave the site exactly as it was — a stale name is a problem to report,
      // not a reason to delete documentation.
      unresolved.push(site);
      out.push(...lines.slice(site.line + 1, cursor));
      continue;
    }

    out.push(...block(content, site).split("\n"), `<!-- /${marker} -->`);
    embedded.push(site);
  }

  out.push(...lines.slice(cursor));
  const text = out.join(eol);
  return { text, changed: text !== markdown, embedded, unresolved };
}
