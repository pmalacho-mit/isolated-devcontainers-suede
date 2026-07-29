/**
 * The preview webview's host page.
 *
 * Everything here is domain-agnostic: CSP, the pan/zoom viewport, editor
 * theming, the error pane, the log bridge back to the extension, and the
 * live-render message loop. The only domain-specific part is the renderer
 * itself, supplied as `PreviewRenderer`.
 */

/**
 * Contract the injected `bootstrap` script must fulfil: define a global
 * `DslRenderer` with these two methods.
 *
 *   globalThis.DslRenderer = {
 *     init(dark) { mylib.configure({ theme: dark ? "dark" : "light" }); },
 *     render(code, seq) { return mylib.toSvg(code); },
 *   };
 *
 * `render` returns (or resolves to) an HTML string mounted into the canvas.
 * SVG output gets sized from its `viewBox`; anything else from its bounding box.
 */
export interface PreviewRenderer {
  init(dark: boolean): void;
  render(code: string, seq: number): string | Promise<string>;
}

export interface PreviewHtmlOptions {
  /** Only `cspSource` is needed, so tests can pass a stub instead of a Webview. */
  webview: { cspSource: string };
  /** Webview-safe URIs for local scripts, loaded in order before `bootstrap`. */
  scriptUris: string[];
  /** JS source that defines `globalThis.DslRenderer`. */
  bootstrap: string;
  /** The artifact to render. */
  code: string;
  /** Shown when the renderer scripts fail to load. */
  missingAssetMessage?: string;
}

const nonce = (): string => {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++)
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
};

/**
 * Exported so the render can be exercised headlessly (jsdom, Playwright) with a
 * `{ cspSource }` stub — no VSCode instance required.
 */
export function previewHtml({
  webview,
  scriptUris,
  bootstrap,
  code,
  missingAssetMessage = "Failed to load the renderer asset.\nThe webview could not fetch it — re-run the build and reinstall.",
}: PreviewHtmlOptions): string {
  const n = nonce();
  const scripts = scriptUris
    .map(
      (uri) =>
        `<script nonce="${n}" src="${uri}" onerror="window.__dslScriptFailed = true"></script>`,
    )
    .join("\n  ");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${n}';">
  <style>
    html, body { height: 100%; margin: 0; }
    body {
      display: flex;
      flex-direction: column;
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    #toolbar {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.35rem 0.5rem;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
    }
    #toolbar button {
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, inherit);
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
      border-radius: 4px;
      padding: 0.15rem 0.5rem;
      min-width: 1.9rem;
      cursor: pointer;
      font: inherit;
      line-height: 1.4;
    }
    #toolbar button:hover {
      background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.2));
    }
    #zoom-level {
      min-width: 3.4rem;
      text-align: center;
      opacity: 0.85;
      font-variant-numeric: tabular-nums;
    }
    #hint { margin-left: auto; opacity: 0.6; font-size: 0.85em; }
    /* The viewport clips; #canvas is what actually moves and scales. */
    #viewport { flex: 1 1 auto; position: relative; overflow: hidden; cursor: grab; }
    #viewport.panning { cursor: grabbing; }
    #canvas { position: absolute; top: 0; left: 0; transform-origin: 0 0; will-change: transform; }
    #error {
      margin: 1rem;
      white-space: pre-wrap;
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--vscode-errorForeground);
      border: 1px solid var(--vscode-errorForeground);
      border-radius: 4px;
      padding: 1rem;
    }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <div id="toolbar" hidden>
    <button id="zoom-out" title="Zoom out">&#8722;</button>
    <span id="zoom-level">100%</span>
    <button id="zoom-in" title="Zoom in">+</button>
    <button id="fit" title="Fit to window">Fit</button>
    <button id="reset" title="Actual size">1:1</button>
    <span id="hint">drag to pan &middot; scroll to move &middot; ctrl/&#8984; + scroll to zoom</span>
  </div>
  <div id="viewport" hidden><div id="canvas"></div></div>
  <div id="error" hidden></div>
  ${scripts}
  <script nonce="${n}">
${bootstrap}
  </script>
  <script nonce="${n}">
    (function () {
      // Mirror progress to the extension's Output channel; the webview console is
      // otherwise only reachable through the webview developer tools.
      let post = function () {};
      try {
        const api = acquireVsCodeApi();
        post = (message) => api.postMessage({ type: "log", message });
      } catch (e) { /* no webview host (headless harness) */ }

      window.addEventListener("error", (e) =>
        post("window.onerror: " + e.message + " @ " + (e.filename || "?") + ":" + e.lineno));
      window.addEventListener("securitypolicyviolation", (e) =>
        post("CSP VIOLATION: blocked=" + e.blockedURI + " directive=" + e.violatedDirective));

      const errorEl = document.getElementById("error");
      const toolbar = document.getElementById("toolbar");
      const viewport = document.getElementById("viewport");
      const canvas = document.getElementById("canvas");
      const zoomLevel = document.getElementById("zoom-level");

      function fail(message) {
        post("FAILED: " + message);
        errorEl.hidden = false;
        errorEl.textContent = message;
      }

      const renderer = globalThis.DslRenderer;
      post("webview script running; renderer=" + typeof renderer +
           "; scriptLoadFailed=" + !!window.__dslScriptFailed);

      // A missing bundle previously left raw source on screen, which reads as a
      // rendering bug rather than an asset that never loaded.
      if (!renderer || typeof renderer.render !== "function") {
        fail(${JSON.stringify(missingAssetMessage)});
        return;
      }

      /* ------------------------- pan / zoom ------------------------- */

      const MIN_SCALE = 0.1, MAX_SCALE = 8;
      let scale = 1, tx = 0, ty = 0;
      let natW = 0, natH = 0;
      // Once the view is deliberately positioned, a resize must not yank it back.
      let userAdjusted = false;

      const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

      function apply() {
        canvas.style.transform =
          "translate(" + tx + "px," + ty + "px) scale(" + scale + ")";
        zoomLevel.textContent = Math.round(scale * 100) + "%";
      }

      // Keep the point under the cursor fixed while the scale changes.
      function zoomAt(cx, cy, factor) {
        const next = clamp(scale * factor, MIN_SCALE, MAX_SCALE);
        if (next === scale) return;
        tx = cx - (cx - tx) * (next / scale);
        ty = cy - (cy - ty) * (next / scale);
        scale = next;
        userAdjusted = true;
        apply();
      }

      function centerAt(s) {
        const r = viewport.getBoundingClientRect();
        scale = clamp(s, MIN_SCALE, MAX_SCALE);
        tx = (r.width - natW * scale) / 2;
        ty = (r.height - natH * scale) / 2;
        apply();
      }

      function fit() {
        const r = viewport.getBoundingClientRect();
        const pad = 24;
        // Never scale small content up past 1:1 just to fill the panel.
        const s = Math.min((r.width - pad * 2) / natW, (r.height - pad * 2) / natH, 1);
        centerAt(s);
        userAdjusted = false;
      }

      function mount(html, preserveView) {
        const hadContent = natW > 0;
        canvas.innerHTML = html;
        const svg = canvas.querySelector("svg");
        if (svg) {
          // Renderers commonly emit width=100% + an inline max-width, which
          // fights a scale transform. Pin the SVG to its intrinsic viewBox size.
          const vb = svg.viewBox && svg.viewBox.baseVal;
          natW = (vb && vb.width) || svg.getBoundingClientRect().width || 800;
          natH = (vb && vb.height) || svg.getBoundingClientRect().height || 600;
          svg.removeAttribute("width");
          svg.removeAttribute("height");
          svg.style.maxWidth = "none";
          svg.style.width = natW + "px";
          svg.style.height = natH + "px";
          svg.style.display = "block";
        } else {
          const r = canvas.getBoundingClientRect();
          natW = r.width || 800;
          natH = r.height || 600;
        }
        toolbar.hidden = false;
        viewport.hidden = false;
        // A live re-render must not yank a deliberately positioned view back to
        // fit; only an untouched view (or a first render) re-fits.
        if (preserveView && hadContent && userAdjusted) apply();
        else fit();
      }

      document.getElementById("zoom-in").addEventListener("click", () => {
        const r = viewport.getBoundingClientRect();
        zoomAt(r.width / 2, r.height / 2, 1.25);
      });
      document.getElementById("zoom-out").addEventListener("click", () => {
        const r = viewport.getBoundingClientRect();
        zoomAt(r.width / 2, r.height / 2, 1 / 1.25);
      });
      document.getElementById("fit").addEventListener("click", fit);
      document.getElementById("reset").addEventListener("click", () => {
        centerAt(1);
        userAdjusted = true;
      });

      viewport.addEventListener("wheel", (e) => {
        e.preventDefault();
        const r = viewport.getBoundingClientRect();
        if (e.ctrlKey || e.metaKey) {
          zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.1 : 1 / 1.1);
        } else {
          tx -= e.deltaX;
          ty -= e.deltaY;
          userAdjusted = true;
          apply();
        }
      }, { passive: false });

      let panning = false, startX = 0, startY = 0;
      viewport.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        panning = true;
        startX = e.clientX - tx;
        startY = e.clientY - ty;
        viewport.classList.add("panning");
        try { viewport.setPointerCapture(e.pointerId); } catch (_) {}
      });
      viewport.addEventListener("pointermove", (e) => {
        if (!panning) return;
        tx = e.clientX - startX;
        ty = e.clientY - startY;
        userAdjusted = true;
        apply();
      });
      function endPan(e) {
        if (!panning) return;
        panning = false;
        viewport.classList.remove("panning");
        try { viewport.releasePointerCapture(e.pointerId); } catch (_) {}
      }
      viewport.addEventListener("pointerup", endPan);
      viewport.addEventListener("pointercancel", endPan);

      window.addEventListener("resize", () => {
        if (natW && !userAdjusted) fit();
      });

      /* --------------------------- render --------------------------- */

      const dark =
        document.body.classList.contains("vscode-dark") ||
        document.body.classList.contains("vscode-high-contrast");

      try {
        if (typeof renderer.init === "function") renderer.init(dark);
        post("initialized (theme=" + (dark ? "dark" : "light") + "); rendering...");
      } catch (e) {
        fail("renderer.init threw: " + ((e && e.message) || e));
        return;
      }

      // Renderers commonly key internal state off a render id, so each pass gets
      // a fresh sequence number.
      let renderSeq = 0;
      function renderContent(code, preserveView) {
        renderSeq += 1;
        Promise.resolve()
          .then(() => renderer.render(code, renderSeq))
          .then((html) => {
            errorEl.hidden = true;
            mount(html, preserveView);
            post("render OK (" + String(html).length + " chars, " +
                 Math.round(natW) + "x" + Math.round(natH) + " natural)");
          })
          .catch((e) => fail("renderer.render rejected: " + ((e && e.message) || e)));
      }

      // Live updates: the extension re-compiles whenever a source file behind
      // this preview changes and pushes the new artifact in. Re-rendering in
      // place beats reassigning the panel's html, which would reload the whole
      // renderer bundle and throw away the viewer's pan/zoom.
      window.addEventListener("message", (event) => {
        const m = event.data;
        if (m && m.type === "render") renderContent(m.code, true);
      });

      renderContent(${JSON.stringify(code)}, false);
    })();
  </script>
</body>
</html>`;
}
