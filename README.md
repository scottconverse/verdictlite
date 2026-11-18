# VerdictLite (`vlite`)

VerdictLite helps AI coding agents prove their work before they stop or commit.
It puts the method from the Anthropic article "How the Claude Code team thinks
about verification" into daily use in a git repo.

You install it once on the machine. It lives outside the repo it judges.
So a change cannot edit the check that judges it.
It also reads its config and review rules from the base branch, not from the
working tree, for the same reason.

## Install

Node 20 or newer and git are needed. There are no runtime dependencies.

```sh
git clone <this repo> C:/tools/verdictlite
cd C:/tools/verdictlite
pnpm install
pnpm build
# optional: put vlite on PATH
pnpm link --global
```

Then, in the repo you want to guard:

```sh
vlite install --claude
```

## The five commands

### `vlite install [--repo DIR] [--claude] [--uninstall]`

Writes two git hooks: `pre-commit` and `commit-msg`.
It respects `core.hooksPath`.
If a hook is already there and is not ours, it is kept as
`<name>.vlite-prev`. It runs first. If it fails, the commit stops with its
exit code. Running install again is safe. `--uninstall` puts the old hooks
back.

The hooks call this exact `node` and `dist/cli.js`, so they work without
`vlite` on PATH.

`--claude` prints (it does not write) the snippet for `.claude/settings.json`
that adds the Claude Code Stop hook `vlite stop-check`.

### `vlite stop-check`

The Claude Code Stop hook. It runs when the agent wants to stop.

1. It works out the tree id of the whole working tree.
   If this tree already passed, it exits at once.
2. It finds the changed files since the last pass on this branch
   (or since the merge-base with the base branch).
3. A docs-only change passes.
4. It always runs the built-in `test-tamper` check (see below).
5. It runs the checks of every part whose `paths` match a changed file.
   It stops at the first failing check of a part, but still runs other parts.
6. All pass: it records the pass.
   Something fails: it blocks the stop and tells the agent what failed, the
   command, the exit code and the last 60 lines of output.
   It says "Round N of 3. Fix the cause. Do not skip, sleep or rerun to pass."
7. After 3 failing rounds it stops blocking. It ends the session with a
   message that a person must look, and writes a handoff file.

If the tool itself breaks, it logs the error and lets the agent stop.
It never fails open on a failing check.

Run by hand: `vlite stop-check --session my-test`.

### `vlite stamp <verify|code-review> --result <pass|fail> [--evidence PATH ...] [--note TEXT]`

Writes down that a check ran on the current working tree.
Evidence files must exist.

### `vlite gate <pre-commit | commit-msg FILE | report [--days N]>`

The hooks call `pre-commit` and `commit-msg`. You call `report`.

At commit time, the gate looks for a pass stamp on the exact tree being
committed. The method is `verify`, `code-review`, `verify+code-review`,
`docs` (docs-only change), `skipped` (see below) or `none`.
It adds a trailer to the commit message, for example `Verified-By: verify`.
Other trailers stay as they are.

Gate modes (in `vlite.json`):

- `off`: do nothing.
- `observe`: never block. Log what would have been blocked. Start here.
- `enforce`: block a commit with method `none`.
  - To skip on purpose, add the trailer `Verify-Skip: <reason>`. The reason is logged.
  - After two blocks in 30 minutes, the third try goes through. It is logged
    as an escape. This stops a person from being locked out.

`vlite gate report --days 7` shows counts per method, would-blocks,
blocks, escapes and skip reasons.

### `vlite review [--base REF] [--round-note TEXT]`

Runs one AI reviewer (by default `claude -p --model sonnet`) on the diff from
the merge-base to the working tree.

- The rules come from `REVIEW.md` on the base branch, never from the working tree.
- The diff is cut at 200 KB, and the prompt says so.
- Earlier rounds on the same branch go into the prompt, so each round builds on the last.
- The reviewer must answer in strict JSON. Each finding needs a file and a line.
- No `important` findings: a `code-review` pass stamp is written. Exit 0.
- Any `important` finding: no stamp. Exit 2.
- A reply that is not the JSON asked for: exit 1. The raw reply is saved.

The env var `VLITE_REVIEW_CMD` replaces the command (used in tests).

## The built-in `test-tamper` check

The article's rule: no skip, no sleep, no rerun. A deleted test must be written down.
On changed test files it looks at added and removed lines and fails on:

- added skip markers: `@pytest.mark.skip`, `pytest.skip(`, `@unittest.skip`,
  `xfail`, `it.skip`, `test.skip`, `describe.skip`, `xit(`, `test.fixme`;
- added fixed waits: `time.sleep(`, `asyncio.sleep(`, `waitForTimeout(`,
  `setTimeout` used as a wait;
- added retries: `@flaky`, `pytest.mark.flaky`, `--reruns`, or a raised
  `retries:` value (also in Playwright, Vitest, Jest and pytest config files);
- removed tests (`def test_*`, `it("...")`, `test("...")`) that are not added
  again somewhere in the change. A removal is fine only if the test name is in
  an added line of the removals log (`TEST-REMOVALS.md` by default).

The detectors are simple regular expressions. They can miss things and they
can be wrong. The message says the file, the line and what to do.

## Config: `vlite.json`

Put it in the repo and merge it to the base branch.

```json
{
  "version": 1,
  "base": "origin/main",
  "docs": ["**/*.md", "docs/**", "LICENSE*"],
  "codeDespiteDocs": ["**/SKILL.md", ".claude/**", "REVIEW.md"],
  "parts": [
    { "name": "backend", "paths": ["app/**/*.py", "tests/**"], "cwd": ".",
      "checks": [ { "name": "lint", "run": "uv run ruff check .", "timeoutSec": 300 },
                  { "name": "tests", "run": "uv run pytest -q -x", "timeoutSec": 900 } ] }
  ],
  "prChecks": [ { "name": "full-suite", "run": "uv run pytest", "cwd": ".", "timeoutSec": 3600 } ],
  "tests": { "paths": ["tests/**", "**/*.spec.ts", "**/*.test.ts"], "removalsLog": "TEST-REMOVALS.md" },
  "maxRounds": 3,
  "gate": { "mode": "observe" },
  "review": { "command": "claude", "args": ["-p", "--model", "sonnet"], "rulesFile": "REVIEW.md", "timeoutSec": 900 }
}
```

- The config is read from the base ref (`origin/main`, then `main`).
- If the base has no `vlite.json` yet, the working-tree copy is used.
  Every log line then says `"configSource": "worktree"` and a warning is printed.
- No config anywhere: every command exits 0 and does nothing.
- Globs: `**` is any number of folders, `*` is any text in one name, `?` is one character.
  They match from the repo root.
- A file is docs when it matches `docs` and does not match `codeDespiteDocs`.
- Check commands run through the shell (`cmd.exe` on Windows, `sh` elsewhere),
  in `cwd` from the repo root.
- `prChecks` is checked for errors but not run by any command yet.

## Where state lives

`~/.verdictlite/<repo-id>/` (set `VLITE_HOME` to move it).
The repo id is the repo folder name plus a short hash of the git common dir,
so all worktrees of one repo share it.

- `state.json`: last passing tree per branch, round counters, pending gate records.
- `stamps.jsonl`, `gate.jsonl`, `stop.jsonl`: append-only logs with ISO times.
- `handoffs/`: full output of failing checks.
- `reviews/<branch>/<n>.json`: each review round.

## Honest limits

- A stamp shows that a step was run and said "pass". It does not prove the step
  was good. VerdictLite is a speed bump, not proof.
- Anyone can write a stamp by hand, or commit with `--no-verify`.
- The tamper detectors are regular expressions. They are easy to get around on purpose.
- The tree id hashes the whole working tree on each stop. On a large repo this takes time.
- Each stop-check makes about 15 git calls. On Windows that is about 1 to 2 seconds before any check runs.
- The Stop hook depends on Claude Code's hook format (`decision`/`reason`,
  `continue`/`stopReason`). If that format changes, this tool must change too.

## Develop

```sh
pnpm install
pnpm lint    # tsc --noEmit, strict
pnpm build   # tsc to dist/
pnpm test    # builds, then vitest; tests make throwaway repos in the OS temp dir
```
