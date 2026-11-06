/// <reference types="node" />
// What removing a project takes with it (#63), decided from names alone.
//
// Each rule here is one that, wrong, removes a SIBLING's data: a worktree of
// another project, its container, its volume, its image. So the cases that
// matter most are the near misses -- `acme/widgets-ui` beside `acme/widgets`,
// a folder that only starts with the right path -- and each is spelled out.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  containersOf,
  describeLosses,
  imagesOf,
  nothingLost,
  parseLosses,
  parseWorkspaceContainers,
  reviewsOf,
  urlSectionsOf,
  volumesOf,
  withoutHostBlock,
  worktreesInFolders,
  worktreesInState,
} from "../../../release/vscode-image/removal.ts";
import { LOSSES_DONE, STATUS_RAN } from "../../../release/vscode-image/docker.ts";

describe("worktreesInState: the worktrees desolate kept state for", () => {
  test("each worktree once, whatever it kept", () => {
    assert.deepEqual(
      worktreesInState(
        ["acme__widgets.ports", "acme__widgets--wt--wip.ports", "acme__widgets--wt--wip.token",
         "acme__widgets--wt--fix.daemon", "acme__widgets--wt--v1.2.spec"],
        "acme__widgets",
      ),
      ["fix", "v1.2", "wip"],
    );
  });

  test("not another project's, however its name begins", () => {
    assert.deepEqual(
      worktreesInState(["acme__widgets-ui--wt--wip.ports", "acme__widgetsx--wt--a.ports", "other__widgets--wt--b.ports"], "acme__widgets"),
      [],
    );
  });

  test("not a file state.ts does not write, nor a name that is no worktree's", () => {
    assert.deepEqual(
      worktreesInState(["acme__widgets--wt--wip.bak", "acme__widgets--wt--wip", "acme__widgets--wt--.ports",
                        "acme__widgets--wt--_x.ports", "acme__widgets--wt--a--wt--b.ports"], "acme__widgets"),
      [],
    );
  });
});

describe("worktreesInFolders: the worktrees a container was started in", () => {
  test("one segment under the project's .worktrees", () => {
    assert.deepEqual(
      worktreesInFolders(
        ["/workspaces/acme/widgets", "/workspaces/acme/widgets/.worktrees/wip", "/workspaces/acme/widgets/.worktrees/fix",
         "/workspaces/acme/widgets/.worktrees/wip"],
        "/workspaces/acme/widgets",
      ),
      ["fix", "wip"],
    );
  });

  test("not a sibling's, nor deeper, nor elsewhere in the project", () => {
    assert.deepEqual(
      worktreesInFolders(
        ["/workspaces/acme/widgets-ui/.worktrees/wip", "/workspaces/acme/widgets/.worktrees/wip/sub",
         "/workspaces/acme/widgets/src/.worktrees/x", "/workspaces/acme/widgets/.worktrees/"],
        "/workspaces/acme/widgets",
      ),
      [],
    );
  });
});

describe("containersOf: the containers desolate started for a folder", () => {
  const rows = parseWorkspaceContainers([
    "aaa\t/workspaces/acme/widgets\t/workspaces/acme/widgets/.devcontainer/devcontainer.json",
    "bbb\t/workspaces/acme/widgets\t",
    // A sibling that stamped this folder on its own container (once possible
    // through runArgs --label, now refused by the policy): its config names
    // its own folder.
    "ccc\t/workspaces/acme/widgets\t/workspaces/evil/x/.devcontainer/devcontainer.json",
    // A sibling whose folder merely STARTS with this one.
    "ddd\t/workspaces/acme/widgets-ui\t/workspaces/acme/widgets-ui/.devcontainer/devcontainer.json",
    "eee\t/workspaces/acme/widgets\t/workspaces/acme/widgets-ui/.devcontainer.json",
    "fff\t/workspaces/acme/widgets/.worktrees/wip\t/workspaces/acme/widgets/.worktrees/wip/.devcontainer.json",
    "",
    "\t/workspaces/acme/widgets\t",
  ].join("\n"));

  test("parses id, folder and config, and skips a row without an id", () => {
    assert.equal(rows.length, 6);
    assert.deepEqual(rows[1], { id: "bbb", folder: "/workspaces/acme/widgets", configFile: "" });
  });

  test("its folder, and a config inside it or none (one from before that label)", () => {
    assert.deepEqual(containersOf(rows, "/workspaces/acme/widgets"), ["aaa", "bbb"]);
  });

  test("a worktree's are its own", () => {
    assert.deepEqual(containersOf(rows, "/workspaces/acme/widgets/.worktrees/wip"), ["fff"]);
  });

  test("never one whose config names another folder, or a folder that only starts the same", () => {
    const ids = containersOf(rows, "/workspaces/acme/widgets");
    for (const sibling of ["ccc", "ddd", "eee"]) assert.ok(!ids.includes(sibling), sibling);
  });
});

describe("volumesOf: a project's volumes, by the longest claim", () => {
  const volumes = [
    "acme__widgets", "acme__widgets-db", "acme__widgets-server-dist", "acme__widgets-server-dist-data",
    "acme__widgets--wt--wip-server-dist", "acme__widgets-ui-db", "acme__widgetsdb", "other__widgets-db",
    "dind-data-acme__widgets", "acme",
  ];
  const removing = ["acme__widgets", "acme__widgets--wt--wip"];

  test("its own and its overlays, and its worktrees'", () => {
    assert.deepEqual(
      volumesOf(volumes, removing, ["acme", "acme__widgets-ui", "other__widgets"]),
      ["acme__widgets", "acme__widgets-db", "acme__widgets-server-dist", "acme__widgets-server-dist-data", "acme__widgets--wt--wip-server-dist"],
    );
  });

  test("not acme/widgets-ui's while it is there to claim it", () => {
    assert.ok(!volumesOf(volumes, removing, ["acme__widgets-ui"]).includes("acme__widgets-ui-db"));
  });

  test("with no longer claim on disk, the policy would have let this project mount it -- so it is this project's", () => {
    assert.ok(volumesOf(volumes, removing, []).includes("acme__widgets-ui-db"));
  });

  test("never a name that only starts the same, another owner's, the owner's, or a dind's", () => {
    const taken = volumesOf(volumes, removing, []);
    for (const kept of ["acme__widgetsdb", "other__widgets-db", "dind-data-acme__widgets", "acme"]) assert.ok(!taken.includes(kept), kept);
  });

  test("its own namespaces among the contesting ones change nothing", () => {
    assert.deepEqual(volumesOf(volumes, removing, [...removing, "acme__widgets-ui"]), volumesOf(volumes, removing, ["acme__widgets-ui"]));
  });
});

describe("imagesOf: the images built for its folders", () => {
  const digest = (dir: string) => createHash("sha256").update(dir).digest("hex");
  const root = "/workspaces/acme/widgets";
  const wip = "/workspaces/acme/widgets/.worktrees/wip";
  const references = [
    `vsc-widgets-${digest(root)}:latest`,
    `vsc-widgets-${digest(root)}-features:latest`,
    `vsc-widgets-${digest(root)}-features-uid:latest`,
    `vsc-wip-${digest(wip)}-uid:latest`,
    `vsc-widgets-ui-${digest("/workspaces/acme/widgets-ui")}-features:latest`,
    `vsc-widgets-${digest("/workspaces/other/widgets")}:latest`,
    "desolate-built/acme__widgets:0a1b2c3d4e5f",
    "desolate-built/acme__widgets-ui:0a1b2c3d4e5f",
    "desolate-built/acme__widgets--wt--wip:abc",
    "desolate-ca:0123456789abcdef",
    "mcr.microsoft.com/devcontainers/base:ubuntu",
    "registry.local:5000/vsc-x:1",
  ];

  test("the CLI's, for exactly these folders, and desolate's own builds of them", () => {
    assert.deepEqual(imagesOf(references, [root, wip], ["acme__widgets", "acme__widgets--wt--wip"]), [
      references[0], references[1], references[2], references[3],
      "desolate-built/acme__widgets:0a1b2c3d4e5f", "desolate-built/acme__widgets--wt--wip:abc",
    ]);
  });

  test("never a sibling's, a base image, or the CA derivatives every project shares", () => {
    const taken = imagesOf(references, [root], ["acme__widgets"]);
    for (const kept of references.slice(4)) if (kept !== "desolate-built/acme__widgets:0a1b2c3d4e5f") assert.ok(!taken.includes(kept), kept);
  });
});

describe("parseLosses: what the root's check found, or that it did not finish", () => {
  const ran = (...lines: string[]) => [STATUS_RAN, ...lines, LOSSES_DONE].join("\n");

  test("nothing", () => {
    const losses = parseLosses(ran("BRANCH main 0", "STASH 0"));
    assert.deepEqual(losses, { changes: [], branches: [], stashes: 0, detached: 0 });
    assert.ok(nothingLost(losses!));
    assert.deepEqual(describeLosses(losses!), []);
  });

  test("each kind of work that is nowhere else", () => {
    // Porcelain's first column may be a space: kept as git wrote it.
    assert.deepEqual(parseLosses(ran("CHANGE  M src/a.ts", "CHANGE ?? notes.txt"))?.changes, [" M src/a.ts", "?? notes.txt"]);
    const all = parseLosses(ran("CHANGE ?? x", "BRANCH main 0", "BRANCH feature/one 3", "BRANCH wip 1", "STASH 2", "DETACHED 4"))!;
    assert.deepEqual(all.branches, [{ name: "feature/one", commits: 3 }, { name: "wip", commits: 1 }]);
    assert.equal(all.stashes, 2);
    assert.equal(all.detached, 4);
    assert.ok(!nothingLost(all));
    assert.deepEqual(describeLosses(all), [
      "uncommitted or untracked:", "  ?? x",
      "branch feature/one: 3 commits on no remote branch", "branch wip: 1 commit on no remote branch",
      "2 stash entries", "a detached HEAD with 4 commits on no branch",
    ]);
  });

  test(".worktrees/ is not the root's to lose: each worktree is checked on its own", () => {
    assert.ok(nothingLost(parseLosses(ran("CHANGE ?? .worktrees/", "STASH 0"))!));
    assert.ok(!nothingLost(parseLosses(ran("CHANGE ?? .worktrees-old/"))!));
  });

  test("git's warnings come before the check ran, and are not losses", () => {
    assert.ok(nothingLost(parseLosses(`warning: something\n${ran("STASH 0")}`)!));
  });

  test("a check that did not finish is null, never clean", () => {
    assert.equal(parseLosses(""), null);
    assert.equal(parseLosses("git status exited 128"), null);
    assert.equal(parseLosses(`${STATUS_RAN}\nCHANGE ?? x\ncould not count wip`), null);
    assert.equal(parseLosses(`${LOSSES_DONE}\n${STATUS_RAN}\n`), null);
    // A line nobody prints on purpose: whatever wrote it, not a check to trust.
    assert.equal(parseLosses(ran("BRANCH main 0", "?? smuggled")), null);
  });

  test("many changes are summed up, not all listed", () => {
    const changes = Array.from({ length: 25 }, (_, i) => `CHANGE ?? f${i}`);
    const lines = describeLosses(parseLosses(ran(...changes))!);
    assert.equal(lines.length, 1 + 20 + 1);
    assert.equal(lines.at(-1), "  ... and 5 more");
  });
});

describe("withoutHostBlock: the ssh config without one repository's alias", () => {
  const block = (alias: string) =>
    `Host ${alias}\n  HostName github.com\n  User git\n  IdentityFile /run/keyring/pub/${alias.slice("github.com-".length)}.pub\n  IdentitiesOnly yes\n`;
  const config = `${block("github.com-acme__widgets-ui")}${block("github.com-acme__widgets")}${block("github.com-other__x")}`;

  test("that block, and nothing else", () => {
    assert.equal(
      withoutHostBlock(config, "github.com-acme__widgets"),
      `${block("github.com-acme__widgets-ui")}${block("github.com-other__x")}`,
    );
  });

  test("last, first, alone", () => {
    assert.equal(withoutHostBlock(config, "github.com-other__x"), `${block("github.com-acme__widgets-ui")}${block("github.com-acme__widgets")}`);
    assert.equal(withoutHostBlock(config, "github.com-acme__widgets-ui"), `${block("github.com-acme__widgets")}${block("github.com-other__x")}`);
    assert.equal(withoutHostBlock(block("github.com-acme__widgets"), "github.com-acme__widgets"), "");
  });

  test("hand-written lines around it stay, and an absent alias changes nothing", () => {
    const hand = `# mine\nHost example\n  User me\n\n${block("github.com-acme__widgets")}Host *\n  ServerAliveInterval 30\n`;
    assert.equal(withoutHostBlock(hand, "github.com-acme__widgets"), `# mine\nHost example\n  User me\n\nHost *\n  ServerAliveInterval 30\n`);
    assert.equal(withoutHostBlock(config, "github.com-nobody__here"), config);
    assert.equal(withoutHostBlock(withoutHostBlock(config, "github.com-acme__widgets"), "github.com-acme__widgets"),
      withoutHostBlock(config, "github.com-acme__widgets"));
  });
});

describe("urlSectionsOf: the url rewrites that name the repository", () => {
  const config = [
    "url.git@github.com-acme__widgets:acme/widgets.insteadof git@github.com:acme/widgets",
    "url.ssh://git@github.com-acme__widgets/acme/widgets.insteadof ssh://git@github.com/acme/widgets",
    "url.git@github.com-acme__widgets-ui:acme/widgets-ui.insteadof git@github.com:acme/widgets-ui",
    "url.ssh://git@github.com-acme__widgets-ui/acme/widgets-ui.insteadof ssh://git@github.com/acme/widgets-ui",
    "url.git@github.com-acme__w2:acme/widgets.js.insteadof git@github.com:acme/widgets.js",
    "url.https://example.com/.insteadof git://example.com/",
  ].join("\n");

  test("both spellings `repo add` wrote, by section", () => {
    assert.deepEqual(urlSectionsOf(config, "acme__widgets"), [
      "url.git@github.com-acme__widgets:acme/widgets",
      "url.ssh://git@github.com-acme__widgets/acme/widgets",
    ]);
  });

  test("not acme/widgets-ui's, whose alias only starts the same", () => {
    assert.ok(urlSectionsOf(config, "acme__widgets").every((section) => !section.includes("widgets-ui")));
  });

  test("an alias's, with a dotted repository name", () => {
    assert.deepEqual(urlSectionsOf(config, "acme__w2"), ["url.git@github.com-acme__w2:acme/widgets.js"]);
  });

  test("none, when there are none", () => {
    assert.deepEqual(urlSectionsOf("", "acme__widgets"), []);
  });
});

test("reviewsOf: the project's and its worktrees' reviews, no sibling's", () => {
  assert.deepEqual(
    reviewsOf(["acme__widgets", "acme__widgets@wip", "acme__widgets-ui", "acme__widgets-ui@wip", "acme__widgetsx"], "acme__widgets"),
    ["acme__widgets", "acme__widgets@wip"],
  );
});
