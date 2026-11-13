# Differs for reviewing agents' work: what desolate uses, and what it could (2026-11-13)

**What desolate uses:** git's own diff, in the root clone, from objects alone (no checkout, no
external diff program, no textconv), shown as text. Since `mac/dx`: the histogram algorithm
(hunks that follow the code's structure, better for moved blocks) and an "Ignore whitespace
changes" toggle (`-w`) on the dashboard's review. Both are git, so nothing new parses what an
agent wrote, in the VM that holds the keys.

## The candidates

| | what it adds | what it parses with | where it could run |
|---|---|---|---|
| **difftastic** (`difft`) | diffs by syntax tree: reformatting, re-wrapped arguments and moved items are not noise; side by side | tree-sitter grammars for ~50 languages, most of them C | the git VM, opt-in |
| **delta** | colours, syntax highlighting, side by side, line numbers on git's own diff | syntect (Rust, regex grammars) | the git VM; nothing it shows the dashboard lacks but colour |
| **git's own**: `--diff-algorithm=histogram`, `-w`, `--word-diff`, `--color-moved` | better hunks, whitespace-blind, word-level, moved-line marks | git | the root (no new parser): histogram and `-w` done; word diff and moved lines next, rendered by the dashboard |
| diff-so-fancy, icdiff, meld, Beyond Compare | cosmetics, or GUIs | various | not worth a place |

## The recommendation

- **Not in the root VM.** The root holds every write key, and its rule is that it parses agent
  content with git and nothing else. difftastic is the most useful of these, and also the most
  parser surface (C grammars for every language, fed whatever an agent wrote).
- **difftastic, opt-in, in the git VM.** No keys, no network; the worst a parser bug there gets
  is what the git VM already holds (read access to every domain's work, deliveries into
  domains). Pinned and installed by `git/provision.sh` like the git VM's other tools, set up as
  `git difftool --tool=difftastic` (`git difft main acme/feature`), off unless asked for.
  Worth it for reviewing agents, which reformat freely.
- **On the dashboard:** a side-by-side view and word-level highlighting, drawn by the
  dashboard's own script from git's text (no parser in the root): a UI change, on its own
  branch with a before-and-after video.
