# VerdictLite (`vlite`)

**Make the coding agent run the checks before it stops.**

VerdictLite is a small command-line tool for git repos. When a Claude Code
agent tries to stop, it runs your checks. It flags tests that were skipped or
deleted. At commit time it writes down how the change was verified.

- Website: <https://scottconverse.github.io/verdictlite/>
- User manual: [docs/manual.md](docs/manual.md) (also on the
  [website](https://scottconverse.github.io/verdictlite/manual.html))
- Version: 0.1.0. Early stage. See [Status](#status).

VerdictLite is an independent project. It is not made by, affiliated with or
endorsed by Anthropic.

## Contents

- [What it is and why](#what-it-is-and-why)
- [Install](#install)
- [Set up a repo, step by step](#set-up-a-repo-step-by-step)
- [The five commands](#the-five-commands)
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
| The agent tries the same broken fix forever. | Failed rounds are counted. After three, the session ends and a person is asked to look. |
| A commit gives no sign of how it was checked. | Git hooks add a `Verified-By:` line to every commit message. |
| A change loosens the rules that judge it. | The config and the review rules are read from the base branch, not from the change. The tool and its logs live outside the repo. |

Two parts, two scopes:

- **The stop check** is a [Claude Code Stop hook](https://code.claude.com/docs/en/hooks).
  It needs Claude Code. The test-tamper check runs inside it.
- **The commit gate** is plain git hooks. It works with any agent and with
  people.

Here is real output when a test fails (test output shortened):

```text
VerdictLite: checks failed on this change.

[app/tests] failed
command: node --test
exit code 1
last lines of output:
not ok 1 - adds price times quantity
  ...
    11 !== 14
  ...

Full output: ~/.verdictlite/shop-ea1973230c/handoffs/2026-11-18T18-13-44-751Z-round1.txt

Round 1 of 3. Fix the cause. Do not skip, sleep or rerun to pass.
```

## Install

You need git, [Node.js](https://nodejs.org/) 20 or newer, and
[pnpm](https://pnpm.io/installation). VerdictLite has no runtime dependencies.
It is **not on npm**. Install it from this repo.

Install it once per machine, in a folder **outside** the repos it checks. That
way a change in a repo cannot edit the tool that judges it.

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

To update: `git pull`, then `pnpm install` and `pnpm build`.

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
base branch, so a feature branch cannot loosen its own checks. Until then it
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

The timeout is in seconds. Make it longer than all your checks together.

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

### `vlite stop-check [--session ID]`

The Claude Code Stop hook. It runs when the agent tries to stop.

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
6. All pass: it records the pass. Something fails: it blocks the stop and tells
   the agent the command, the exit code and the last 60 lines of output.
7. On round 3 of the same failure it ends the session and asks for a person.
   Each failing round writes a hand-off file with up to 2,000 lines.

If VerdictLite itself breaks, it logs the error and lets the agent stop. A
failing check always blocks.

```sh
vlite stop-check --session my-test   # run it by hand, without Claude Code
```

A stop-check pass is not a stamp. It lets the agent stop. It does not mark the
commit as verified.

### `vlite stamp <verify|code-review> --result <pass|fail> [--evidence PATH ...] [--note TEXT]`

Records that a check ran on the current working tree. Evidence files must
exist. The latest stamp for a tree wins.

```sh
git add -A
vlite stamp verify --result pass --evidence test-run.log --note "unit and e2e tests"
```

```text
Stamped verify pass for tree b37dc8b45064
```

### `vlite gate <pre-commit | commit-msg FILE | report [--days N]>`

The git hooks call `pre-commit` and `commit-msg`. You call `report`.

At commit time the gate picks a method for the exact tree being committed:

| Method | When |
|---|---|
| `docs` | Every staged change is a docs file. |
| `verify` | A `verify` pass stamp matches the tree. |
| `code-review` | A `code-review` pass stamp matches the tree. |
| `verify+code-review` | Both match. |
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
Commits judged: 4
  verify: 1
  docs: 1
  none: 1
  skipped: 1
Would have been blocked (observe): 1
Blocked (enforce): 0
Let through after two blocks (escape): 0
Overrides (Verify-Skip): 1
  2026-11-18 18:13  generated file, checked by hand
```

### `vlite review [--base REF] [--round-note TEXT]`

Runs one AI review round on the diff from the merge-base to the working tree.

- The rules come from `REVIEW.md` on the base branch.
- The diff is cut at 200 KB, and the prompt says so.
- Earlier rounds on this branch go into the prompt.
- The prompt goes on stdin to `review.command` with `review.args`. The default
  is `claude -p`. The env var `VLITE_REVIEW_CMD` replaces the command.
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
  `test.skip`, `xit(` and `test.fixme`;
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
tests/price.test.js:5 [skip] test.skip('adds price times quantity', () => {
  -> Remove the skip or xfail. Fix the test or the code instead.
tests/price.test.js:9 (old line) [removed-test] test('rounds to cents', () => {
  -> Test "rounds to cents" was removed. Restore it, or add a line to TEST-REMOVALS.md with its name and why it was removed.
```

## Config reference: `vlite.json`

Unknown keys are ignored. A bad value stops the command with a list of errors.
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
| `parts[].requires` | list of paths | `[]` | Paths, from the repo root, that must exist for the part to run. If one is missing, the part is skipped and `stop.jsonl` says why. |
| `parts[].cwd` | string | `"."` | Folder, from the repo root, where checks run. |
| `parts[].checks` | list | required, at least one | Checks, run in order. |
| `checks[].name` | string | required | Check name. |
| `checks[].run` | string | required | Command line. Runs through `cmd.exe` on Windows, `sh` elsewhere. |
| `checks[].cwd` | string | the part's `cwd` | Folder for this check. |
| `checks[].timeoutSec` | number | `600` | Seconds before the check is killed and fails. |
| `tests.paths` | list of globs | `[]` | Test files for the tamper check. |
| `tests.removalsLog` | string | `"TEST-REMOVALS.md"` | Where removed tests are written down. |
| `maxRounds` | whole number | `3` | The failing round that hands off to a person. |
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
  and `stop.jsonl` says `"requires missing: tests/foo"`.
- **Safe names only.** The folder name goes into a shell command. It is used
  only when it starts with a letter or digit and has only letters, digits,
  `_`, `.` and `-`. Any other folder name does not match, and nothing runs
  for it.
- **Limit.** If more than `maxExpandedParts` modules (default 12) changed for
  one template, none of them run. A check named
  `<template name> (too many parts)` fails and lists them. Run the wider check
  by hand.

The [manual](docs/manual.md#how-to-run-the-tests-of-the-module-that-changed)
has the full rules.

## Where state lives

VerdictLite keeps nothing in your repo. Its state is in
`~/.verdictlite/<repo-folder>-<hash>/`. Set `VLITE_HOME` to move it. All
worktrees of one repo share the folder.

| File | What it holds |
|---|---|
| `state.json` | Last passing tree per branch, round counters, pending gate records, recent blocks. |
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
  another name, such as `master`, is not searched in 0.1.0.
- **`vlite review` sends your diff** to the review command you set (by default
  the `claude` CLI). The other commands run only on your machine.
- **Speed.** Each stop check hashes the whole working tree and runs about 15
  git commands. This adds a short wait before any check runs. The time is not measured yet.
- **Hook format.** The stop check depends on Claude Code's Stop hook output
  format (`decision`/`reason`, `continue`/`stopReason`). If that changes,
  VerdictLite must change too.
- **Hook managers.** 0.1.0 has not been tested with specific git hook managers.

## Status

Early. Version 0.1.0 is the first release, built on 2026-11-18. It is being set
up on its first real repo now. Expect changes.

- 111 automated tests. CI runs lint, build and tests on Ubuntu and Windows.
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
