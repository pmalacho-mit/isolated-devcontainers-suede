#!/bin/bash
# The git VM's settings (host/git-vm.ts), as root, at every start. The git VM is where the
# person types git: in clones of their own, with no network, no key, and nothing of a
# project's that runs. Nothing here is a project's: no devcontainer, no direnv, no hooks.
set -euo pipefail
# git: every object checked, no hook of any clone's, no transport that runs a command,
# no submodule fetched, nothing a clone's files can name that git would execute.
mkdir -p /etc/desolate-git/no-hooks
cat >/etc/gitconfig <<'G'
[core]
	hooksPath = /etc/desolate-git/no-hooks
	fsmonitor = false
	protectHFS = true
	protectNTFS = true
	pager = less
[fetch]
	fsckObjects = true
	recurseSubmodules = false
[transfer]
	fsckObjects = true
[receive]
	fsckObjects = true
[submodule]
	recurse = false
[protocol]
	allow = never
[protocol "file"]
	allow = always
[protocol "desolate-out"]
	allow = always
# The shares are the Mac's files: on vz they report as owned by whoever last asked.
[safe]
	directory = *
	bareRepository = explicit
[advice]
	detachedHead = false
[init]
	defaultBranch = main
# LFS files check out and commit as LFS: git-lfs is the image's own program.
[filter "lfs"]
	clean = git-lfs clean -- %f
	smudge = git-lfs smudge -- %f
	process = git-lfs filter-process
	required = true
G
chmod 0644 /etc/gitconfig
# What a terminal shows is a file's or a commit's bytes. less shows colour and nothing else
# raw (-R), and runs nothing (LESSSECURE); vim reads no modeline from what it opens.
cat >/etc/profile.d/desolate-git.sh <<'P'
export LESS=-FRX LESSSECURE=1 PAGER=less GIT_PAGER=less
if command -v vim >/dev/null; then export EDITOR=vim VISUAL=vim; else export EDITOR=vi VISUAL=vi; fi
# A local fetch runs upload-pack in the source repository (the mirror; the root's clone),
# whose config is the root's user's: nothing there may fetch further on its own.
export GIT_NO_LAZY_FETCH=1
# /desolate/root holds the root's clones, read-only here, for `git fetch root`. Their config
# is the root's user's, and git run inside one would follow it: not done.
git() {
  case "$PWD/" in
    /desolate/root/*|/desolate/mirrors/*) echo "desolate: that is the root's repository, here only for \`git fetch root\`; git is not run in it. Your clones are under /git." >&2; return 1 ;;
  esac
  command git "$@"
}
export PS1='\[\e[1m\]git VM\[\e[0m\] \w\$ '
cd_repo() { cd "/git/$1" 2>/dev/null || echo "no clone of $1 here: on the Mac, desolate git $1"; }
case $- in *i*) echo "desolate's git VM: your clones are under /git. No network, no keys: \`git push origin <branch>\` asks you on the approval page; \`desolate\` says what else." ;; esac
P
chmod 0644 /etc/profile.d/desolate-git.sh
mkdir -p /etc/vim
printf 'set nomodeline\nset modelines=0\n' >/etc/vim/vimrc.local
ln -sf /desolate/release/git/git-remote-desolate-out /usr/local/bin/git-remote-desolate-out
ln -sf /desolate/release/git/desolate /usr/local/bin/desolate
ln -sf /desolate/release/git/desolate-lfs-file /usr/local/bin/desolate-lfs-file
echo "git VM: ready"
