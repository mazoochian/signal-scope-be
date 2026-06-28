# Claude Code – Working Conventions

## Branch rules

- **Never commit directly to `main`.** All work goes on a dedicated branch.
- Branch naming: `claude/<short-task-slug>` (e.g. `claude/fix-wan-chart`, `claude/add-device-delete`).
- Create the branch at the start of the session if it doesn't already exist:
  ```bash
  git checkout -b claude/<task-slug>
  ```
- Open a pull request against `main` when the work is ready for review. The human merges.

## Reviewing human branches

When asked to review a branch the human has pushed:
1. `git fetch origin`
2. `git diff main...origin/<branch>` to see all changes
3. Leave findings as inline PR comments (`/code-review --comment`) or as a written summary — never silently push fixes without being asked.
4. If fixes are requested, commit them to the **same branch**, not a new one.

## Commit style

- Commit messages: short imperative summary line, then a blank line and a body if the why isn't obvious.
- Always append the co-author trailer:
  ```
  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
  ```
- Prefer small, focused commits over large squashes.

## General

- Ask before touching files outside the current task's scope.
- Do not force-push or rebase branches that have already been pushed to origin.
