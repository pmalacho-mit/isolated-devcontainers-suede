// The approval page's script. Everything it puts on the page is text (textContent), never
// markup: a commit's subject or a file's name is whatever an agent wrote.
//
// Arming. The Approve button takes a click only when (1) the page has been visible and
// focused for a second, (2) the card has been on the page, unchanged, for a second, (3) the
// pointer has then MOVED over the button (a card shifted under a still pointer arms
// nothing), and (4) a third of a second has passed since. Any change to the page (a card
// added, gone, or its summary arriving) disarms every button. Keys do not approve.
//
// Embedded beside the git terminal (/embed, approve-web.ts): the key from the address's
// fragment is the credential (sent as a header), the pointer over the frame counts as
// attention (the terminal keeps the focus until a click), and where the browser can tell
// (IntersectionObserver v2) a button arms only while it is visibly unobscured.
"use strict";
// Embedded only if it is a frame: the page at /embed opened as a window is not.
const EMBED = location.pathname === "/embed" && window.top !== window;
const embedKey = EMBED ? (/^#k=([0-9a-f]{64})$/.exec(location.hash) || [])[1] || "" : "";
if (EMBED) {
  history.replaceState(null, "", "/embed");
  document.documentElement.classList.add("embed");
}
const credential = embedKey ? { "x-desolate-embed": embedKey } : {};
// In the frame the key alone signs in: the cookie, if this browser has one, stays out.
const sendCookie = EMBED ? "omit" : "same-origin";
const VISIBILITY = EMBED && "IntersectionObserver" in window && "isVisible" in IntersectionObserverEntry.prototype;
let pointerInside = false;
const READY_MS = 1000;
const DWELL_MS = 300;
const list = document.getElementById("list");
const status = document.getElementById("status");
const template = document.getElementById("card");
const cards = new Map(); // the push's token (over its exact text) -> card

const attending = () => document.visibilityState === "visible" && (document.hasFocus() || (EMBED && pointerInside));
let attentiveSince = attending() ? performance.now() : 0;
// Losing attention disarms. Gaining it does not (a page that just got it cannot arm for a
// second anyway), and must not: in a frame, the click on Approve is also what focuses it.
const attention = () => {
  const now = attending();
  if (!now) {
    attentiveSince = 0;
    disarmAll();
  } else if (attentiveSince === 0) attentiveSince = performance.now();
};
document.addEventListener("visibilitychange", attention);
window.addEventListener("focus", attention);
window.addEventListener("blur", attention);
if (EMBED) {
  document.documentElement.addEventListener("pointerenter", () => { pointerInside = true; attention(); });
  document.documentElement.addEventListener("pointerleave", () => { pointerInside = false; attention(); });
}
// Each card's Approve, as the browser sees it: drawn, whole, and under nothing.
const watcher = VISIBILITY ? new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const card = [...cards.values()].find((c) => c.wrap === entry.target);
    if (!card) continue;
    card.visible = entry.isVisible && entry.intersectionRatio >= 0.99;
    if (!card.visible) disarm(card);
  }
}, { threshold: [0, 1], trackVisibility: true, delay: 100 }) : null;

const say = (text) => { status.textContent = text; };
const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };

const ready = (card) => attentiveSince !== 0 && performance.now() - attentiveSince >= READY_MS && performance.now() - card.changedAt >= READY_MS && card.visible !== false;
const disarm = (card) => {
  card.armedAt = 0;
  if (card.done) return;
  card.button.disabled = true;
  card.hint.textContent = ready(card) ? "move the pointer over Approve to arm it" : "arming in a moment...";
};
const disarmAll = () => { for (const card of cards.values()) disarm(card); };
setInterval(() => { for (const card of cards.values()) if (!card.armedAt && !card.done) disarm(card); }, 250);

const post = async (what, card) => {
  const answer = await fetch(`/${what}`, { method: "POST", headers: { "content-type": "application/json", ...credential }, body: JSON.stringify({ nonce: card.push.nonce, token: card.push.token, commit: card.push.commit }), credentials: sendCookie });
  const body = await answer.json().catch(() => ({}));
  if (!answer.ok) throw new Error(body.error || `HTTP ${answer.status}`);
};

// The diff, as text: each line a text node in a span classed by its first character.
// Characters that reorder or hide what is shown (bidi controls, zero-width ones): in a diff a
// person approves from, each is shown as itself, named, so the line reads as git stores it.
const unhidden = (line) => line.replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, (c) => `⟨U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}⟩`);
const diffView = (text) => {
  const pre = el("pre", undefined, "diff");
  for (const line of text.split("\n")) pre.append(el("span", unhidden(line) || " ", line.startsWith("diff --git") ? "file" : line.startsWith("@@") ? "hunk" : line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : ""));
  return pre;
};
/** "Show the diff": asked of the host once, for the very text the card shows (its token).
 *  Opening it changes the card, so Approve disarms and arms again only as it always does. */
const diffToggle = (card) => {
  const box = el("div", undefined, "diffbox");
  const button = el("button", "Show the diff", "quiet");
  button.type = "button";
  let open = false;
  button.addEventListener("click", async (event) => {
    if (!event.isTrusted) return;
    open = !open;
    button.textContent = open ? "Hide the diff" : "Show the diff";
    if (!open) box.replaceChildren();
    else {
      box.replaceChildren(el("p", "asking desolate's reviewer...", "hint"));
      try {
        const answer = await fetch(`/diff?nonce=${card.push.nonce}&token=${card.push.token}`, { credentials: sendCookie, headers: credential });
        const body = await answer.json();
        if (!answer.ok) throw new Error(body.error || `HTTP ${answer.status}`);
        box.replaceChildren(...(body.diff === null ? [el("p", "Too large to show here (over 20 000 lines): read it with git in the git terminal.", "error")] : [diffView(body.diff), ...(body.cut ? [el("p", "Cut at 256 KiB: read the rest with git in the git terminal.", "error")] : [])]));
      } catch (error) {
        box.replaceChildren(el("p", `the diff could not be had: ${error.message}`, "error"));
      }
    }
    card.changedAt = performance.now();
    disarm(card);
  });
  return [button, box];
};

const summaryOf = (summary, card) => {
  const box = document.createDocumentFragment();
  if (!summary || !summary.ok) {
    box.append(el("p", summary && summary.waiting ? "desolate's reviewer is working out what this push would send..." : `desolate's reviewer could not say what this push would send: ${summary && summary.error ? summary.error : "no answer"}. Approve only if you know what it is.`, summary && summary.waiting ? "" : "error"));
    return box;
  }
  for (const warning of summary.warnings || []) box.append(el("p", `Warning: ${warning}`, "error"));
  if (summary.fastForward === false) box.append(el("p", "This does not build on the remote's branch: it REPLACES it, and the commits only the remote has are dropped from the branch.", "error"));
  const commits = summary.commits || [];
  const total = commits.length + (summary.more || 0);
  box.append(el("p", total ? `${total} commit(s) the remote does not have:` : "No commit the remote does not have already."));
  const ul = el("ul");
  for (const c of commits) { const li = el("li"); li.append(el("code", c.commit.slice(0, 12)), document.createTextNode(` ${c.subject}  (${c.author})`)); ul.append(li); }
  if (summary.more) ul.append(el("li", `and ${summary.more} more`));
  if (commits.length) box.append(ul);
  const files = summary.files || [];
  if (files.length) {
    box.append(el("p", `${files.length + (summary.moreFiles || 0)} file(s) changed${summary.base ? ` against ${summary.base.slice(0, 12)}` : ""}${summary.lfs ? `, ${summary.lfs} of them LFS objects` : ""}:`));
    const fl = el("ul");
    for (const f of files) {
      const li = el("li", undefined, f.sensitive ? "sensitive" : "");
      li.append(el("code", f.path), document.createTextNode(f.binary ? "  (binary)" : `  +${f.added} -${f.removed}`));
      if (f.sensitive) li.append(document.createTextNode("  (runs on the forge, or changes how git treats the repository)"));
      fl.append(li);
    }
    if (summary.moreFiles) fl.append(el("li", `and ${summary.moreFiles} more (every one that runs on the forge is listed above)`));
    box.append(fl);
  }
  if (summary.hasDiff !== undefined && card) box.append(...diffToggle(card));
  return box;
};

const add = (push) => {
  const element = template.content.firstElementChild.cloneNode(true);
  element.querySelector(".repo").textContent = push.repo;
  element.querySelector(".branch").textContent = push.branch;
  element.querySelector(".commit").textContent = push.commit;
  element.querySelector(".onto").textContent = push.onto ? `The remote's ${push.branch} moves from ${push.onto} to this commit, or not at all.` : `The remote has no ${push.branch}: this creates it.`;
  const wrap = element.querySelector(".arm");
  const card = { element, push, wrap, visible: VISIBILITY ? false : undefined, button: element.querySelector(".approve"), hint: element.querySelector(".hint"), summary: element.querySelector(".summary"), changedAt: performance.now(), armedAt: 0, done: false, busy: false, shown: "" };
  if (watcher) watcher.observe(wrap);
  // (A disabled button gets no pointer events in every browser: these are on its wrapper,
  // and the button lets them through while disabled: approve.css.)
  wrap.addEventListener("pointermove", (event) => {
    if (card.done || card.busy || card.armedAt || !ready(card)) return;
    if (event.movementX === 0 && event.movementY === 0) return;
    card.armedAt = performance.now();
    card.button.disabled = false;
    card.hint.textContent = "";
  });
  wrap.addEventListener("pointerleave", () => disarm(card));
  card.button.addEventListener("click", async (event) => {
    // A real pointer's click, on a button armed a moment ago: not a key, not a script.
    if (!event.isTrusted || event.detail === 0 || !card.armedAt || performance.now() - card.armedAt < DWELL_MS || card.busy || card.done) return;
    card.busy = true;
    card.button.disabled = true;
    card.hint.textContent = "approving...";
    try { await post("approve", card); card.done = true; card.hint.textContent = "approved: the push continues in the root"; }
    catch (error) { card.hint.textContent = `not approved: ${error.message}`; }
    finally { card.busy = false; disarm(card); }
  });
  element.querySelector(".refuse").addEventListener("click", async (event) => {
    if (!event.isTrusted || card.busy || card.done) return;
    card.busy = true;
    try { await post("refuse", card); card.done = true; card.button.disabled = true; card.hint.textContent = "refused: the push that asked gives up"; }
    catch (error) { card.hint.textContent = error.message; }
    finally { card.busy = false; }
  });
  disarm(card);
  return card;
};

const render = (pending) => {
  let changed = false;
  const seen = new Set();
  for (const push of pending) {
    seen.add(push.token);
    let card = cards.get(push.token);
    if (!card) {
      card = add(push);
      cards.set(push.token, card);
      list.append(card.element);
      changed = true;
    }
    const shown = JSON.stringify(push.summary);
    if (shown !== card.shown) {
      card.shown = shown;
      card.summary.replaceChildren(summaryOf(push.summary, card));
      card.changedAt = performance.now();
      changed = true;
    }
  }
  // A push no longer waiting keeps its place (nothing shifts under the pointer), marked.
  for (const card of cards.values())
    if (!seen.has(card.push.token) && !card.gone) {
      card.gone = true;
      if (!card.done) { card.done = true; card.button.disabled = true; card.hint.textContent = "no longer waiting (approved elsewhere, refused, or its two minutes ran out)"; }
      card.element.classList.add("gone");
      changed = true;
    }
  if (changed) disarmAll();
  const waiting = [...cards.values()].filter((card) => !card.gone).length;
  document.title = waiting ? `(${waiting}) desolate: pushes waiting` : "desolate: no pushes waiting";
  // Beside the git terminal: how many wait, so its page shows this frame when one does.
  // (A number, to that one origin.)
  if (EMBED && window.parent !== window) window.parent.postMessage({ desolatePending: waiting }, location.origin.replace("//desolate-approve.", "//desolate-git."));
  say(waiting ? "" : "Nothing is waiting. This page checks every second.");
};

const poll = async () => {
  try {
    const answer = await fetch("/pending", { credentials: sendCookie, headers: credential });
    const body = await answer.json();
    if (!answer.ok) say(body.error || `HTTP ${answer.status}`);
    else render(body.pending);
  } catch (error) { say(`the host daemon did not answer: ${error.message}`); }
  setTimeout(poll, 1000);
};
poll();
