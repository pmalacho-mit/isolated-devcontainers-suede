/**
 * A reusable VSCode harness for a type-level DSL.
 *
 * The harness knows exactly one thing about your DSL: it produces `Finding`s,
 * each anchored to a source range. Everything else is a contribution you supply
 * — what a finding looks like on hover, what lenses sit above it, whether it
 * raises a diagnostic, what commands act on it, and whether it can be previewed.
 *
 * What you get for free is the awkward part: a workspace-aware session pool, a
 * version-keyed cache, a dependency-aware refresh engine that also watches the
 * *other* files your findings depend on, source-edit application, an output
 * channel, and an optional preview panel.
 *
 * Depends on nothing but `vscode` and node built-ins — the analyzer is reached
 * only through the structural `DslSessionLike` interface.
 */
import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { previewHtml } from "./webview.js";

export { previewHtml, type PreviewRenderer } from "./webview.js";

/* ------------------------------ contracts ---------------------------- */

/** Structurally identical to the core's `SourceRange`. */
export interface SourceRange {
  file: string;
  start: number;
  end: number;
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

/** Structurally identical to the core's `Finding`. */
export interface Finding<T = unknown> {
  id: string;
  label?: string;
  range: SourceRange;
  data: T;
}

/** Structurally identical to the core's `SourceEdit`. */
export interface SourceEdit {
  file: string;
  start: number;
  end: number;
  text: string;
}

/** What the harness needs from an analyzer. `DslSession` satisfies this. */
export interface DslSessionLike<T = unknown> {
  updateFile(filePath: string, text: string): void;
  analyze(filePath: string): Finding<T>[];
  dependencies(filePath: string): string[];
  readonly gates?: readonly string[];
}

/* --------------------------- contribution IO ------------------------- */

export type DiagnosticSeverity = "error" | "warning" | "information" | "hint";

/** Editor-free diagnostic description, so DSL logic stays testable. */
export interface DslDiagnostic {
  message: string;
  severity?: DiagnosticSeverity;
  /** Defaults to the finding's range. */
  range?: SourceRange;
  source?: string;
  code?: string | number;
}

/** Editor-free code lens description. */
export interface DslLens {
  title: string;
  tooltip?: string;
  /**
   * A key in `commands`, or a fully-qualified command id if it contains a dot.
   * Omit to fall back to the preview command when one is configured.
   */
  command?: string;
  /** Defaults to `[documentUri, finding.id]`, which is what `commands` expects. */
  arguments?: unknown[];
  /** Defaults to the finding's range. */
  range?: SourceRange;
}

/** Handed to every contribution, for building links and command references. */
export interface ContributionApi<T> {
  /** The document the findings came from. */
  uri: string;
  /** Fully-qualified id for a key in `commands`. */
  commandId(key: string): string;
  /** Argument tuple that resolves back to this finding. */
  commandArgs(f: Finding<T>): [string, string];
  /** A markdown `command:` link. Requires `isTrusted` — see `trustedCommands`. */
  commandLink(f: Finding<T>, key: string, title: string): string;
  /** Present only when `preview` is configured. */
  previewLink?(f: Finding<T>, title?: string): string;
  /** Every command id the harness registered, for `MarkdownString.isTrusted`. */
  trustedCommands: string[];
}

export interface CommandContext<T> {
  document: vscode.TextDocument;
  session: DslSessionLike<T>;
  /** All findings in the document, freshly analyzed. */
  findings: Finding<T>[];
  log(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Apply source edits across one or more files as a single undo step. */
  applyEdits(edits: readonly SourceEdit[]): Promise<boolean>;
  /** Re-analyze and refresh every surface for this document. */
  refresh(): Promise<void>;
}

/** A command that acts on one finding. Registered as `${id}.${key}`. */
export type FindingCommand<T> = (
  finding: Finding<T>,
  ctx: CommandContext<T>,
) => void | Promise<void>;

export interface PreviewConfig<T> {
  /**
   * Extension-relative candidate paths for the renderer bundle; the first
   * *readable* one wins.
   */
  assets: string[];
  /** JS source defining `globalThis.DslRenderer` — see `PreviewRenderer`. */
  bootstrap: string;
  /** The artifact to render. Return `undefined` to decline this finding. */
  codeOf(f: Finding<T>): string | undefined;
  title?(f: Finding<T>): string;
  /** Files whose edits can affect a preview. Default `"**\/*.{ts,tsx}"`. */
  watch?: string;
  missingAssetMessage?: string;
}

export interface DslExtensionConfig<T = unknown> {
  /** Command namespace: `${id}.preview`, `${id}.showLog`, `${id}.<command key>`. */
  id: string;
  /** Human-facing name: output channel, message prefixes. */
  name: string;
  /** Defaults to TypeScript and TSX. */
  selector?: vscode.DocumentSelector;
  /** One session per workspace folder, with that folder's tsconfig. */
  createSession(tsConfigFilePath: string | undefined): DslSessionLike<T>;
  /**
   * Cheap substring prefilter. Defaults to the session's own `gates`. A document
   * matching none of them is never parsed.
   */
  gates?: readonly string[];
  /** Coalescing window for edit bursts. Default 250ms. */
  debounceMs?: number;

  hover?(
    f: Finding<T>,
    api: ContributionApi<T>,
  ): string | vscode.MarkdownString | undefined;
  lenses?(f: Finding<T>, api: ContributionApi<T>): DslLens[] | undefined;
  /**
   * Squiggles. Supplying this also makes the harness keep every visible document
   * analyzed and refreshed as its dependencies change — which is what a DSL that
   * reports pass/fail, rather than rendering something, actually wants.
   */
  diagnostics?(f: Finding<T>, api: ContributionApi<T>): DslDiagnostic[] | undefined;
  /** Turn an analysis failure into diagnostics instead of swallowing it. */
  onError?(error: unknown, document: vscode.TextDocument): DslDiagnostic[] | undefined;
  /** Commands acting on a finding, registered as `${id}.${key}`. */
  commands?: Record<string, FindingCommand<T>>;
  /** Opt-in webview preview. Omit for DSLs with nothing to render. */
  preview?: PreviewConfig<T>;
}

/* ------------------------------- internals --------------------------- */

/**
 * A document whose findings must be kept live, plus the files that can change
 * them. A declaration's referenced types usually live in *other* modules — the
 * checker resolves them at analysis time — so watching only the open file would
 * miss the edits that actually change the result.
 */
interface Target {
  uriString: string;
  deps: Set<string>;
  /** Open preview panels for this document, keyed by finding id. */
  previews: Map<string, { panel: vscode.WebviewPanel; code: string }>;
  /** Kept analyzed for squiggles even with no preview open. */
  diagnostics: boolean;
}

/**
 * ts-morph reports forward-slash paths while VSCode's `fsPath` uses the platform
 * separator; the two must be normalized before comparison or every dependency
 * lookup silently misses on Windows.
 */
const normalizePath = (p: string) => p.replace(/\\/g, "/");

const DEFAULT_SELECTOR: vscode.DocumentSelector = [
  { language: "typescript" },
  { language: "typescriptreact" },
];

const SEVERITIES: Record<DiagnosticSeverity, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  information: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

const toRange = (r: SourceRange): vscode.Range =>
  new vscode.Range(r.startLine, r.startCharacter, r.endLine, r.endCharacter);

export class DslExtension<T = unknown> implements vscode.Disposable {
  private readonly out: vscode.OutputChannel;
  private readonly sessions = new Map<string, DslSessionLike<T>>();
  private readonly cache = new Map<
    string,
    { version: number; findings: Finding<T>[] }
  >();
  private readonly targets = new Map<string, Target>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly diagnostics: vscode.DiagnosticCollection | undefined;

  private fsWatcher: vscode.FileSystemWatcher | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly changedFiles = new Set<string>();

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly config: DslExtensionConfig<T>,
  ) {
    this.out = vscode.window.createOutputChannel(config.name);
    this.diagnostics = config.diagnostics
      ? vscode.languages.createDiagnosticCollection(config.id)
      : undefined;
    this.register();
  }

  /* ------------------------------ logging ---------------------------- */

  /**
   * The webview is a separate context whose console is only reachable through
   * the webview developer tools, so failures in there are invisible from the
   * editor. Everything it does is mirrored here instead.
   */
  log(message: string): void {
    this.out.appendLine(`[${new Date().toISOString().slice(11, 23)}] ${message}`);
  }

  /* ------------------------- session + caching ----------------------- */

  private sessionFor(doc: vscode.TextDocument): DslSessionLike<T> {
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const key = folder?.uri.fsPath ?? "<no-workspace>";
    let session = this.sessions.get(key);
    if (!session) {
      const tsconfig = folder
        ? path.join(folder.uri.fsPath, "tsconfig.json")
        : undefined;
      session = this.config.createSession(
        tsconfig && fs.existsSync(tsconfig) ? tsconfig : undefined,
      );
      this.sessions.set(key, session);
    }
    return session;
  }

  private gatesFor(doc: vscode.TextDocument): readonly string[] {
    return this.config.gates ?? this.sessionFor(doc).gates ?? [];
  }

  private passesGates(doc: vscode.TextDocument): boolean {
    const gates = this.gatesFor(doc);
    if (gates.length === 0) return true;
    const text = doc.getText();
    return gates.some((g) => text.includes(g));
  }

  /** Findings for a document, served from cache when its version matches. */
  async findingsFor(doc: vscode.TextDocument): Promise<Finding<T>[]> {
    const hit = this.cache.get(doc.uri.fsPath);
    if (hit && hit.version === doc.version) return hit.findings;
    const session = this.sessionFor(doc);
    // Analyze the *buffer*, so findings reflect unsaved edits.
    session.updateFile(doc.uri.fsPath, doc.getText());
    const findings = session.analyze(doc.uri.fsPath);
    this.cache.set(doc.uri.fsPath, { version: doc.version, findings });
    return findings;
  }

  /** Findings, or `[]` when the document can't or won't analyze. Never throws. */
  private async safeFindings(doc: vscode.TextDocument): Promise<Finding<T>[]> {
    if (!this.passesGates(doc)) return [];
    try {
      return await this.findingsFor(doc);
    } catch {
      return []; // mid-edit syntax errors etc. — stay quiet
    }
  }

  /* ------------------------------ commands --------------------------- */

  private get previewCommand(): string {
    return `${this.config.id}.preview`;
  }

  private commandId(key: string): string {
    return key.includes(".") ? key : `${this.config.id}.${key}`;
  }

  private get trustedCommands(): string[] {
    const keys = Object.keys(this.config.commands ?? {}).map((k) =>
      this.commandId(k),
    );
    return this.config.preview ? [this.previewCommand, ...keys] : keys;
  }

  private api(uriString: string): ContributionApi<T> {
    const commandArgs = (f: Finding<T>): [string, string] => [uriString, f.id];
    const api: ContributionApi<T> = {
      uri: uriString,
      commandId: (key) => this.commandId(key),
      commandArgs,
      commandLink: (f, key, title) =>
        `[${title}](command:${this.commandId(key)}?${encodeURIComponent(
          JSON.stringify(commandArgs(f)),
        )})`,
      trustedCommands: this.trustedCommands,
    };
    if (this.config.preview)
      api.previewLink = (f, title = "Open preview") =>
        `[${title}](command:${this.previewCommand}?${encodeURIComponent(
          JSON.stringify(commandArgs(f)),
        )})`;
    return api;
  }

  private register(): void {
    const selector = this.config.selector ?? DEFAULT_SELECTOR;

    this.disposables.push(
      this.out,
      vscode.commands.registerCommand(`${this.config.id}.showLog`, () =>
        this.out.show(),
      ),
      vscode.workspace.onDidCloseTextDocument((doc) => this.onClose(doc)),
      vscode.workspace.onDidChangeTextDocument((e) =>
        this.noteSourceChanged(e.document.uri.fsPath),
      ),
    );
    if (this.diagnostics) this.disposables.push(this.diagnostics);

    if (this.config.hover)
      this.disposables.push(
        vscode.languages.registerHoverProvider(selector, {
          provideHover: (doc, pos) => this.provideHover(doc, pos),
        }),
      );

    if (this.config.lenses || this.config.preview)
      this.disposables.push(
        vscode.languages.registerCodeLensProvider(selector, {
          provideCodeLenses: (doc) => this.provideCodeLenses(doc),
        }),
      );

    for (const [key, handler] of Object.entries(this.config.commands ?? {}))
      this.disposables.push(
        vscode.commands.registerCommand(
          this.commandId(key),
          (uriString: string, findingId: string) =>
            this.runFindingCommand(key, handler, uriString, findingId),
        ),
      );

    if (this.config.preview)
      this.disposables.push(
        vscode.commands.registerCommand(
          this.previewCommand,
          (uriString: string, findingId: string) =>
            this.openPreview(uriString, findingId),
        ),
      );

    if (this.config.diagnostics) {
      this.disposables.push(
        vscode.window.onDidChangeVisibleTextEditors(() =>
          this.refreshVisibleDiagnostics(),
        ),
        vscode.workspace.onDidOpenTextDocument((doc) =>
          void this.refreshDocument(doc),
        ),
      );
      void this.refreshVisibleDiagnostics();
    }

    this.ctx.subscriptions.push(this);
    this.log(`activated (extension ${this.ctx.extensionPath})`);
    this.log(`VSCode ${vscode.version}`);
  }

  private onClose(doc: vscode.TextDocument): void {
    // The cache is keyed by path and would otherwise retain every file ever
    // touched for the lifetime of the window.
    this.cache.delete(doc.uri.fsPath);
    this.diagnostics?.delete(doc.uri);
    const target = this.targets.get(doc.uri.toString());
    if (target && target.previews.size === 0) this.dropTarget(doc.uri.toString());
  }

  /* ------------------------------- hover ----------------------------- */

  /**
   * Findings under the cursor. Exact range containment first; then anything
   * declared on the same line, so hovering the construct, an argument, or
   * anywhere else on the declaration still resolves; then a label match.
   */
  private findAt(
    findings: Finding<T>[],
    doc: vscode.TextDocument,
    pos: vscode.Position,
  ): Finding<T> | undefined {
    const offset = doc.offsetAt(pos);
    const exact = findings.find(
      (f) => offset >= f.range.start && offset <= f.range.end,
    );
    if (exact) return exact;
    const online = findings.find(
      (f) => pos.line >= f.range.startLine && pos.line <= f.range.endLine,
    );
    if (online) return online;
    const range = doc.getWordRangeAtPosition(pos);
    if (!range) return undefined;
    const word = doc.getText(range);
    return findings.find((f) => (f.label ?? f.id) === word);
  }

  private async provideHover(
    doc: vscode.TextDocument,
    pos: vscode.Position,
  ): Promise<vscode.Hover | undefined> {
    const findings = await this.safeFindings(doc);
    if (findings.length === 0) return;
    const hit = this.findAt(findings, doc, pos);
    if (!hit) return;

    const api = this.api(doc.uri.toString());
    const result = this.config.hover?.(hit, api);
    if (result === undefined) return;

    const md =
      typeof result === "string"
        ? new vscode.MarkdownString(result)
        : result;
    // Scoped trust — `isTrusted: true` grants far more than we need.
    if (md.isTrusted === undefined && api.trustedCommands.length > 0)
      md.isTrusted = { enabledCommands: api.trustedCommands };
    return new vscode.Hover(md, toRange(hit.range));
  }

  /* ----------------------------- code lenses ------------------------- */

  private async provideCodeLenses(
    doc: vscode.TextDocument,
  ): Promise<vscode.CodeLens[]> {
    const findings = await this.safeFindings(doc);
    if (findings.length === 0) return [];
    const uriString = doc.uri.toString();
    const api = this.api(uriString);
    const lenses: vscode.CodeLens[] = [];

    for (const finding of findings) {
      const specs =
        this.config.lenses?.(finding, api) ??
        // No lens contribution but a preview exists: offer the obvious one.
        (this.config.preview ? [{ title: "Preview" }] : []);
      for (const spec of specs) {
        const command =
          spec.command !== undefined
            ? this.commandId(spec.command)
            : this.config.preview
              ? this.previewCommand
              : undefined;
        lenses.push(
          new vscode.CodeLens(toRange(spec.range ?? finding.range), {
            title: spec.title,
            tooltip: spec.tooltip,
            command: command ?? "",
            arguments: spec.arguments ?? api.commandArgs(finding),
          }),
        );
      }
    }
    return lenses;
  }

  /* ----------------------------- diagnostics ------------------------- */

  private toDiagnostic(
    d: DslDiagnostic,
    fallback: SourceRange,
  ): vscode.Diagnostic {
    const diag = new vscode.Diagnostic(
      toRange(d.range ?? fallback),
      d.message,
      SEVERITIES[d.severity ?? "error"],
    );
    if (d.source) diag.source = d.source;
    if (d.code !== undefined) diag.code = d.code;
    return diag;
  }

  private async refreshDiagnostics(doc: vscode.TextDocument): Promise<void> {
    if (!this.config.diagnostics || !this.diagnostics) return;
    if (!this.passesGates(doc)) {
      this.diagnostics.delete(doc.uri);
      return;
    }

    const api = this.api(doc.uri.toString());
    let findings: Finding<T>[];
    try {
      findings = await this.findingsFor(doc);
    } catch (e) {
      // Half-typed code is a constant state while editing. By default keep the
      // last good squiggles rather than flashing; a DSL can opt into reporting.
      const reported = this.config.onError?.(e, doc);
      if (reported)
        this.diagnostics.set(
          doc.uri,
          reported.map((d) =>
            this.toDiagnostic(d, {
              file: doc.uri.fsPath,
              start: 0,
              end: 0,
              startLine: 0,
              startCharacter: 0,
              endLine: 0,
              endCharacter: 0,
            }),
          ),
        );
      return;
    }

    const out: vscode.Diagnostic[] = [];
    for (const finding of findings)
      for (const d of this.config.diagnostics(finding, api) ?? [])
        out.push(this.toDiagnostic(d, finding.range));
    this.diagnostics.set(doc.uri, out);
  }

  private async refreshVisibleDiagnostics(): Promise<void> {
    for (const editor of vscode.window.visibleTextEditors)
      await this.refreshDocument(editor.document);
  }

  /** Analyze a document, publish its squiggles, and keep it watched. */
  private async refreshDocument(doc: vscode.TextDocument): Promise<void> {
    if (!this.config.diagnostics) return;
    if (!this.passesGates(doc)) return;
    await this.refreshDiagnostics(doc);
    this.track(doc, { diagnostics: true });
  }

  /* ------------------------------ commands --------------------------- */

  private async runFindingCommand(
    key: string,
    handler: FindingCommand<T>,
    uriString: string,
    findingId: string,
  ): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.parse(uriString),
    );
    let findings: Finding<T>[];
    try {
      findings = await this.findingsFor(doc);
    } catch (e) {
      this.log(`command ${key}: analysis failed — ${(e as Error).message}`);
      void vscode.window.showErrorMessage(
        `${this.config.name}: analysis failed — see the ${this.config.name} Output channel.`,
      );
      return;
    }
    const finding = findings.find((f) => f.id === findingId);
    if (!finding) {
      this.log(`command ${key}: "${findingId}" is no longer present`);
      return;
    }

    const ctx: CommandContext<T> = {
      document: doc,
      session: this.sessionFor(doc),
      findings,
      log: (m) => this.log(m),
      info: (m) => void vscode.window.showInformationMessage(m),
      warn: (m) => void vscode.window.showWarningMessage(m),
      error: (m) => void vscode.window.showErrorMessage(m),
      applyEdits: (edits) => this.applyEdits(edits),
      refresh: async () => {
        this.cache.delete(doc.uri.fsPath);
        await this.refreshDocument(doc);
        await this.refreshPreviews(doc.uri.toString());
      },
    };

    try {
      await handler(finding, ctx);
    } catch (e) {
      this.log(`command ${key} threw: ${(e as Error).message}`);
      void vscode.window.showErrorMessage(
        `${this.config.name}: ${key} failed — ${(e as Error).message}`,
      );
    }
  }

  /**
   * Apply source edits as one undo step. Offsets are converted per file against
   * that file's document, so multi-file edits (codegen, a fix that touches an
   * imported module) work the same as single-file ones.
   */
  async applyEdits(edits: readonly SourceEdit[]): Promise<boolean> {
    if (edits.length === 0) return true;
    const workspaceEdit = new vscode.WorkspaceEdit();
    for (const edit of edits) {
      const uri = vscode.Uri.file(edit.file);
      const doc = await vscode.workspace.openTextDocument(uri);
      workspaceEdit.replace(
        uri,
        new vscode.Range(doc.positionAt(edit.start), doc.positionAt(edit.end)),
        edit.text,
      );
    }
    const applied = await vscode.workspace.applyEdit(workspaceEdit);
    this.log(`applied ${edits.length} edit(s): ${applied ? "ok" : "REJECTED"}`);
    return applied;
  }

  /* ------------------------------ preview ---------------------------- */

  /** Locate a bundled asset, requiring it to be *readable* — not merely present. */
  private assetPath(candidates: string[]): string | undefined {
    for (const rel of candidates) {
      const p = path.join(this.ctx.extensionPath, rel);
      try {
        const stat = fs.statSync(p);
        // existsSync() is true for a file we cannot open; that distinction is
        // the whole bug this logging exists to expose.
        fs.accessSync(p, fs.constants.R_OK);
        this.log(
          `  asset OK: ${p} (${stat.size} bytes, mode ${(stat.mode & 0o777).toString(8)})`,
        );
        return p;
      } catch (e) {
        this.log(
          `  asset unusable: ${p} — ${fs.existsSync(p) ? "exists but unreadable" : "not found"} (${(e as Error).message})`,
        );
      }
    }
    return undefined;
  }

  async openPreview(uriString: string, findingId: string): Promise<void> {
    const config = this.config.preview;
    if (!config) return;
    this.log(`preview requested: ${findingId} in ${uriString}`);

    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.parse(uriString),
    );

    let findings: Finding<T>[];
    try {
      findings = await this.findingsFor(doc);
      this.log(`  ${findings.length} finding(s): ${findings.map((f) => f.id).join(", ") || "<none>"}`);
    } catch (e) {
      this.log(`  ANALYSIS FAILED: ${(e as Error).message}`);
      void vscode.window.showErrorMessage(
        `${this.config.name}: could not analyze "${findingId}" — see the ${this.config.name} Output channel.`,
      );
      return;
    }

    const finding = findings.find((f) => f.id === findingId);
    if (!finding) {
      this.log(`  "${findingId}" not found`);
      void vscode.window.showWarningMessage(
        `${this.config.name}: "${findingId}" not found.`,
      );
      return;
    }

    const code = config.codeOf(finding);
    if (code === undefined) {
      this.log(`  "${findingId}" has nothing to preview`);
      return;
    }

    const assetPath = this.assetPath(config.assets);
    if (!assetPath) {
      this.log("  ABORT: no readable renderer asset");
      void vscode.window.showErrorMessage(
        `${this.config.name}: the renderer asset is missing or unreadable — re-run the build. See the ${this.config.name} Output channel.`,
      );
      return;
    }

    const target = this.track(doc, { diagnostics: false });
    let entry = target.previews.get(findingId);
    let panel = entry?.panel;
    if (panel) {
      // Every panel owns its own renderer bundle, so a panel is a genuinely
      // expensive object: reuse it rather than stacking duplicates.
      this.log("  reusing existing panel");
      panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Beside, true);
    } else {
      this.log("  creating new panel");
      panel = vscode.window.createWebviewPanel(
        `${this.config.id}.preview`,
        config.title?.(finding) ?? finding.label ?? finding.id,
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          localResourceRoots: [vscode.Uri.file(path.dirname(assetPath))],
        },
      );
      panel.onDidDispose(() => {
        this.log(`preview closed: ${findingId}`);
        target.previews.delete(findingId);
        if (target.previews.size === 0 && !target.diagnostics)
          this.dropTarget(uriString);
      });
      // The webview reports its own progress and failures back over this channel.
      panel.webview.onDidReceiveMessage((m) => {
        if (m?.type === "log") this.log(`  [webview] ${m.message}`);
      });
      entry = { panel, code };
      target.previews.set(findingId, entry);
    }
    entry!.code = code;

    const scriptUri = panel.webview
      .asWebviewUri(vscode.Uri.file(assetPath))
      .toString();
    this.log(`  script URI: ${scriptUri}`);
    this.log(`  cspSource: ${panel.webview.cspSource}`);

    // Assigning html reloads the webview, so a reused panel picks up edits made
    // since it was opened. (Later updates are pushed as messages instead.)
    panel.webview.html = previewHtml({
      webview: panel.webview,
      scriptUris: [scriptUri],
      bootstrap: config.bootstrap,
      code,
      missingAssetMessage: config.missingAssetMessage,
    });
  }

  /* --------------------------- live updates -------------------------- */

  /** Register (or refresh) a document as something to keep analyzed. */
  private track(
    doc: vscode.TextDocument,
    { diagnostics }: { diagnostics: boolean },
  ): Target {
    const uriString = doc.uri.toString();
    let target = this.targets.get(uriString);
    if (!target) {
      target = {
        uriString,
        deps: new Set(),
        previews: new Map(),
        diagnostics,
      };
      this.targets.set(uriString, target);
    }
    if (diagnostics) target.diagnostics = true;
    target.deps = this.dependenciesOf(this.sessionFor(doc), doc.uri.fsPath);
    this.startWatcher();
    return target;
  }

  private dropTarget(uriString: string): void {
    this.targets.delete(uriString);
    // Nothing to watch for once the last target is gone.
    if (this.targets.size === 0 && this.fsWatcher) {
      this.fsWatcher.dispose();
      this.fsWatcher = undefined;
      this.log("live: file watcher stopped");
    }
  }

  private startWatcher(): void {
    if (this.fsWatcher) return;
    // Catches on-disk edits: external tools, or files with no editor open.
    this.fsWatcher = vscode.workspace.createFileSystemWatcher(
      this.config.preview?.watch ?? "**/*.{ts,tsx}",
    );
    const onFs = (uri: vscode.Uri) => this.noteSourceChanged(uri.fsPath);
    this.fsWatcher.onDidChange(onFs);
    this.fsWatcher.onDidCreate(onFs);
    this.fsWatcher.onDidDelete(onFs);
    this.log("live: file watcher started");
  }

  /** The document plus its transitive imports, limited to files a user edits. */
  private dependenciesOf(
    session: DslSessionLike<T>,
    fsPath: string,
  ): Set<string> {
    try {
      return new Set(
        session
          .dependencies(fsPath)
          .filter((f) => !f.includes("node_modules"))
          .map(normalizePath),
      );
    } catch (e) {
      this.log(
        `live: dependency scan failed for ${fsPath} — ${(e as Error).message}`,
      );
      return new Set([normalizePath(fsPath)]);
    }
  }

  private noteSourceChanged(rawPath: string): void {
    const fsPath = normalizePath(rawPath);
    const watched = [...this.targets.values()].some((t) => t.deps.has(fsPath));
    if (!watched) return;

    this.changedFiles.add(fsPath);
    // Coalesce the burst of events a single keystroke produces.
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refreshAffected();
    }, this.config.debounceMs ?? 250);
  }

  private async refreshAffected(): Promise<void> {
    const files = [...this.changedFiles];
    this.changedFiles.clear();
    for (const target of [...this.targets.values()]) {
      if (!files.some((f) => target.deps.has(f))) continue;
      await this.refreshTarget(target, files);
    }
  }

  /** Push a file's newest content into the session; an open buffer beats disk. */
  private syncIntoSession(session: DslSessionLike<T>, fsPath: string): void {
    const open = vscode.workspace.textDocuments.find(
      (d) => d.uri.fsPath === fsPath,
    );
    try {
      session.updateFile(
        fsPath,
        open ? open.getText() : fs.readFileSync(fsPath, "utf8"),
      );
    } catch (e) {
      // A deleted or unreadable dependency just means this pass can't improve on
      // what's already displayed.
      this.log(`live: could not read ${fsPath} — ${(e as Error).message}`);
    }
  }

  private async refreshTarget(
    target: Target,
    changed: string[],
  ): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.parse(target.uriString),
    );
    const session = this.sessionFor(doc);
    for (const file of changed) this.syncIntoSession(session, file);

    // A dependency edit doesn't bump the document's version, so the
    // version-keyed cache would happily serve stale findings.
    this.cache.delete(doc.uri.fsPath);

    if (target.diagnostics) await this.refreshDiagnostics(doc);
    await this.refreshPreviews(target.uriString);

    // An edit can add or remove an import, so re-derive what to watch.
    target.deps = this.dependenciesOf(session, doc.uri.fsPath);
  }

  private async refreshPreviews(uriString: string): Promise<void> {
    const target = this.targets.get(uriString);
    const config = this.config.preview;
    if (!target || !config || target.previews.size === 0) return;

    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.parse(uriString),
    );

    let findings: Finding<T>[];
    try {
      findings = await this.findingsFor(doc);
    } catch (e) {
      // Keep the last good artifact on screen rather than flashing an error at
      // every keystroke.
      this.log(`live: analysis failed for ${uriString} — ${(e as Error).message}`);
      return;
    }

    for (const [findingId, entry] of target.previews) {
      const finding = findings.find((f) => f.id === findingId);
      if (!finding) {
        this.log(`live: "${findingId}" is no longer present`);
        continue;
      }
      const code = config.codeOf(finding);
      if (code === undefined || code === entry.code) continue; // no change
      entry.code = code;
      this.log(`live: re-rendering ${findingId}`);
      void entry.panel.webview.postMessage({ type: "render", code });
    }
  }

  /* ------------------------------ teardown --------------------------- */

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.fsWatcher?.dispose();
    this.fsWatcher = undefined;
    for (const target of this.targets.values())
      for (const { panel } of target.previews.values()) panel.dispose();
    this.targets.clear();
    this.sessions.clear();
    this.cache.clear();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

/** Wire up a DSL extension. Call from your `activate`. */
export function activateDslExtension<T>(
  ctx: vscode.ExtensionContext,
  config: DslExtensionConfig<T>,
): DslExtension<T> {
  return new DslExtension(ctx, config);
}
