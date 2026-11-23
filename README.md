# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Lubitzy/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Lubitzy/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

One patch tool for every AI edit format.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>

# mend

One patch tool for every AI edit format.

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats, and `mend` reads all four to one specification
(`SPEC.md` in the kit that ships this tool's tests):

- unified diffs (often with wrong line numbers),
- SEARCH/REPLACE blocks,
- the V4A patch format,
- text-editor tool calls as JSON.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the path of the patch file, relative to the working directory.
  When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

## Matching

Old lines are found at the first of three tiers at which they occur:

- tier 0: every line equal,
- tier 1: every line equal once trailing spaces and tabs are removed,
- tier 2: every line equal once leading and trailing spaces and tabs are
  removed (new lines are re-indented to the file's indentation).

## Output and exit codes

- Exit 0: the tree is written. One line per changed path (`A`, `D`, `M`, or
  `R old -> new` for a move), then `ok: <n> files`.
- Exit 1: one `error: <code> <path>` line per failed edit, then
  `failed: <k> of <n> edits`. When any edit fails, no file is written.
- Exit 2: one line only: `error: usage`, `error: no-patch`, `error: format`,
  or `error: parse <N>`.

## Requirements

Node 22 and its standard library alone. No dependencies, no network, no
model calls. Deterministic: the same run always gives the same exit code,
output and files.

## License

MIT. See `LICENSE`.
