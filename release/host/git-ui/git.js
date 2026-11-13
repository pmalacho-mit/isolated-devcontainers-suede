// The git terminal: a bash in the git VM (host/git-web.ts). What it draws is the terminal's
// output, which can hold whatever a file or a commit holds: links do nothing, the title is
// not touched, and there is no clipboard addon (xterm.js itself does not write the
// clipboard).
"use strict";
const status = document.getElementById("status");
const repo = new URLSearchParams(location.search).get("repo") || "";
document.getElementById("where").textContent = repo ? `/git/${repo}` : "/git";
const term = new Terminal({
  cursorBlink: true, scrollback: 5000, allowProposedApi: false, macOptionIsMeta: true,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13,
  linkHandler: { activate: () => {}, allowNonHttpProtocols: false },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("terminal"));
fit.fit();

const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
const b64 = (bytes) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

const start = async () => {
  status.textContent = "starting...";
  const answer = await post("/session", { repo });
  const body = await answer.json().catch(() => ({}));
  if (!answer.ok) { status.textContent = body.error || `HTTP ${answer.status}`; return; }
  const { id, token } = body;
  const encoder = new TextEncoder();
  let queue = Promise.resolve();
  const send = (bytes) => { queue = queue.then(() => post(`/session/${id}/input`, { token, data: b64(bytes) })).catch(() => {}); };
  term.onData((data) => send(encoder.encode(data)));
  term.onBinary((data) => send(Uint8Array.from(data, (c) => c.charCodeAt(0) & 255)));
  const resize = () => { fit.fit(); post(`/session/${id}/resize`, { token, cols: term.cols, rows: term.rows }).catch(() => {}); };
  window.addEventListener("resize", resize);
  const stream = new EventSource(`/session/${id}/stream?token=${token}`);
  stream.onopen = () => { status.textContent = ""; resize(); term.focus(); };
  stream.onmessage = (event) => term.write(unb64(event.data));
  stream.addEventListener("end", () => { status.textContent = "the shell ended: reload for another"; stream.close(); });
  // No reconnecting by itself: a reconnect would replay what the shell printed.
  stream.onerror = () => { stream.close(); status.textContent = "disconnected: reload for another shell"; };
};
start();

// Pushes waiting for approval, beside the terminal: the approval page itself (its /embed),
// in a frame of its own origin. This page gives it its address and learns from it how many
// wait (a number, from that origin only); it opens when one does, and the button keeps it
// open or closed after that.
const aside = document.getElementById("approvals");
const toggle = document.getElementById("toggle");
const APPROVE_ORIGIN = location.origin.replace("//desolate-git.", "//desolate-approve.");
let chosen = null; // the person's choice, once made: true open, false closed
const show = (open) => {
  if (aside.hidden === !open) return;
  aside.hidden = !open;
  window.dispatchEvent(new Event("resize"));
};
toggle.addEventListener("click", () => { chosen = aside.hidden; show(chosen); });
window.addEventListener("message", (event) => {
  if (event.origin !== APPROVE_ORIGIN || !event.data || typeof event.data.desolatePending !== "number") return;
  const waiting = Math.max(0, Math.floor(event.data.desolatePending));
  toggle.textContent = waiting ? `Approvals (${waiting})` : "Approvals";
  toggle.classList.toggle("waiting", waiting > 0);
  if (waiting > 0 && chosen !== false) show(true);
  if (waiting === 0 && chosen === null) show(false);
});
fetch("/approvals-frame", { credentials: "same-origin" }).then((answer) => answer.ok ? answer.json() : null).then((body) => {
  if (!body || typeof body.url !== "string" || !body.url.startsWith(`${APPROVE_ORIGIN}/embed#`)) return;
  document.getElementById("frame").src = body.url;
  toggle.hidden = false;
}).catch(() => {});
