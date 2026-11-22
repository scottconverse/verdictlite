# VerdictLite (`vlite`)

**Make the coding agent run the checks before it stops.**

VerdictLite is a small command-line tool for git repos. When a Claude Code
agent tries to stop, it runs your checks. It flags tests that were skipped or
deleted. At commit time it writes down how the change was verified.

- Website: <https://scottconverse.github.io/verdictlite/>
- User manual: [docs/manual.md](docs/manual.md) (also on the
  [website](https://scottconverse.github.io/verdictlite/manual.html))
- Version: 0.1.13. Early stage. See [Status](#status).

VerdictLite is an independent project. It is not made by, affiliated with or
endorsed by Anthropic.

## Contents

- [What it is and why](#what-it-is-and-why)
- [Install](#install)
- [Set up a repo, step by step](#set-up-a-repo-step-by-step)
- [The five commands](#the-five-commands)
- [Require VerdictLite in a GitHub org](#require-verdictlite-in-a-github-org)
- [Config reference: `vlite.json`](#config-reference-vlitejson)
- [Where state lives](#where-state-lives)
- [Honest limits](#honest-limits)
- [Status](#status)
- [Develop](#develop)
- [Credit](#credit)
- [License](#license)

## What it is and why

An AI coding agent can say "done" too early. It can stop or commit without
running the tests. When a test fails, it can be tempted to skip it, add a
sleep, add retries or delete it.

VerdictLite puts a simple check at each of those points:

| What goes wrong | What VerdictLite does |
|---|---|
| The agent stops without running the checks. | A Claude Code Stop hook (`vlite stop-check`) runs your checks for the parts of the repo that changed. If one fails, the stop is blocked and the agent gets the error. |
| A failing test gets skipped, slowed, retried or deleted. | A built-in test-tamper check looks at changed lines in test files. It flags added skips, fixed sleeps, retries and removed tests. |
| The agent tries the same broken fix forever. | Failed rounds are counted for each session and branch. After three, the session ends and a person is asked to look. |
| A commit gives no sign of how it was checked. | Git hooks add a `Verified-By:` line to every commit message. |
| A change loosens the rules that judge it. | The config and the review rules are read from the base branch, not from the change. The tool and its logs live outside the repo. The commands the config runs (package.json scripts, pyproject, ruff, mypy, eslint configs) come from the working tree. |

Two parts, two scopes:

- **The stop check** is a [Claude Code Stop hook](https://code.claude.com/docs/en/hooks).
  It needs Claude Code. The test-tamper check runs inside it.
- **The commit gate** is plain git hooks. It works with any agent and with
  people.

Here is real output when a test fails (test output and paths shortened):

```text
VerdictLite: checks failed on this change (repo .../shop).

[app/tests] failed
command: node --test
exit code 1
last lines of output:
not ok 1 - adds price times quantity
  ...
    9 !== 14
  ...

Full output: ~/.verdictlite/shop-1fc1e50e6f/handoffs/2026-11-19T04-51-44-727Z-round1.txt

Round 1 of 3. Fix the cause. Do not skip, sleep or rerun to pass.
```

## Install

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

Open a new terminal after it finishes. If it connected the apps, restart the
Claude and Codex apps. Codex runs a new hook only after you approve it. In
Codex, click **Review hooks** in the message box, or open **Settings > Hooks**.
The installer prints the approve step only when it connected the apps.

To connect or disconnect the apps later, run `vlite connect` or
`vlite connect --uninstall`. Add `--claude` or `--codex` to pick one app.
`--uninstall` always removes VerdictLite's entry from Codex `hooks.json`, also when
`config.toml` has a `[hooks]` table. If `config.toml` mentions `stop-check`, it
tells you to remove that hook by hand. `--uninstall` also writes
`connect-off.json` in the VerdictLite home, so the installer does not connect
again on its own. A plain `vlite connect` removes that marker.
If VerdictLite's own hook entry has an old path or timeout (for example after
you moved the install folder), `vlite connect` updates it, makes a backup and
says so. A hook command that is not VerdictLite's own is never changed.

**Codex limit:** VerdictLite checks only the repo that the Codex session opened
in. It cannot read the Codex log to find other repos that the session changed.

**To update:** run the installer again. It replaces the files in the same
folder, so the paths in your git hooks stay valid.

**To uninstall:** in each guarded repo, run `vlite install --uninstall` to
remove its hooks. Then delete the folder `%LOCALAPPDATA%\VerdictLite`. Last,
remove `%LOCALAPPDATA%\VerdictLite\bin` from your user PATH (Windows Settings,
search for "environment variables", then "Edit environment variables for your
account").

### From source (any OS)

You need git, [Node.js](https://nodejs.org/) 20 or newer, and
[pnpm](https://pnpm.io/installation). VerdictLite has no runtime dependencies.
It is **not on npm**. Install it from this repo.

Install it once per machine, in a folder **outside** the repos it checks. That
way a change in a repo cannot edit the tool that judges it. `vlite.json` is read from the base branch, but the commands it runs (package.json scripts, pyproject, ruff, mypy and eslint configs) come from the working tree, so a change can still edit what those commands do.

```sh
git clone https://github.com/scottconverse/verdictlite.git
cd verdictlite
pnpm install
pnpm build
npm link
```

`npm link` puts `vlite` on your PATH. Check it with `vlite --help`.

You can skip `npm link` and call `node /path/to/verdictlite/dist/cli.js`
instead. The git hooks do not need `vlite` on PATH.

To update from source: `git pull`, then `pnpm install` and `pnpm build`.

## Set up a repo, step by step

Do these steps in the repo you want to guard. The
[manual](docs/manual.md#3-set-up-a-repo) has more detail.

**1. Write `vlite.json`** in the repo root:

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

**2. Write `REVIEW.md`** (optional). It holds the rules for `vlite review`.
Give each rule a name, a trigger and what to check.

**3. Merge both files to the base branch.** VerdictLite reads them from the
base branch, so a feature branch cannot loosen the config. (The commands it runs still come from the working tree.) Until then it
uses the working-tree copy and prints:

```text
VerdictLite: vlite.json is not on the base branch yet; using the working-tree copy (bootstrap).
```

**4. Install the git hooks:**

```sh
vlite install --claude
```

This writes `pre-commit` and `commit-msg` hooks. A hook you already had is kept
as `<name>.vlite-prev` and runs first. `--claude` prints the Stop hook settings.
It does not write them.

**5. Add the Stop hook** to `.claude/settings.json` (or
`.claude/settings.local.json`). Merge it with what is there:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "vlite stop-check", "timeout": 3600 }
        ]
      }
    ]
  }
}
```

The timeout is in seconds. `vlite connect` and `vlite install --claude` both
write 3600. Checks run one at a time, so make the timeout longer than all your
checks together. `vlite install` prints a warning when the check timeouts in
`vlite.json` add up to more than 3600 s. A template part counts its checks
times `maxExpandedParts`. If the app kills the hook, no verdict is written.

A project hook loads only when a Claude Code session starts inside the repo.
If your sessions or agent workers start in another folder and edit the repo
from there, also add the hook to your user settings (`~/.claude/settings.json`)
with `--global`:

```json
{ "type": "command", "command": "vlite stop-check --global", "timeout": 3600 }
```

`--global` checks every repo with a `vlite.json` that the session edited with
its edit tools (Edit, Write, MultiEdit, NotebookEdit) since your last prompt.
It also checks the session folder's repo, unless that repo has its own project
hook. In folders and repos without a `vlite.json` it does nothing. Limit: a file
changed only by a shell command is not seen, unless the session started in that
repo.

**6. Add a verify skill** (recommended). A
[Claude Code skill](https://code.claude.com/docs/en/skills) at
`.claude/skills/verify/SKILL.md` tells the agent how to prove the change works
and then to record it:

```sh
git add -A
vlite stamp verify --result pass --evidence .verify/tests.log
```

Add `.verify/` to `.gitignore` so evidence files do not change the tree. The
[manual](docs/manual.md#step-6-add-a-verify-skill-recommended) has a full
example skill.

## The five commands

Every command takes `--repo DIR`. The default is the current folder.

### `vlite install [--claude] [--uninstall]`

Writes the `pre-commit` and `commit-msg` hooks. It respects `core.hooksPath`.
In a linked worktree the hooks go in the shared hooks folder. Running it again
is safe. The hooks call the exact `node` and `dist/cli.js` that ran install.

```sh
vlite install --claude      # install and print the Stop hook settings
vlite install --uninstall   # remove the hooks and restore old ones
```

### `vlite stop-check [--session ID] [--global]`

The Claude Code Stop hook. It runs when the agent tries to stop. With
`--global` (for the user-level hook) it does the steps below for each repo the
session edited this turn. It sends one combined message.

1. It works out the tree id (git's hash of the whole set of files) of the
   working tree. If this tree already passed on this branch, it lets the agent
   stop at once.
2. It lists the files changed since the last pass on this branch, or since the
   merge-base with the base branch.
3. A docs-only change passes.
4. If a changed file is a test file or a test-runner config file, it runs the
   built-in `test-tamper` check.
5. It runs the checks of every part whose `paths` match a changed file. The
   first failing check stops that part. Other parts still run. A template part
   runs once for each module that changed. See [Part templates](#part-templates).
   If a `requires` path is missing, the part is skipped, and every skipped part
   shows a warning line. If the base branch has that path and the change
   deleted it, the part fails with the check name `part/requires`, and it blocks.
   A skipped part is not recorded as a pass. The warning repeats at each stop on
   the same files, and the skipped files are judged again once the part can run.
6. All pass: it records the pass. Something fails: it blocks the stop and tells
   the agent the command, the exit code and the last 60 lines of output.
7. Rounds are counted for each session and branch, not for each set of failing
   checks. On round `maxRounds` (3 by default) it ends the session and asks for
   a person. Failures that take turns count together. After a hand-off, or a
   pass, the count starts again. Each failing round writes a hand-off file with
   up to 2,000 lines.

**A check that times out is no result.** It is not a failure. It does not count
a round, does not block, and never hands off. The part is not marked as passed.
If nothing else failed, VerdictLite does not record a pass and writes no stamp.
It logs `result: "no-result"` and shows a warning that names the check, says it
froze, says the result is unknown, and says the agent can continue. If another
check really failed, VerdictLite blocks or hands off on that failure only, and
the warning is added.

**Narrow mode only runs real test files.** When a part passed before and only
test files changed since, a check with `runFiles` runs just the changed test
files. Every changed file under `tests.paths` must match `tests.files`. A
helper, fixture or `conftest.py` there forces the full check. A narrow pass
writes no `stop-check` stamp, so it is not commit proof. The message says the
commit gate needs a full check or `vlite stamp verify`.

If VerdictLite itself breaks, it logs the error and lets the agent stop. A
failing check always blocks.

```sh
vlite stop-check --session my-test   # run it by hand, without Claude Code
```

A stop-check pass lets the agent stop. When at least one check ran in full (no
part was skipped and it was not a narrow run), it also writes a `stop-check` stamp for that exact tree, so a commit
of the same files shows `Verified-By: stop-check`. A pass where no check ran
(docs only, or files no part covers) writes no stamp.

If VerdictLite itself fails (a broken or mistyped `vlite.json`, a locked file), it still lets the agent stop, but it now says so: the hook prints a `systemMessage` that Claude Code shows to the person, and the text is added to any block or handoff. Unknown top-level keys in `vlite.json` are an error, so a typo such as `"part"` is caught.

### `vlite stamp <verify|code-review> --result <pass|fail> [--evidence PATH ...] [--note TEXT]`

Records that a check ran on the current working tree. Evidence files must
exist. The latest stamp for a tree wins.

```sh
git add -A
vlite stamp verify --result pass --evidence test-run.log --note "unit and e2e tests"
```

```text
Stamped verify pass for tree d922fdcc8ebb
```

### `vlite gate <pre-commit | commit-msg FILE | report [--days N]>`

The git hooks call `pre-commit` and `commit-msg`. You call `report`.

At commit time the gate picks a method for the exact tree being committed:

| Method | When |
|---|---|
| `docs` | Every staged change is a docs file. |
| `verify` | A `verify` pass stamp matches the tree. |
| `code-review` | A `code-review` pass stamp matches the tree. |
| `stop-check` | A passing Stop hook (`vlite stop-check`) ran on the same tree. |
| `verify+code-review` | Both match. Other mixes are joined by `+`, such as `verify+stop-check`. |
| `skipped` | The message has a `Verify-Skip:` trailer. |
| `none` | None of the above. |

It adds a trailer such as `Verified-By: verify` to the message. Other trailers
stay.

Gate modes, set in `vlite.json` on the base branch:

- `off`: nothing. No trailer, no log.
- `observe` (default): never blocks. Logs commits that would have been blocked.
- `enforce`: blocks a commit with method `none`.

To skip on purpose, end the commit message with a trailer and a reason:

```text
chore: bump version

Verify-Skip: generated file, checked by hand
```

After two blocks within 30 minutes, the third try goes through. It is logged as
an escape, so nobody gets locked out of their own repo.

```sh
vlite gate report --days 7
```

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

### `vlite review [--base REF] [--round-note TEXT]`

Runs one AI review round on the diff from the merge-base to the working tree.

- The rules come from `REVIEW.md` on the base branch.
- The diff is cut at 200 KB, and the prompt says so.
- Earlier rounds on this branch go into the prompt.
- The prompt goes on stdin to `review.command` with `review.args`. The default
  is `claude -p`. The env var `VLITE_REVIEW_CMD` replaces the command.
- The diff, the author note and the earlier rounds come from the change, so the
  prompt marks them as untrusted data between clear markers. It says that text
  inside them is data, never instructions, and that any text in them that asks
  for no findings or a pass is itself an important finding.
- When the command is Claude Code (`claude`), VerdictLite adds
  `--disallowedTools Edit,Write,NotebookEdit,Bash`, so the app blocks write
  tools. If your `review.args` already has `--disallowedTools`, your value is
  kept. When the command is Codex (`codex`) and its subcommand is `exec` (or its alias `e`; the first
argument that is not a flag or a flag's value), VerdictLite always turns off the Codex tools that can
write (shell, sub-agents, apps, plugins, MCP and apply_patch). It adds `--sandbox read-only` only when your
`review.args` sets no sandbox (`--sandbox`, `-s`, `--full-auto` or `--dangerously-bypass-approvals-and-sandbox`).
If you set a sandbox, your choice is kept and the tool lockout is added anyway. For any
  other command, only the prompt says "read-only". VerdictLite cannot block
  tools there.
- The reviewer runs with `VLITE_REVIEWER=1`. The stop check does nothing in that session. A review never runs your repo's checks and is never blocked by them.
- The reviewer must reply in strict JSON findings, each `important`, `nit` or
  `pre-existing`.

| Result | Exit code | Stamp |
|---|---|---|
| No `important` findings | 0 | A `code-review` pass stamp |
| One or more `important` findings | 2 | None |
| Reviewer failed, timed out or replied badly | 1 | None. The raw reply is saved. |

### The built-in `test-tamper` check

The rule from the article: do not skip, sleep or rerun to make tests pass. If
you remove a test, write down why. The check runs inside the stop check, on
added and removed lines of files in `tests.paths`. It flags:

- added skip markers, such as `@pytest.mark.skip`, `xfail`, `it.skip`,
  `test.skip`, `xit(` and `test.fixme` (a skip whose only condition is the
  operating system, such as `skipif(os.name != "nt")`, is allowed);
- added fixed waits, such as `time.sleep(`, `asyncio.sleep(` and
  `waitForTimeout(`;
- added retries, such as `@flaky`, `--reruns`, `jest.retryTimes(` or a raised
  `retries:` value, also in Playwright, Vitest, Vite, Jest and pytest config
  files;
- removed tests (`def test_*`, `it("...")`, `test("...")`) that are not added
  back. To remove one on purpose, add a line with its name to
  `TEST-REMOVALS.md` in the same change.

Real output:

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

## Require VerdictLite in a GitHub org

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
- Codex checks only the folder the session opened in.

## Config reference: `vlite.json`

Unknown top-level keys are an error that names the key. A bad value stops the command with a list of errors.
An old `prChecks` field is ignored with a one-line warning.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `version` | number | required | Must be `1`. |
| `base` | string | `"origin/main"` | The base branch ref. |
| `docs` | list of globs | `[]` | Files that count as docs. |
| `codeDespiteDocs` | list of globs | `[]` | Files that match `docs` but count as code. |
| `parts` | list | `[]` | Areas of the repo and their checks. |
| `parts[].name` | string | required | Shown in messages as `name/check`. |
| `parts[].paths` | list of globs | required, at least one | A changed file matching one of these runs the part. A path with `{name}` makes the part a template. |
| `parts[].requires` | list of paths | `[]` | Paths, from the repo root, that must exist for the part to run. If one is missing and the base branch does not have it either, the part is skipped, `stop.jsonl` says why, and a warning line is shown. If the base branch has it (the change deleted it), the part fails as `part/requires`. |
| `parts[].cwd` | string | `"."` | Folder, from the repo root, where checks run. |
| `parts[].checks` | list | required, at least one | Checks, run in order. |
| `checks[].name` | string | required | Check name. |
| `checks[].run` | string | required | Command line. Runs through `cmd.exe` on Windows, `sh` elsewhere. |
| `checks[].runFiles` | string | none | Optional narrow form of `run`. Must contain `{files}`. When the part passed before and only its test files changed since, only those test files run. See the manual, "How to: rerun only the tests that changed". |
| `checks[].cwd` | string | the part's `cwd` | Folder for this check. |
| `checks[].timeoutSec` | number | `600` | Seconds before the check is killed. A check that times out is no result, not a failure (see `vlite stop-check`). |
| `tests.paths` | list of globs | `[]` | Test files for the tamper check. |
| `tests.files` | list of globs | `**/test_*.py`, `**/*_test.py`, `**/*.test.*`, `**/*.spec.*`, `**/*_test.go` | Which files under `tests.paths` are real test files. Narrow mode runs only when every changed file under `tests.paths` matches one. |
| `tests.removalsLog` | string | `"TEST-REMOVALS.md"` | Where removed tests are written down. |
| `maxRounds` | whole number | `3` | The failing round that hands off to a person. Counted per session and branch. |
| `maxExpandedParts` | whole number | `12` | The most parts one template may make in one stop check. |
| `gate.mode` | `"off"`, `"observe"`, `"enforce"` | `"observe"` | Commit gate mode. |
| `review.command` | string | `"claude"` | Reviewer command. |
| `review.args` | list of strings | `["-p"]` | Arguments for the reviewer. |
| `review.rulesFile` | string | `"REVIEW.md"` | Rules file, read from the base branch. |
| `review.timeoutSec` | number | `900` | Seconds before the review is stopped. |

Notes:

- The config is read from `origin/main`, then `main`. If that copy names
  another `base` that has its own `vlite.json`, that copy is used.
- If the base has no `vlite.json` yet, the working-tree copy is used, a warning
  is printed and every log line says `"configSource": "worktree"`.
- With no config anywhere, every command exits 0 and does nothing.
- Globs match from the repo root. `**` is any number of folders, `*` is any
  text inside one name, `?` is one character.
- A file is docs when it matches `docs` and does not match `codeDespiteDocs`.

### Part templates

A part with `{name}` in its `paths` is a template. VerdictLite makes one part
for each module that changed. `{name}` stands for one folder name. This runs
only the tests of the module that changed:

```json
{ "name": "backend:{name}",
  "paths": ["civiccast/{name}/**", "tests/{name}/**"],
  "requires": ["tests/{name}"],
  "cwd": ".",
  "checks": [ { "name": "tests", "run": "uv run --no-sync pytest tests/{name} -q -x", "timeoutSec": 600 } ] }
```

- A change to `civiccast/egress/net.py` runs `pytest tests/egress`. Messages
  call the part `backend:egress`. A change in two modules runs both.
- `{name}` is filled in the part's `name`, `paths`, `requires` and `cwd`, and
  in each check's `run` and `cwd`. It must be a whole folder name. Every path
  and the `name` of a template part need it. Any other `{...}` in `paths` is an
  error.
- A module with no `tests/<module>` folder is skipped. `requires` does this,
  `stop.jsonl` says `"requires missing: tests/foo"`, and a warning line is shown.
- **Safe names only.** The folder name goes into a shell command. It is used
  only when it starts with a letter or digit and has only letters, digits,
  `_`, `.` and `-`. Any other folder name does not match, and nothing runs
  for it.
- **Limit.** If more than `maxExpandedParts` modules (default 12) changed for
  one template, none of them run. This is a warning, not a failure: the other
  checks still run, and VerdictLite tells you which modules were not checked.
  No stop-check stamp is written. Run the wider check by hand.

The [manual](docs/manual.md#how-to-run-the-tests-of-the-module-that-changed)
has the full rules.

## Where state lives

VerdictLite keeps nothing in your repo. Its state is in
`~/.verdictlite/<repo-folder>-<hash>/`. Set `VLITE_HOME` to move it. All
worktrees of one repo share the folder.

| File | What it holds |
|---|---|
| `state.json` | Last passing tree per branch (per worktree folder for a detached HEAD, reused only while the saved commit is still in HEAD's history), round counters, pending gate records, recent blocks. |
| `stop.jsonl` | One line per stop check. |
| `stamps.jsonl` | One line per stamp. |
| `gate.jsonl` | One line per gate decision. |
| `handoffs/` | Full output of each failing stop-check round. |
| `reviews/<branch>/<n>.json` | Each review round. |

Delete the folder to reset VerdictLite for a repo.

## Honest limits

- **It does not prove your code is right.** It shows that your checks ran on
  this exact set of files. The checks are only as good as the ones you write.
- **A stamp shows that a step ran. It is a speed bump, not proof.** Anyone can
  write a stamp by hand, and `git commit --no-verify` skips git hooks.
  VerdictLite makes these choices visible. It does not make them impossible.
- **The stop check needs Claude Code.** Other agents get the commit gate only.
  The tamper check runs inside the stop check.
- **The tamper check is simple.** It uses regular expressions. It can miss
  things and can flag lines that are fine. A renamed test counts as removed.
- **If the tool itself breaks, it lets the agent stop.** It logs an error.
- **The config must be on `origin/main` or `main`.** A default branch with
  another name, such as `master`, is not searched in 0.1.13.
- **`vlite review` sends your diff** to the review command you set (by default
  the `claude` CLI). The other commands run only on your machine.
- **Speed.** Each stop check hashes the whole working tree and runs about 15
  git commands. This adds a short wait before any check runs. The time is not measured yet.
- **Hook format.** The stop check depends on Claude Code's Stop hook output
  format (`decision`/`reason`, `continue`/`stopReason`). If that changes,
  VerdictLite must change too.
- **Hook managers.** 0.1.13 has not been tested with specific git hook managers.

## Status

Early. Version 0.1.13 is the thirteenth fix to the first release (0.1.0), built on 2026-11-21. It is being set
up on its first real repo now. Expect changes.

- 240 automated tests (4 of them run on Windows only). CI runs lint, build and tests on Ubuntu and Windows.
- Not published to npm.
- Report problems at <https://github.com/scottconverse/verdictlite/issues>.

## Develop

```sh
pnpm install
pnpm lint    # tsc --noEmit, strict
pnpm build   # tsc to dist/
pnpm test    # builds, then vitest; tests make throwaway repos in the OS temp dir
```

The website is plain HTML and CSS in `docs/`. GitHub Pages publishes it from
`main` with `.github/workflows/pages.yml`.

## Credit

VerdictLite follows the method in
[How the Claude Code team thinks about verification](https://claude.dev/blog/how-the-claude-code-team-thinks-about-verification/)
by Addy Osmani (November 16, 2026).

VerdictLite is not made by, affiliated with or endorsed by Anthropic. Claude
and Claude Code are products of Anthropic.

## License

Apache-2.0. See [LICENSE](LICENSE).
