// desolate's dashboard (section 4.8). It draws from the state service's stream: nothing is
// fetched to paint, and nothing a repository wrote is ever set as HTML (everything goes
// through textContent).
"use strict";
let state = null;
let reviewing = null;
const busy = new Set();

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "onclick") node.addEventListener("click", value);
    else if (key === "onsubmit") node.addEventListener("submit", value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
};
// A token in an address is for the link, never for the label.
const redact = (text) => String(text).replace(/tkn=[0-9a-f]+/g, "tkn=...");
const short = (commit) => String(commit).slice(0, 12);

const act = async (key, kind, args) => {
  busy.add(key);
  render();
  try {
    const response = await fetch("/action", { method: "POST", headers: { "content-type": "application/json", "x-desolate-ui": "1" }, body: JSON.stringify({ kind, args }) });
    if (!response.ok) alertLine((await response.json()).error || "the dashboard could not do that");
  } catch (error) {
    alertLine(String(error));
  } finally {
    setTimeout(() => { busy.delete(key); render(); }, 1500);
  }
};
let notice = "";
const alertLine = (text) => { notice = text; render(); setTimeout(() => { notice = ""; render(); }, 8000); };
const button = (label, key, kind, args, quiet = false) =>
  el("button", { class: quiet ? "quiet" : "", disabled: busy.has(key), "data-action": kind, onclick: () => act(key, kind, args) }, busy.has(key) ? `${label}...` : label);

const openReview = async (offer) => {
  reviewing = { offer, loading: true };
  render();
  try {
    const response = await fetch(`/review?domain=${encodeURIComponent(offer.domain)}&repo=${encodeURIComponent(offer.repo)}&branch=${encodeURIComponent(offer.branch)}`);
    reviewing = { offer, review: await response.json() };
  } catch (error) {
    reviewing = { offer, review: { error: String(error) } };
  }
  render();
};

const needsYou = () => {
  const items = [];
  for (const a of state.approvals) items.push(el("li", {}, el("span", { class: "dot orange" }), el("div", { class: "what" },
    el("div", { class: "name" }, `A push is waiting for your approval: ${a.repo} ${a.branch}`),
    el("div", { class: "line mono" }, `${a.commit}`),
    el("div", { class: "line" }, "Approve it on the host, outside every VM: run ", el("code", {}, "desolate approve"), " in a terminal there (Touch ID on a Mac).")), el("div", {})));
  for (const o of state.offers) {
    const key = `push:${o.domain}:${o.repo}:${o.branch}`;
    items.push(el("li", { "data-offer": `${o.domain}/${o.repo}/${o.branch}` }, el("span", { class: "dot blue" }), el("div", { class: "what" },
      el("div", { class: "name" }, `Offered: ${o.repo} ${o.branch}`),
      el("div", { class: "line" }, `from ${o.domain}/${o.workspace}, at `, el("span", { class: "mono" }, short(o.commit)), o.lfs ? `, with ${o.lfs} LFS object(s)` : "")),
      el("div", { class: "buttons" }, el("button", { class: "quiet", onclick: () => openReview(o) }, "Review"))));
  }
  for (const d of state.domains) for (const w of d.workspaces) {
    const says = w.says.status;
    if (says && (says.color === "orange" || says.color === "red"))
      items.push(el("li", {}, el("span", { class: `dot ${says.color}` }), el("div", { class: "what" }, el("div", { class: "name" }, `${d.slug}/${w.workspace}`), el("div", { class: "line" }, says.message)), el("div", {})));
    if (w.host && w.host.devcontainer && /^FAILED/.test(w.host.devcontainer))
      items.push(el("li", {}, el("span", { class: "dot red" }), el("div", { class: "what" }, el("div", { class: "name" }, `${d.slug}/${w.workspace}: its devcontainer did not come up`), el("div", { class: "line" }, w.host.devcontainer)), el("div", {})));
  }
  return items;
};

const reviewPanel = () => {
  if (!reviewing) return null;
  const { offer, review, loading } = reviewing;
  const close = el("button", { class: "quiet", onclick: () => { reviewing = null; render(); } }, "Close");
  if (loading) return el("div", { class: "card" }, el("div", { class: "top" }, el("h3", {}, `Reviewing ${offer.repo} ${offer.branch}`), el("span", { class: "grow" }), close), el("div", { class: "sub" }, "reading what a push would send..."));
  if (review.error) return el("div", { class: "card" }, el("div", { class: "top" }, el("h3", {}, `${offer.repo} ${offer.branch}`), el("span", { class: "grow" }), close), el("div", { class: "warn" }, review.error));
  const key = `push:${offer.domain}:${offer.repo}:${offer.branch}`;
  return el("div", { class: "card", id: "review-card" },
    el("div", { class: "top" }, el("h3", {}, `${review.repo} ${review.branch}`), el("span", { class: "mono sub" }, review.commit), el("span", { class: "grow" }), close),
    el("div", { class: "sub" }, `A push would send ${review.commits.length} commit(s): ${review.stat || "no file changes"}${review.lfsObjects ? `, and ${review.lfsObjects} LFS object(s) first` : ""}.`),
    review.warnings.map((w) => el("div", { class: "warn" }, `Warning: this push ${w}`)),
    el("pre", { class: "mono" }, review.commits.slice(0, 40).map((c) => `${short(c.commit)}  ${c.subject}`).join("\n")),
    el("pre", { class: "mono" }, review.files.slice(0, 80).join("\n")),
    el("div", { class: "sub" }, "Read the diff itself in the root editor (Source Control), or in ", el("code", {}, "desolate root shell"), ": ", el("code", {}, `git -C /desolate/root/${review.repo} diff origin/HEAD...${offer.domain}/${review.branch}`)),
    el("div", { class: "buttons" }, !review.pushable ? el("span", { class: "sub" }, "Not pushable: cloned --no-push, so there is no write key for it.")
      : review.isDefault ? el("span", { class: "sub" }, "This is the default branch. Push it from the host: ", el("code", {}, `desolate push ${offer.domain} ${review.repo} ${review.branch} --expect ${review.commit} --allow-default`))
      : button(`Push exactly ${short(review.commit)}`, key, "offer.push", { domain: offer.domain, repo: review.repo, branch: review.branch, commit: review.commit })),
    el("div", { class: "sub" }, "Pushing asks for your approval on the host: run ", el("code", {}, "desolate approve"), " there when this says it is waiting."));
};

const workspaceRow = (d, w) => {
  const host = w.host || {};
  const running = host.status === "running";
  const says = w.says.status;
  const key = `ws:${d.slug}/${w.workspace}`;
  const target = { domain: d.slug, workspace: w.workspace };
  return el("li", { "data-workspace": `${d.slug}/${w.workspace}` },
    el("span", { class: `dot ${running ? (says ? says.color : "gray") : "hollow"}`, title: says ? says.color : running ? "no status set" : "stopped" }),
    el("div", { class: "what" },
      el("div", { class: "name" }, w.workspace, " ", el("span", { class: "sub" }, state.hostConnected ? (host.status || w.state) : `${w.state} (as last known)`)),
      el("div", { class: "line" }, w.checkouts.map((c) => `${c.repo}@${c.branch}`).join(", ")),
      says ? el("div", { class: "line", "data-says": "" }, says.message) : null,
      host.devcontainer ? el("div", { class: "line" }, `devcontainer: ${host.devcontainer}`) : null,
      (host.ports || []).length ? el("div", { class: "line" }, "dev servers: ", host.ports.map((p, i) => [i ? ", " : "", el("a", { href: p.url, target: "_blank", rel: "noopener" }, `:${p.port}`)])) : null),
    el("div", { class: "buttons" },
      running && host.editor ? el("a", { class: "button", href: host.editor, target: "_blank", rel: "noopener", "data-editor": "" }, "Open editor") : null,
      running ? button("Stop", key, "workspace.stop", target, true) : button("Start", key, "workspace.start", target)));
};

const domainCard = (d) => {
  const key = `up:${d.slug}`;
  const others = state.repos.filter((r) => !d.repos.includes(r.repo));
  return el("div", { class: "card", "data-domain": d.slug },
    el("div", { class: "top" }, el("h3", {}, d.title || d.slug), el("span", { class: "sub mono" }, d.slug),
      el("span", { class: "chip" }, d.net === "enforce" ? "network: listed hosts only" : "network: open"),
      d.secrets.map((s) => el("span", { class: `chip ${s.on ? "" : "off"}`, title: s.on ? "a secret this domain's workspaces may use by name" : "switched off" }, s.name))),
    el("div", { class: "sub" }, d.repos.length ? d.repos.join(", ") : "No repositories yet."),
    el("ul", { class: "rows" }, d.workspaces.map((w) => workspaceRow(d, w))),
    el("form", { class: "inline", onsubmit: (event) => { event.preventDefault(); const name = event.target.elements.name.value.trim(); act(key, "workspace.up", { domain: d.slug, workspace: name }); event.target.reset(); } },
      d.repos.length ? [el("input", { name: "name", placeholder: "name (optional)", pattern: "[a-z0-9][a-z0-9-]{0,39}", "aria-label": "workspace name" }), el("button", { disabled: busy.has(key) }, busy.has(key) ? "Starting..." : "New workspace")] : null),
    others.length ? el("form", { class: "inline", onsubmit: (event) => { event.preventDefault(); act(`add:${d.slug}`, "domain.add", { domain: d.slug, repo: event.target.elements.repo.value }); } },
      el("select", { name: "repo", "aria-label": "repository to add" }, others.map((r) => el("option", { value: r.repo }, r.repo))), el("button", { class: "quiet" }, "Add repository")) : null);
};

const firstRun = () => {
  const hasRepo = state.repos.length > 0, hasDomain = state.domains.length > 0;
  const hasBoth = state.domains.some((d) => d.repos.length > 0), hasWorkspace = state.domains.some((d) => d.workspaces.length > 0);
  if (hasWorkspace) return null;
  const firstDomain = state.domains[0];
  return el("div", { class: "card" }, el("h3", {}, "Getting started"), el("p", { class: "sub" }, "Each step shows the command it runs, so you can do the same from a terminal."),
    el("ol", { class: "steps" },
      el("li", { class: hasRepo ? "done" : "" }, "Clone a repository. Its deploy keys are made in the root VM; adding them at GitHub is yours to do, so this one starts on the host: ", el("code", {}, "desolate clone <owner>/<repo>"), hasRepo ? `  (have: ${state.repos.map((r) => r.repo).join(", ")})` : ""),
      el("li", { class: hasDomain ? "done" : "" }, "Create a domain: the trust boundary your workspaces share. ", el("code", {}, "desolate domain create <slug>"),
        !hasDomain && hasRepo ? el("form", { class: "inline", onsubmit: (event) => { event.preventDefault(); act("create", "domain.create", { domain: event.target.elements.slug.value.trim(), title: event.target.elements.title.value.trim() }); } },
          el("input", { name: "slug", placeholder: "slug, e.g. dev", required: true, pattern: "[a-z0-9][a-z0-9-]{0,39}" }), el("input", { name: "title", placeholder: "title (optional)" }), el("button", {}, "Create domain")) : null),
      el("li", { class: hasBoth ? "done" : "" }, "Give it a repository. ", el("code", {}, `desolate domain ${firstDomain ? firstDomain.slug : "<slug>"} add --repo <owner>/<repo>`), hasDomain && !hasBoth ? " (use Add repository on its card below)" : ""),
      el("li", {}, "Start a workspace: a VM with the project's devcontainer and an editor in it. ", el("code", {}, `desolate up ${firstDomain ? firstDomain.slug : "<slug>"}`), hasBoth ? " (use New workspace on its card below)" : "")));
};

const render = () => {
  if (!state) return;
  const stack = document.getElementById("stack");
  stack.textContent = state.stack ? (state.stack.isolated ? `${state.stack.backend} VMs` : "NOT ISOLATED: fake backend") : "stack: unknown";
  stack.className = `chip ${state.stack && !state.stack.isolated ? "bad" : ""}`;
  const host = document.getElementById("host");
  host.textContent = notice || (state.hostConnected ? "host connected" : "host not connected: VM states are as last known; run `desolate bootstrap` on the host");
  host.className = `chip ${notice || !state.hostConnected ? "bad" : ""}`;
  const rootEditor = document.getElementById("root-editor");
  rootEditor.hidden = !state.rootEditor;
  if (state.rootEditor) rootEditor.href = state.rootEditor;
  const needs = needsYou();
  document.getElementById("needs").hidden = needs.length === 0;
  document.getElementById("needs-list").replaceChildren(...needs);
  const panel = reviewPanel();
  document.getElementById("review").hidden = !panel;
  document.getElementById("review").replaceChildren(...(panel ? [panel] : []));
  const first = firstRun();
  document.getElementById("first-run").hidden = !first;
  document.getElementById("first-run").replaceChildren(...(first ? [first] : []));
  // What is typed into a form survives a redraw.
  const typed = new Map([...document.querySelectorAll("#domains input")].map((input) => [`${input.closest("[data-domain]")?.dataset.domain}:${input.name}`, input.value]));
  const focused = document.activeElement && document.activeElement.closest ? `${document.activeElement.closest("[data-domain]")?.dataset.domain}:${document.activeElement.name}` : null;
  document.getElementById("domains").replaceChildren(el("h2", {}, state.domains.length ? "Domains" : ""), ...state.domains.map(domainCard));
  for (const input of document.querySelectorAll("#domains input")) {
    const key = `${input.closest("[data-domain]")?.dataset.domain}:${input.name}`;
    if (typed.has(key)) input.value = typed.get(key);
    if (key === focused) input.focus();
  }
  const recent = state.actions.slice().reverse();
  document.getElementById("activity").hidden = recent.length === 0;
  document.getElementById("activity-list").replaceChildren(...recent.map((a) => el("li", { "data-action-state": a.state },
    el("span", { class: `dot ${a.state === "done" ? "green" : a.state === "failed" ? "red" : "blue"}` }),
    el("div", { class: "what" }, el("div", { class: "name mono" }, redact(a.command)), el("div", { class: "line" }, a.state === "queued" ? "queued for the host..." : a.state === "running" ? "running..." : a.state === "done" ? "done" : `failed${a.code !== undefined ? ` (exit ${a.code})` : ""}`),
      a.lines.length ? el("pre", { class: "mono" }, a.lines.map(redact).join("\n")) : null), el("div", {}))));
  document.title = needs.length ? `(${needs.length}) desolate` : "desolate";
};

const listen = () => {
  const events = new EventSource("/events");
  events.onmessage = (event) => { state = JSON.parse(event.data); render(); };
  events.onerror = () => { events.close(); setTimeout(listen, 1500); };
};
// `?once`: the state as it is now, drawn once, with no stream left open. For a screenshot
// or a printed page; the dashboard itself always listens.
if (new URLSearchParams(location.search).has("once")) fetch("/state").then((response) => response.json()).then((now) => { state = now; render(); });
else listen();
