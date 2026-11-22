# VerdictLite user manual

Version 0.1.15. This manual is also on the web at
<https://scottconverse.github.io/verdictlite/manual.html>.

VerdictLite (`vlite`) is a small command-line tool. It makes an AI coding agent
run your checks before it stops, and it writes down how each commit was checked.
It works in any git repo. The stop check is a Stop hook for Claude Code and
Codex. The commit gate uses plain git hooks, so it works with any agent and
with people too.

VerdictLite is an independent project. It is not made by, affiliated with or
endorsed by Anthropic. It follows the method in the article
[How the Claude Code team thinks about verification](https://claude.dev/blog/how-the-claude-code-team-thinks-about-verification/)
by Addy Osmani (November 16, 2026).

## Contents

1. [Before you start](#1-before-you-start)
2. [Install VerdictLite](#2-install-verdictlite)
3. [Set up a repo](#3-set-up-a-repo)
4. [What happens in a normal agent session](#4-what-happens-in-a-normal-agent-session)
5. [Read a block message](#5-read-a-block-message)
6. [The three-round hand-off](#6-the-three-round-hand-off)
7. [Stamps and the Verified-By trailer](#7-stamps-and-the-verified-by-trailer)
8. [Skip the gate on purpose: Verify-Skip](#8-skip-the-gate-on-purpose-verify-skip)
9. [Gate modes: off, observe, enforce](#9-gate-modes-off-observe-enforce)
10. [Run an AI review](#10-run-an-ai-review)
11. [Test-tamper rules and TEST-REMOVALS.md](#11-test-tamper-rules-and-test-removalsmd)
12. [The gate report](#12-the-gate-report)
13. [Where state lives](#13-where-state-lives)
14. [Troubleshooting](#14-troubleshooting)
15. [Config reference: vlite.json](#15-config-reference-vlitejson)
16. [Command reference](#16-command-reference)
17. [FAQ](#17-faq)

---

## 1. Before you start

You need:

- **git.**
- **Node.js 20 or newer.** Get it from <https://nodejs.org/>.
- **pnpm**, to build VerdictLite from source. See <https://pnpm.io/installation>.
- **Claude Code or Codex**, if you want the stop check. The stop check is a
  [Stop hook](https://code.claude.com/docs/en/hooks) that runs in either app.
  Other agents do not get the Stop hook automatically; they get the commit
  gate, and `vlite stamp` and `vlite review` are CLI commands any agent can run.
- **The `claude` command on PATH**, if you want `vlite review` with the default
  settings.

VerdictLite has no runtime dependencies. It is not on npm yet. You install it
from the git repo.

Two words you will see a lot:

- **Base branch.** The branch your work will merge into, usually `main`.
- **Tree id.** Git's hash of a whole set of files. Two folders with the same
  files have the same tree id. VerdictLite uses it to know *exactly* which
  version of your files a check ran on.

## 2. Install VerdictLite

Install it once per machine, in its own folder. Keep it **outside** the repos
it checks. The tool lives outside the repo, so a change cannot edit the tool itself. `vlite.json` is read from the base branch, but the commands it runs (package.json scripts, pyproject, ruff, mypy and eslint configs) come from the working tree, so a change can still edit what those commands do.

### Windows: one click

1. Open the [latest release](https://github.com/scottconverse/verdictlite/releases/latest).
2. Download `install-verdictlite.cmd` and double-click it.

Or run this one line in PowerShell:

```powershell
irm https://github.com/scottconverse/verdictlite/releases/latest/download/install.ps1 | iex
```

The installer needs no admin rights. It does these things:

1. Checks for Node.js 20 or newer. If it is missing, it installs Node.js with
   `winget` for your user only. With no `winget`, it stops and tells you to get
   Node.js from <https://nodejs.org/>.
2. Downloads `verdictlite.zip` from the release and checks its SHA-256. If the
   checksum is wrong, it stops and changes nothing.
3. Puts the files in `%LOCALAPPDATA%\VerdictLite\app`. The folder is always the
   same, because the git hooks keep its path.
4. Writes `%LOCALAPPDATA%\VerdictLite\bin\vlite.cmd` and adds that `bin` folder
   to your user PATH.
5. Runs `vlite --help` and prints the installed version.
6. Runs `vlite connect` on a true first install only. This adds the VerdictLite
   Stop hook to the Claude Code and Codex desktop apps, at user level. It is
   not a first install when `dist\cli.js` is already in the install folder,
   when the VerdictLite home folder exists (`VLITE_HOME`, else
   `%USERPROFILE%\.verdictlite`), or when `vlite connect --uninstall` left its
   `connect-off.json` marker there. In those cases the installer keeps your
   current connect state, does not run `vlite connect`, and prints one line that
   says why. Use `-NoConnect` to never connect, or `-Connect` to connect anyway.
   The installer also takes `-Version X.Y.Z` (install a set release),
   `-InstallDir PATH` (the program folder), `-NoPath` (leave your user PATH
   alone) and `-PlanOnly` (print the steps and change nothing).

Open a new terminal after it finishes. If it connected the apps, restart the
Claude and Codex apps. Codex runs a new hook only after you approve it. In
Codex, click **Review hooks** in the message box, or open **Settings > Hooks**.
The installer prints the approve step only when it connected the apps.

To connect or disconnect the apps later, run `vlite connect` or
`vlite connect --uninstall`. Add `--claude` or `--codex` to pick one app.
`--uninstall` always removes VerdictLite's entry from Codex `hooks.json`, also when
`config.toml` has a `[hooks]` table. If `config.toml` defines hooks and mentions
`stop-check`, it tells you to remove that hook by hand. A plain `vlite connect`
does not write `hooks.json` when `config.toml` already defines hooks; it prints
the hook to add there by hand. `--uninstall` also writes
`connect-off.json` in the VerdictLite home, so the installer does not connect
again on its own. A plain `vlite connect` removes that marker.
If VerdictLite's own hook entry has an old path or timeout (for example after
you moved the install folder), `vlite connect` updates it, makes a backup and
says so. A hook command that is not VerdictLite's own is never changed.

**Codex limit:** In Codex, VerdictLite checks the repo the session opened in, plus
any repo that blocked on that session's last stop. It cannot use the Codex log to
find other repos the session changed. If the opened repo has `vlite stop-check` in
`.claude/settings.json`, VerdictLite treats that repo as already covered, so a
Codex session there does not check it.

**To update:** run the installer again. It replaces the files in the same
folder, so the paths in your git hooks stay valid.

**To uninstall:** run `vlite connect --uninstall` to remove the user-level Claude
Code and Codex hooks. Then, in each guarded repo, run `vlite install --uninstall`
to remove its hooks. Remove the `vlite stop-check` entry from each guarded repo's `.claude/settings.json` or `.claude/settings.local.json`, if you added one. Then delete the folder `%LOCALAPPDATA%\VerdictLite`. Last,
remove `%LOCALAPPDATA%\VerdictLite\bin` from your user PATH (Windows Settings,
search for "environment variables", then "Edit environment variables for your
account").

### From source (any OS)

```sh
git clone https://github.com/scottconverse/verdictlite.git
cd verdictlite
pnpm install
pnpm build
npm link
```

`npm link` puts the `vlite` command on your PATH. Check it:

```sh
vlite --help
```

You can skip `npm link`. Then call the tool as `node /path/to/verdictlite/dist/cli.js`.
The git hooks do not need `vlite` on PATH. They call the exact `node` and
`dist/cli.js` that ran `vlite install`.

**To update from source:** `git pull`, then `pnpm install` and `pnpm build` again.

## 3. Set up a repo

Do these steps in the repo you want to guard. Steps 1 to 3 are files you commit.
Step 4 is local to your machine. Step 5 is local unless you commit `.claude/settings.json`.

### Step 1. Write `vlite.json`

Put `vlite.json` in the repo root. Here is a small example for a Node project:

```json
{
  "version": 1,
  "base": "origin/main",
  "docs": ["**/*.md", "docs/**", "LICENSE*"],
  "codeDespiteDocs": ["**/SKILL.md", ".claude/**", "REVIEW.md"],
  "parts": [
    {
      "name": "app",
      "paths": ["src/**", "test/**"],
      "checks": [
        { "name": "lint", "run": "pnpm lint", "timeoutSec": 300 },
        { "name": "tests", "run": "pnpm test", "timeoutSec": 900 }
      ]
    }
  ],
  "tests": { "paths": ["test/**", "**/*.test.ts"], "removalsLog": "TEST-REMOVALS.md" },
  "gate": { "mode": "observe" }
}
```

What this says:

- `docs` files are words, not code. A change that only touches docs passes
  without running checks.
- `codeDespiteDocs` are files that look like docs but change behavior. They
  count as code.
- Each **part** is one area of the repo. Its checks run only when a changed file
  matches its `paths`.
- `tests.paths` tells the built-in tamper check which files are tests.
- `gate.mode` is `observe`. The gate watches but never blocks. Start here.

See [section 15](#15-config-reference-vlitejson) for every field.

### Step 2. Write `REVIEW.md` (optional)

`REVIEW.md` holds the rules for `vlite review`. Write each rule with a short
name, a trigger (what in a diff makes it apply) and what to check. For example:

```markdown
# Review rules

## no-silent-catch
Trigger: a `catch` block in the diff.
Check: the error is logged or passed on. An empty catch is a finding.

## sql-params
Trigger: a SQL string in the diff.
Check: values go in as parameters, never by string concatenation.
```

The reviewer is told to run only the rules whose trigger matches the diff.

### Step 3. Merge both files to the base branch

This step matters. VerdictLite reads `vlite.json` and `REVIEW.md` **from the
base branch**, not from your working files. So a change on a feature branch
cannot loosen the config that judges it. (The commands the config runs still come from the working tree.)

Until `vlite.json` is on the base branch, VerdictLite uses the copy in your
working tree. It prints this warning each time:

```text
VerdictLite: vlite.json is not on the base branch yet; using the working-tree copy (bootstrap).
```

It also marks every log record with `"configSource": "worktree"`. Merge the
file and the warning goes away. Run `git fetch` so `origin/main` is current.

### Step 4. Install the git hooks

```sh
vlite install --claude
```

This writes two git hooks, `pre-commit` and `commit-msg`. They run the commit
gate. `--claude` also prints the Stop hook settings for Claude Code. It prints
them only. It does not write any file.

Notes:

- The hooks go where git looks for hooks. That respects `core.hooksPath`. In a
  linked worktree they go in the shared hooks folder, so all worktrees get them.
- If a hook is already there and is not VerdictLite's, it is kept as
  `pre-commit.vlite-prev` (or `commit-msg.vlite-prev`). It runs first. If it
  fails, the commit stops with its exit code.
- Running `vlite install` again is safe. It updates its own hooks.
- Hooks live in `.git`, so each clone needs its own `vlite install`.

### Step 5. Add the Stop hook to `.claude/settings.json`

Merge this into `.claude/settings.json` in the repo (or into
`.claude/settings.local.json` if you do not want to commit it):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "vlite stop-check",
            "timeout": 3600
          }
        ]
      }
    ]
  }
}
```

`timeout` is in seconds. `vlite connect` and `vlite install --claude` both use
3600 in the settings they write or print. It must be longer than your checks put
together, because they run one at a time. `vlite install` prints a warning when the check timeouts in `vlite.json`
add up to more than 3600 s (a template part counts its checks times
`maxExpandedParts`). If the app kills the hook, no verdict is written. If `vlite` is not on PATH, `vlite install --claude` prints a full
command to use instead, for example:

```text
If vlite is not on PATH, use this command instead: "/usr/local/bin/node" "/home/me/tools/verdictlite/dist/cli.js" stop-check
```

If the file already has a `Stop` entry, add VerdictLite's hook to the list.
Do not replace the others.

**Codex users:** run `vlite connect --codex`. It writes
`$CODEX_HOME/hooks.json` (default `~/.codex/hooks.json`). Then approve the hook
in Codex.

#### Sessions that start in another folder

Claude Code loads a project hook only when the session starts inside the repo.
Many setups start a session in a parent folder, or start agent workers from a
tools folder, and edit the repo with full paths. The project hook never runs
for them.

For these, add the hook to your user settings, `~/.claude/settings.json`, with
`--global`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "vlite stop-check --global", "timeout": 3600 }
        ]
      }
    ]
  }
}
```

What `--global` does on each stop:

1. It reads the session's transcript. It finds the files that the session
   edited with Edit, Write, MultiEdit or NotebookEdit since your last prompt.
2. It finds the git repo of each file. It keeps only repos with a `vlite.json`.
3. It adds the session folder's repo, unless that repo has its own project
   hook in `.claude/settings.json` (that hook already checks it, so it does not
   run twice). A hook kept only in `.claude/settings.local.json` is not seen,
   so that repo is checked twice.
4. It adds any repo that blocked on this session's last stop, so a fix is
   checked again.
5. It runs the normal stop check on each repo and sends one combined message.

In folders and repos without a `vlite.json` it prints nothing, except the
required-org check below. It adds a short wait per stop, longer on a large
transcript; the time is not measured yet.

Limit: `--global` does not see a file changed only by a shell command (for
example `sed -i`), unless the session started inside that repo. In Codex,
VerdictLite checks the repo the session opened in, plus any repo that blocked on
its last stop. It cannot use the Codex log to find other repos. A repo with
`vlite stop-check` in `.claude/settings.json` counts as covered and is not
checked.

### Step 6. Add a `verify` skill (recommended)

The stop check runs your quick checks. A `verify` skill tells the agent how to
prove a change *works*, for example by starting the app and using it, and then
how to record that it did. Claude Code loads project skills from
`.claude/skills/<name>/SKILL.md` ([skills docs](https://code.claude.com/docs/en/skills)).

Example `.claude/skills/verify/SKILL.md`:

```markdown
---
name: verify
description: Prove the current change works before you commit. Use after any code change.
---

1. Run the full test suite: `pnpm test 2>&1 | tee .verify/tests.log`.
2. Start the app and try the changed feature the way a user would.
   Write what you did and what you saw in `.verify/notes.md`.
3. If anything failed, fix the cause and start again. Do not skip, sleep or
   rerun tests to make them pass.
4. When all of it passed, stage everything and record it:
   `git add -A`
   `vlite stamp verify --result pass --evidence .verify/tests.log --evidence .verify/notes.md`
```

Add `.verify/` to `.gitignore` so the evidence files do not change the tree id.
The skill file is listed in `codeDespiteDocs` in the example config, so a change
to it counts as code.

### Require VerdictLite in a GitHub org

You can say that every repo of a GitHub org must have VerdictLite. Run this
once on your PC:

```
vlite require-org forkcommons
vlite require-org --list
vlite require-org --remove forkcommons
```

The name is not case sensitive. VerdictLite saves the list in
`settings.json` in the VerdictLite home folder.

Here is what happens next. The global Stop hook finds a repo whose `origin`
remote is on github.com and belongs to a listed org. If that repo has no
`vlite.json`, VerdictLite blocks the agent once. The message tells the agent to
write `vlite.json`, run the checks, run `vlite install`, and commit the file.
If the agent stops again in the same turn, VerdictLite only warns. It never
blocks twice in one turn. A `vlite.json` in the working tree counts as present.

Limits:

- This runs only on PCs where VerdictLite is installed and connected.
- A repo with no `origin` remote, or an `origin` on another host, is not
  checked.
- In Codex, VerdictLite checks the repo the session opened in, plus any repo that
  blocked on its last stop. It cannot use the Codex log to find other repos. A
  repo with `vlite stop-check` in `.claude/settings.json` counts as covered and
  is not checked.

## 4. What happens in a normal agent session

Here is one session from start to end.

1. **The agent edits files.** Nothing happens yet.
2. **The agent tries to stop.** The app (Claude Code or Codex) runs
   `vlite stop-check`.
3. **Same files as last pass?** VerdictLite works out the tree id of the whole
   working tree (tracked and untracked files, `.gitignore` respected). If this
   exact tree already passed on this branch, it lets the agent stop at once.
4. **What changed?** It lists the files changed since the last pass on this
   branch. If there was no pass yet, it compares with the merge-base of the base
   branch.
5. **Docs only?** If every changed file is docs, the stop passes.
6. **Tamper check.** If a changed file is a test file or a test-runner config
   file, the built-in `test-tamper` check runs. See [section 11](#11-test-tamper-rules-and-test-removalsmd).
7. **Your checks.** For each part whose `paths` match a changed file, its checks
   run in order. The first failing check stops that part. Other parts still run.
   A template part runs once for each module that changed. A part whose
   `requires` files are missing is skipped, and a warning line says so. If the
   base branch has that file and the change deleted it, the part fails as
   `part/requires` and blocks. A skipped part is not a pass: its warning repeats at
   each stop until the part can run. A check that times out is no result: it is not
   a failure, it counts no round, and it is not recorded as a pass. See
   [Part templates](#part-templates).
8. **All pass:** VerdictLite records the tree as passed and the agent stops.
   **Something fails:** it blocks the stop and tells the agent what failed. The
   agent keeps working. See [section 5](#5-read-a-block-message).
9. **The agent commits.** The `pre-commit` and `commit-msg` hooks run the gate.
   The gate adds a `Verified-By:` line to the commit message. See
   [section 7](#7-stamps-and-the-verified-by-trailer).

A stop-check pass lets the agent stop. When at least one check ran in full (no
part was skipped, the run was not narrow, and no check passed only on the tests
that failed last time), it also writes a `stop-check`
stamp for that exact tree, so a commit of the same files shows
`Verified-By: stop-check`. A pass where no check ran (docs only, or files no part
covers) writes no stamp.

A run with a skipped part (a missing `requires` path, or too many modules) is not
a pass. VerdictLite does not move its saved pass, so the skipped files are
judged again as soon as the part can run. The skipped part never blocks; it
writes no stamp for that run. Another failing check still blocks. The warning
repeats at each stop on the same files, without running the checks again. Stamps
come from `vlite stamp`, a clean `vlite review`, or a full passing stop check.

## 5. Read a block message

When a check fails, the agent gets a message like this one. This is real output
from a test repo. The test runner's output and the paths are shortened here.

```text
VerdictLite: checks failed on this change (repo .../shop).

[app/tests] failed
command: node --test
exit code 1
last lines of output:
TAP version 13
# Subtest: adds price times quantity
not ok 1 - adds price times quantity
  ...
  error: |-
    Expected values to be strictly equal:

    9 !== 14
  ...
# pass 1
# fail 1

Full output: ~/.verdictlite/shop-1fc1e50e6f/handoffs/2026-11-19T04-51-44-727Z-round1.txt

Round 1 of 3. Fix the cause. Do not skip, sleep or rerun to pass.
```

How to read it:

- `[app/tests]` is the part name and the check name.
- `command` is the exact command that ran.
- `exit code` is what the command returned. A check that ran out of time is
  not shown here. It is no result, and it gets its own warning line: the check
  froze, the result is unknown, and the agent can continue.
- `last lines of output` is the last 60 lines.
- `Full output` is a saved file: the last 2,000 lines of output for each failing
  check, plus up to 200 changed file names.
- `Round 1 of 3` counts tries. See the next section.

Technically, the stop check prints `{"decision": "block", "reason": "..."}` to
the app (Claude Code or Codex). The app shows the reason to the agent and keeps
it working. In Codex, `decision: block` continues the turn with the reason as the
next prompt.

## 6. The three-round hand-off

An agent can get stuck. It may try the same broken fix again and again. So
VerdictLite counts rounds.

- A round is one failed stop. Rounds are counted **per session and branch**,
  not per set of failing checks. Failures that take turns count together.
- A pass resets the round counts for that session. A hand-off does too.
- A check that times out is no result. It adds no round, never blocks and never
  hands off. If nothing else failed, there is no pass either: no stamp is
  written, and `stop.jsonl` says `no-result`. If another check really failed,
  the block or hand-off is for that failure only, with the timeout warning.
- With the default `maxRounds` of 3, rounds 1 and 2 block the stop. **Round 3
  does not block.** VerdictLite prints `continue: false` and hands off to a
  person:

```text
VerdictLite: app/tests still fails after 3 rounds. A person must look. Last failure: exit code 1. Handoff: ~/.verdictlite/shop-1fc1e50e6f/handoffs/2026-11-19T04-51-47-492Z-round3.txt
```

Technically, this is `{"continue": false, "stopReason": "..."}`. Claude Code
stops the agent and shows you the reason. Codex marks the hook run as stopped.

What you do then: open the handoff file, read the output and decide. You can fix
it yourself, give the agent a hint, or change the check.

## 7. Stamps and the Verified-By trailer

A **stamp** is a line in a log that says "this check ran on this exact tree and
it passed (or failed)". There are three kinds:

- `verify`: written by you or your verify skill with `vlite stamp verify`.
- `code-review`: written by `vlite review` when it finds nothing important.
- `stop-check`: written by the Stop hook (`vlite stop-check`) when it passes. `vlite stamp` cannot write it; it accepts only `verify` and `code-review`.

Write a stamp:

```sh
git add -A
vlite stamp verify --result pass --evidence test-run.log --note "unit and e2e tests"
```

```text
Stamped verify pass for tree d922fdcc8ebb
```

Rules:

- Evidence files must exist, or the stamp is refused. Relative paths are read
  from the folder you run the command in.
- The stamp is for the tree id of the whole working tree at that moment.
- For each kind, the latest stamp for a tree wins. A later `fail` stamp cancels
  an earlier `pass`.

**At commit time** the gate finds the method for the exact tree being committed:

| Method | When |
|---|---|
| `docs` | Every staged change is a docs file. |
| `verify` | A `verify` pass stamp matches the tree. |
| `code-review` | A `code-review` pass stamp matches the tree. |
| `stop-check` | A passing Stop hook (`vlite stop-check`) ran on the same tree. |
| `verify+code-review` | Both match. Other mixes are joined by `+`, such as `verify+stop-check`. |
| `skipped` | The message has a `Verify-Skip:` trailer. |
| `none` | None of the above. |

The gate then adds a **trailer** (a `Key: value` line at the end of the commit
message). Other trailers stay. An old `Verified-By` line is replaced.

Real output (commit id shortened, date line removed):

```text
$ git log -1
commit 15c9cc06f92b
Author: Demo <demo@example.com>

    feat: add count()

    Verified-By: verify
```

A passing Stop hook on the same files also counts. Real output after the Stop
hook passed and the agent committed without a stamp:

```text
$ git log -1
commit cf9307b3e6df
Author: Demo <demo@example.com>

    feat: add sum()

    Verified-By: stop-check
```

**Why a stamp might not count.** The stamp is for the working tree. The commit
is for the staged files. They must be the same. If you leave a file unstaged or
an untracked file out of the commit, the trees differ and the method is `none`.
Stage everything (`git add -A`) before you stamp and before you commit. Keep
evidence files in a folder that `.gitignore` ignores.

**A stamp shows that a step ran. It is not proof.** Anyone can write one by
hand. It is a speed bump that makes skipping a visible choice.

## 8. Skip the gate on purpose: Verify-Skip

Some commits do not need checks, for example a generated file you checked by
hand. Add a `Verify-Skip:` trailer with a reason as the last paragraph of the
commit message:

```text
chore: bump version

Verify-Skip: generated file, checked by hand
```

The commit gets `Verified-By: skipped` and the reason goes in the log. It shows
in `vlite gate report`. The trailer must be in the last paragraph of the
message, where git looks for trailers.

## 9. Gate modes: off, observe, enforce

Set the mode in `vlite.json` under `gate.mode`.

| Mode | What it does |
|---|---|
| `off` | Nothing. No trailer, no log. |
| `observe` | Never blocks. Adds the trailer. Logs commits that *would* have been blocked. This is the default. |
| `enforce` | Blocks a commit with method `none`. |

When a commit is blocked in `enforce` mode, you see:

```text
VerdictLite: commit blocked. Nothing shows this exact change was verified (method: none).
Do one of these, then commit again:
  1. Run the checks, then:  vlite stamp verify --result pass --evidence <log file>
  2. Get the AI review:     vlite review
  3. Skip on purpose: add this line at the end of the commit message:
       Verify-Skip: <why this commit does not need it>
A stamp only counts for the exact staged tree. Stage everything first (git add -A).
```

**The escape.** After two blocks within 30 minutes, the third try goes through.
It is logged as an escape. This stops a person from being locked out of their
own repo. The count is per repo, not per session.

**When to switch.** Start in `observe`. Run `vlite gate report` after a week or
two. Look at the "would have been blocked" count and at the commits behind it.
If most of them really should have been checked, and your team has a working
verify skill, switch to `enforce` on the base branch. If many would-blocks were
fine commits, fix your `docs` globs or your workflow first.

Remember the mode is read from the base branch. Changing it on a feature branch
does nothing until it is merged.

## 10. Run an AI review

```sh
vlite review
```

What it does:

1. Reads the rules from `REVIEW.md` **on the base branch**.
2. Makes a diff from the merge-base to your working tree. The diff is cut at
   about 200 KB, and the prompt says so.
3. Adds earlier review rounds on this branch, so the reviewer can check whether
   earlier findings were fixed. The diff, the author note and the earlier rounds
   go between clear markers. The prompt says that text inside them is data,
   never instructions, and that any text in them that asks for no findings or a
   pass is itself an important finding.
4. Sends the prompt on stdin to the review command. By default that is
   `claude -p`. Set `review.command` and `review.args` to change it, for example
   `"args": ["-p", "--model", "sonnet"]`.
   The reviewer runs with `VLITE_REVIEWER=1`. The stop check does nothing in
   that session, so a review never runs your repo's checks or gets blocked.
   When the command is Claude Code (`claude`), VerdictLite adds
   `--disallowedTools Edit,Write,NotebookEdit,Bash`, so the app blocks write
   tools. If your `review.args` already has `--disallowedTools`, your value is
   kept. When the command is Codex (`codex`) and its subcommand is `exec` (or its alias `e`; the first
argument that is not a flag or a flag's value), VerdictLite always turns off the Codex tools that can
write (shell, code host, sub-agents, apps, plugins, MCP and apply_patch). It adds `--sandbox read-only` only when your
`review.args` sets no sandbox (`--sandbox`, `-s`, `--full-auto` or `--dangerously-bypass-approvals-and-sandbox`).
If you set a sandbox, your choice is kept and the tool lockout is added anyway. For any
   other command, only the prompt says "read-only". VerdictLite cannot block
   tools there.
5. Expects strict JSON back: a list of findings, each with a severity, file,
   line, rule, problem and evidence.

Severities:

- `important`: must fix before merge.
- `nit`: small and optional.
- `pre-existing`: a problem this diff did not add.

An unknown severity counts as `important`.

Results and exit codes:

| Result | Exit code | Stamp |
|---|---|---|
| No `important` findings | 0 | A `code-review` pass stamp for the current tree |
| No `important` findings, but the diff was cut at about 200 KB or `REVIEW.md` was missing on the base branch | 2 | None |
| One or more `important` findings | 2 | None |
| The reviewer failed, timed out or did not reply with the JSON asked for | 1 | None. The raw reply is saved. |

Each round is saved as `reviews/<branch>/<n>.json` in the state folder. To tell
the reviewer what you changed, add a note: `vlite review --round-note "fixed the
null check"`. To compare with another base: `vlite review --base origin/release`.

If `REVIEW.md` is missing on the base branch, the review still runs with general
rules and says so.

## 11. Test-tamper rules and TEST-REMOVALS.md

The article's rule is: do not skip, sleep or rerun to make tests pass. If you
remove a test, write down why. VerdictLite has a built-in check for this called
`test-tamper`. It runs inside the stop check. You cannot turn it off in config,
but it only looks at files you list in `tests.paths` and at known test-runner
config files.

It looks at **added and removed lines** in changed test files. It fails on:

- **Added skip markers:** `@pytest.mark.skip`, `pytest.skip(`, `@unittest.skip`,
  `xfail`, `.skip(`, `it.skip`, `test.skip`, `describe.skip`, `xit(`,
  `xdescribe(`, `xtest(`, `test.fixme`, `it.only`, `test.only`,
  `describe.only`, `fit(`, `fdescribe(`, `pytest.importorskip(`,
  `.skipTest(`, `.skipIf(`, `@unittest.expectedFailure`, `.fixme(`.
  A platform guard is not a skip. This is a conditional skip whose only condition
  is the operating system, for example
  `@pytest.mark.skipif(os.name != "nt", reason="...")`,
  `@unittest.skipUnless(sys.platform == "win32", "...")` or
  `it.skipIf(process.platform !== 'win32')`. The condition may use only
  `sys.platform`, `os.name`, `platform.system()` or `process.platform`, compared
  with a plain string. Any other condition still counts as a skip.
- **Added fixed waits:** `time.sleep(`, `asyncio.sleep(`, `waitForTimeout(`, and
  `setTimeout` used as a wait.
- **Added retries:** `@flaky`, `pytest.mark.flaky`, `--reruns`, `.retries(N)`,
  `jest.retryTimes(`, or a raised `retries:` value. Retries are also checked in
  these config files, even if they are not in `tests.paths`:
  `playwright.config.*`, `vitest.config.*`, `vite.config.*`, `jest.config.*`,
  `pytest.ini`, `pyproject.toml`, `setup.cfg`, `tox.ini`, `conftest.py`.
- **Removed tests:** a removed `def test_*`, `it("...")` or `test("...")` that is
  not added again anywhere in the change.

Real output when an agent skipped one test and deleted another:

```text
[test-tamper] failed
command: (built-in)
exit code 1
last lines of output:
tests/price.test.js:4 [skip] test.skip('adds price times quantity', () => {
  -> Remove the skip, xfail or .only. Fix the test or the code instead.
tests/price.test.js:7 (old line) [removed-test] test('rounds to cents', () => {
  -> Test "rounds to cents" was removed. Restore it, or add a line to TEST-REMOVALS.md with its name and why it was removed.
```

In that run the test suite itself passed, because the failing test was skipped.
The tamper check is what caught it.

**Removing a test on purpose.** Add a line to the removals log
(`TEST-REMOVALS.md` by default) in the same change. The line must contain the
test's name:

```markdown
- rounds to cents: covered by the new money module tests; old helper removed.
```

Only **added** lines in the log count. A name that was already in the log does
not cover a new removal.

**Limits.** The detectors are simple regular expressions. They can miss things,
and they can flag lines that are fine. A moved test (removed in one file, added
in another) passes. A renamed test counts as removed. If `tests.paths` is empty,
only the retry check on config files runs.

## 12. The gate report

```sh
vlite gate report --days 7
```

Real output from a test repo in `observe` mode:

```text
VerdictLite gate report, last 7 days (mode now: observe)
Commits judged: 5
  verify: 1
  stop-check: 1
  docs: 1
  none: 1
  skipped: 1
Would have been blocked (observe): 1
Checked after commit (same files passed later): 0
Blocked (enforce): 0
Let through after two blocks (escape): 0
Overrides (Verify-Skip): 1
  2026-11-19 04:51  generated file, checked by hand
```

- **Commits judged:** commits that went through, with a count per method.
- **Would have been blocked:** commits with method `none` in `observe` mode.
- **Checked after commit:** commits stamped `none` whose exact files passed a
  check later (for example, the stop check ran after the agent committed).
  The method in the commit stays `none`. This line only tells you that the
  work was checked.
- **Blocked:** commit attempts stopped in `enforce` mode.
- **Escape:** commits let through after two blocks.
- **Overrides:** `Verify-Skip` commits, with time (UTC) and reason.

`--days` defaults to 7.

## 13. Where state lives

VerdictLite keeps nothing in your repo. Its state is in `~/.verdictlite/`. Set
the `VLITE_HOME` environment variable to use another folder.

Each repo gets a folder named after the repo folder plus a short hash of its
git folder, for example `~/.verdictlite/shop-1fc1e50e6f/`. All worktrees of one
repo share it.

| File | What it holds |
|---|---|
| `state.json` | The last passing tree per branch (per worktree folder for a detached HEAD, reused only while the saved commit is still in HEAD's history) and per part, the failed-test ids to rerun at the next stop, round counters, pending gate records, recent blocks. |
| `sessions/<session>.json` | The repos a session's last block was about, checked again at its next stop. |
| `stop.jsonl` | One line per repo checked: pass, block, handoff, no-result, missing-config or error. A global stop can write several. A stop that repeats a saved result writes none. |
| `stamps.jsonl` | One line per stamp. |
| `gate.jsonl` | One line per gate decision. |
| `handoffs/` | The saved output of each failing stop-check round: the last 2,000 lines for each failing check, plus up to 200 changed file names. |
| `reviews/<branch>/<n>.json` | Each review round. |

The `.jsonl` files are append-only logs, one JSON object per line, with ISO
times. You can delete the folder to reset VerdictLite for a repo.

## 14. Troubleshooting

**The tool broke, and the agent stopped anyway.**
That is on purpose. If VerdictLite itself fails (not a check, the tool), the
stop check prints `VerdictLite stop-check internal error (ignored, not
blocking): ...` and lets the agent stop. It logs `"result": "error"` in
`stop.jsonl`. A failing *check* always blocks. A broken *tool* never does.

If VerdictLite itself fails (a broken or mistyped `vlite.json`, a locked file), it still lets the agent stop, but it now says so: the hook prints a `systemMessage` that the app (Claude Code or Codex) shows to the person, and the text is added to any block or handoff. Unknown top-level keys in `vlite.json` are an error, so a typo such as `"part"` is caught.
The same goes for the gate: a broken `vlite.json` prints `VerdictLite gate
skipped: ...` and lets the commit through.

**"vlite.json is not on the base branch yet".**
Merge `vlite.json` to the base branch and run `git fetch`. VerdictLite looks for
`vlite.json` on `origin/main` first, then `main`. If the file there names
another `base` that has its own `vlite.json`, that copy is used. If your
default branch has another name, such as `master`, VerdictLite 0.1.15 will not
find the config there and stays in bootstrap mode.

**Nothing happens at all.**
With no `vlite.json` anywhere, every command that reads the config exits 0 and
does nothing. Check
that you are in the right repo and that the file is named `vlite.json`.

**My old git hooks.**
`vlite install` keeps a foreign hook as `<name>.vlite-prev` and runs it first.
If both the hook and a `.vlite-prev` file already exist, install stops with
`... is not ours and ... already exists. Move one of them by hand.` Merge or
move one of them, then run install again. If a hook manager sets
`core.hooksPath`, install writes to that folder. If the manager rewrites the
folder later, run `vlite install` again. VerdictLite 0.1.15 has not been tested
with specific hook managers.

**The hooks stopped working after I moved VerdictLite or changed Node.**
The hooks call the exact `node` and `dist/cli.js` paths from install time. Run
`vlite install` again in each repo.

**My stamp does not count; the trailer says `none`.**
The staged tree must match the tree you stamped. Run `git add -A`, stamp again
and commit. Check that evidence files are ignored by git.

**The stop check is slow.**
It hashes the whole working tree each time and runs about 15 git commands. This adds a short wait before any check runs. The time is not measured yet. Large repos take
longer. Your checks add their own time.

**A check times out in the hook but not by hand.**
Raise `timeoutSec` for the check, and raise the Stop hook `timeout` in
`.claude/settings.json` above the total of your checks. A check that hits its
`timeoutSec` is shown as a warning ("froze, result unknown"), not as a failure.

**Run the stop check by hand.**
`vlite stop-check --session my-test` runs it without an agent app. It prints
the hook JSON, or nothing if it passes cleanly; a pass with a warning prints a
`systemMessage`.

**Uninstall.**

```sh
vlite connect --uninstall
vlite install --uninstall
```

`vlite connect --uninstall` removes the user-level Claude Code and Codex hooks.
`vlite install --uninstall` removes VerdictLite's git hooks and puts back any
`.vlite-prev` hooks. Then delete `vlite.json` if you like, and delete the repo's
folder under `~/.verdictlite/`. Remove the `vlite stop-check` entry from each
guarded repo's `.claude/settings.json` or `.claude/settings.local.json`, if you
added one. On a Windows install, delete
`%LOCALAPPDATA%\VerdictLite` and remove its `bin` folder from your user PATH. To
remove the command from a source install, run `npm unlink -g verdictlite` and
delete the clone.

## 15. Config reference: vlite.json

`vlite.json` is a JSON object. Unknown top-level keys are an error that names the key. A bad value stops the
command with a list of every error. An old `prChecks` field is ignored with a
one-line warning.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `version` | number | required | Must be `1`. |
| `base` | string | `"origin/main"` | The base branch ref. Used for the merge-base, for review rules, and to look for the config. |
| `docs` | list of globs | `[]` | Files that count as docs. |
| `codeDespiteDocs` | list of globs | `[]` | Files that match `docs` but count as code. |
| `parts` | list | `[]` | Areas of the repo and their checks. See below. |
| `parts[].name` | string | required | Name shown in messages, as `name/check`. |
| `parts[].paths` | list of globs | required, at least one | A changed file matching one of these runs the part. A path with `{name}` makes the part a template. See [Part templates](#part-templates). |
| `parts[].requires` | list of paths | `[]` | Paths, from the repo root, that must exist for the part to run. If one is missing and the base branch does not have it either, the part is skipped, `stop.jsonl` says why, and a warning line is shown. If the base branch has it (the change deleted it), the part fails as `part/requires`. |
| `parts[].cwd` | string | `"."` | Folder, from the repo root, where checks run. |
| `parts[].checks` | list | required, at least one | The checks, run in order. |
| `checks[].name` | string | required | Check name. |
| `checks[].run` | string | required | Command line. Runs through the shell: `cmd.exe` on Windows, `sh` elsewhere. |
| `checks[].runFiles` | string | none | Optional narrow form of `run`. Must contain `{files}`. Used when only test files changed since the part last passed. See [rerun only the tests that changed](#how-to-rerun-only-the-tests-that-changed). |
| `checks[].cwd` | string | the part's `cwd` | Folder for this check. |
| `checks[].timeoutSec` | number | `600` | Seconds before the check is killed. A timeout is no result: no round, no block, no pass. |
| `tests.paths` | list of globs | `[]` | Test files for the tamper check. |
| `tests.files` | list of globs | `**/test_*.py`, `**/*_test.py`, `**/*.test.*`, `**/*.spec.*`, `**/*_test.go` | Which files under `tests.paths` are real test files. Narrow mode runs only when every changed file under `tests.paths` matches one. |
| `tests.removalsLog` | string | `"TEST-REMOVALS.md"` | Where removed tests are written down. |
| `maxRounds` | whole number | `3` | The failing round that hands off to a person. Counted per session and branch. |
| `maxExpandedParts` | whole number | `12` | The most parts one template may make in one stop check. |
| `gate.mode` | `"off"`, `"observe"`, `"enforce"` | `"observe"` | Commit gate mode. |
| `review.command` | string | `"claude"` | Reviewer command. The env var `VLITE_REVIEW_CMD` overrides it. |
| `review.args` | list of strings | `["-p"]` | Arguments for the reviewer. |
| `review.rulesFile` | string | `"REVIEW.md"` | Rules file, read from the base branch. |
| `review.timeoutSec` | number | `900` | Seconds before the review is stopped. |

**Globs.** Paths are matched from the repo root with `/` as the separator.

- `**` matches any number of folders, including none. `**/*.md` matches
  `README.md` and `docs/a/b.md`.
- `*` matches any text inside one name. `src/*.js` matches `src/a.js` but not
  `src/lib/a.js`.
- `?` matches one character.
- `dir/**` matches everything under `dir`.
- `{a,b}` matches either name, as in `**/*.{spec,test}.ts`.

A file is docs when it matches `docs` and does not match `codeDespiteDocs`.

**A full example:**

```json
{
  "version": 1,
  "base": "origin/main",
  "docs": ["**/*.md", "docs/**", "LICENSE*"],
  "codeDespiteDocs": ["**/SKILL.md", ".claude/**", "REVIEW.md"],
  "parts": [
    { "name": "backend", "paths": ["app/**/*.py", "tests/**"], "cwd": ".",
      "checks": [ { "name": "lint", "run": "uv run ruff check .", "timeoutSec": 300 },
                  { "name": "tests", "run": "uv run pytest -q -x", "timeoutSec": 900 } ] },
    { "name": "web", "paths": ["web/**"], "cwd": "web",
      "checks": [ { "name": "typecheck", "run": "pnpm tsc --noEmit" },
                  { "name": "tests", "run": "pnpm vitest run" } ] }
  ],
  "tests": { "paths": ["tests/**", "**/*.spec.ts", "**/*.test.ts"], "removalsLog": "TEST-REMOVALS.md" },
  "maxRounds": 3,
  "gate": { "mode": "observe" },
  "review": { "command": "claude", "args": ["-p", "--model", "sonnet"], "rulesFile": "REVIEW.md", "timeoutSec": 900 }
}
```

### Part templates

A part with `{name}` in its `paths` is a template. VerdictLite makes one part
for each module that changed. `{name}` stands for one folder name.

- `{name}` must be a whole folder name, like `src/{name}/**`.
  `src/lib_{name}/**` is an error.
- Every path of a template part needs `{name}`. So does its `name`, so each
  module's part has its own name.
- `{name}` is filled in the part's `name`, `paths`, `requires` and `cwd`, and
  in each check's `run`, `runFiles` and `cwd`. Other text in braces is left
  alone.
- `{name}` in a part whose paths have no `{name}` is an error. `{name}` is the
  only placeholder. A brace token without a comma, such as `{...}`, in `paths`
  is an error.
- The changed file must be inside the folder. With `src/{name}/**`,
  `src/a/x.py` gives `a`. `src/x.py` gives nothing.
- **Safe names only.** The folder name goes into a shell command. It is used
  only when it starts with a letter or digit and has only letters, digits,
  `_`, `.` and `-`. Any other folder name (with spaces, `;`, `$`, quotes and so
  on) does not match the template, and nothing runs for it.
- Each module runs once, even when files in several of its paths changed.
  Modules run in name order.
- **Limit.** If more than `maxExpandedParts` modules (default 12) changed for
  one template, none of them run. This is a warning, not a failure. The other
  checks still run. If they pass, the stop is allowed and a message lists the
  modules that were not checked. If another check fails, the block message
  ends with the same note. No stop-check stamp is written, because not
  everything was checked. Run the wider check by hand, or raise the limit on
  the base branch.

### How to: run the tests of the module that changed

Say your code is in `civiccast/<module>/` and each module's tests are in
`tests/<module>/`. A fixed check runs the same tests for every change. A
template runs only the tests of the module that changed:

```json
{ "name": "backend:{name}",
  "paths": ["civiccast/{name}/**", "tests/{name}/**"],
  "requires": ["tests/{name}"],
  "cwd": ".",
  "checks": [ { "name": "tests", "run": "uv run --no-sync pytest tests/{name} -q -x", "timeoutSec": 600 } ] }
```

- A change to `civiccast/egress/net.py` runs `pytest tests/egress`. Messages
  call the part `backend:egress`.
- A change in two modules runs both test folders.
- A module with no `tests/<module>` folder is skipped. `requires` does this.
  The `stop.jsonl` line says
  `"skipped": {"backend:foo": "requires missing: tests/foo"}`, and a warning
  line is shown.
- A file right in `civiccast/` is in no module, so this part does not run for
  it. Add a plain part for those files if they need checks.

### How to: rerun only the tests that changed

A stop check normally reruns every check of every changed part. When an agent
only fixes a few test files, that can mean the whole test suite on every turn.
A check can opt in to a narrow form with `runFiles`:

```json
{ "name": "tests",
  "run": "uv run --no-sync pytest tests/{name} -q -x",
  "runFiles": "uv run --no-sync pytest {files} -q -x" }
```

- `runFiles` must contain `{files}`. A config without it is an error. In a
  template part, `{name}` is filled as in `run`.
- The narrow form runs only when this part's checks all passed on an earlier
  stop, and since then every changed file in the part is a test file
  (`tests.paths`) or a docs file, with at least one test file. If any product
  file in the part changed, the checks run as before.
- Every changed file under `tests.paths` must also be a real test file: it must
  match `tests.files`. The default is `**/test_*.py`, `**/*_test.py`,
  `**/*.test.*`, `**/*.spec.*` and `**/*_test.go`. A helper, fixture or
  `conftest.py` under `tests.paths` forces the full check.
- A narrow pass writes no `stop-check` stamp, so it is not commit proof. The
  message says the commit gate needs a full check or `vlite stamp verify`.
- `{files}` becomes the changed test files that still exist, each quoted, as
  paths from the check's folder. A deleted test file is listed as "deleted, not
  run". If every changed test file was deleted, the check runs in full.
- A check with no `runFiles` runs in full, and the message says so in one line.
- The message names the test files that ran. A block says the rest of the
  part's tests were skipped because product code is unchanged since the last
  pass of that part. `stop.jsonl` has `narrow` and `deleted`.
- The test-tamper check and the round count work as before.

### How to: rerun only the tests that failed

When a check that has `runFiles` fails, the agent should fix those tests and
rerun only those tests, not the whole suite. The full run stays for CI and
commit proof.

- VerdictLite reads the failed tests from the output and saves them for that
  branch and check. It knows pytest (`FAILED <id>` and `ERROR <path>` lines, the
  ` - message` part is dropped) and vitest or jest (` FAIL <file>`, the file is
  kept). It strips colours first.
- It saves nothing when the format is unknown, when no test is named, when more
  than 50 tests failed, or when an id starts with `-`, has a line break, or
  names a file that does not exist. The next stop then runs narrow or full as usual.
- The block message adds one line: fix these tests, then check the fix by
  running only this command (the `runFiles` command with the ids). Do not run
  the full test suite; CI runs it.
- At the next stop, a check with saved tests runs `runFiles` with only those
  tests. This comes before the "only test files changed" mode. Other checks in
  the part run as before. If a saved file is gone, the saved ids are dropped and
  the check then runs narrow or full as usual.
- If they still fail, it is a normal failure: the round counts and the new
  failed tests are saved. If the command fails but names no test (for example
  when the runner exits with code 5), the full check runs at once in the same
  stop and that result counts.
- If they pass, the agent sees a warning that names the tests, says the full
  check did not run, and says CI or `vlite stamp verify` gives the full proof.
  This is not a pass: no stamp is written, the start point does not move, and
  the part is not marked as passed. The same tree repeats the warning and runs
  nothing. The saved tests are cleared, so the next stop on a changed tree starts the check again:
  in full, or in narrow mode if only test files changed since the part last
  passed.
- A real full pass clears the saved tests of the branch.
- The limit: a command with `-x` stops at the first failure, so it records one
  test at a time.

## 16. Command reference

Commands that work on a repo take `--repo DIR`. The default is the current
folder.

| Command | What it does |
|---|---|
| `vlite install [--claude] [--uninstall]` | Writes or removes the git hooks. `--claude` prints the Stop hook settings. |
| `vlite connect [--claude] [--codex] [--uninstall]` | Adds the Stop hook to the Claude Code and Codex desktop apps (user level). With no flag it does both. `--uninstall` removes only the hooks that `vlite connect` wrote. It makes a backup of each file before it changes it. |
| `vlite stop-check [--session ID] [--global]` | The Stop hook for Claude Code and Codex. Reads the hook's JSON on stdin. Always exits 0 and speaks through JSON on stdout. With `--session` it does not read stdin, for runs by hand. With `--global` it checks the repos the session edited (user-level hook). |
| `vlite stamp <verify\|code-review> --result <pass\|fail> [--evidence PATH ...] [--note TEXT]` | Writes a stamp for the current working tree. `--evidence` can be given more than once. |
| `vlite gate pre-commit` | Called by the `pre-commit` hook. Records the method. Never blocks. |
| `vlite gate commit-msg FILE` | Called by the `commit-msg` hook. Blocks in `enforce` mode and adds the trailer. |
| `vlite gate report [--days N]` | Prints the gate report. |
| `vlite review [--base REF] [--round-note TEXT]` | Runs one AI review round. |
| `vlite require-org [NAME \| --remove NAME \| --list]` | Says that every repo of a GitHub org must have a `vlite.json`. `NAME` adds an org. `--remove NAME` removes it. `--list`, or no argument, shows the list. |

Environment variables:

- `VLITE_HOME`: where state lives. Default `~/.verdictlite`.
- `CODEX_HOME`: where Codex keeps `hooks.json` and `config.toml`. Default
  `~/.codex`.
- `VLITE_REVIEW_CMD`: replaces `review.command`.
- `VLITE_REVIEWER`: set to `1` by VerdictLite for the reviewer; the stop check
  does nothing in that session.

## 17. FAQ

**Does VerdictLite prove my code is correct?**
No. It proves that your checks ran on this exact set of files and passed, or
that someone said so. The checks are only as good as the ones you write.

**Can the agent cheat?**
Yes, if it tries. It can write a stamp by hand, commit with `git commit
--no-verify`, or get around the tamper regexes. VerdictLite makes these choices
visible in the logs and the commit trailers. It does not make them impossible.

**Why read the config from the base branch?**
So a change cannot weaken the checks that judge it. A feature branch that edits
`vlite.json` or `REVIEW.md` is still judged by the base branch copy.

**Does it work with agents other than Claude Code?**
The commit gate, stamps and review are plain git hooks and CLI commands. They
work with any agent or person. The stop check is a Stop hook that runs in
Claude Code and Codex, and the test-tamper check runs inside the stop check.
Other agents do not get the Stop hook automatically; they get the commit gate,
and `vlite stamp` / `vlite review` are CLI commands any agent can run. You can
still run `vlite stop-check --session NAME` by hand. In Codex, VerdictLite checks
the repo the session opened in, plus any repo that blocked on its last stop. It
cannot use the Codex log to find other repos. A repo with `vlite stop-check` in
`.claude/settings.json` counts as covered and is not checked.

**Does it send my code anywhere?**
Only `vlite review` does, and only to the review command you set (by default
the `claude` CLI). The other commands run on your machine.

**Do I have to use `vlite review`?**
No. A `verify` stamp alone gives the method `verify`.

**Is this made by Anthropic?**
No. It is an independent project that follows a method Anthropic's Claude Code
team described in public.

**What state is the project in?**
Early. Version 0.1.15 is the fifteenth fix to the first release (0.1.0), built on 2026-11-21. It has 268
automated tests (6 run on Windows only); the rest run on Ubuntu and Windows in CI. It is being set up on its first
real repo now. Expect changes. Report problems at
<https://github.com/scottconverse/verdictlite/issues>.
