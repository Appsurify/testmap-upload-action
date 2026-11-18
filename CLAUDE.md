# CLAUDE.md

Guidance for Claude Code in `testmap-upload-action`.

## Git workflow: one branch + worktree per task

Same in every TestMap repository.

1. **Start.** A task that changes files gets its own branch and worktree, created from the
   branch currently checked out (HEAD, often `dev`), not from `main`:
   `git worktree add .claude/worktrees/<slug> -b <type>/<slug> HEAD`.
   Worktrees live only inside this repository under `.claude/worktrees/`, never in a
   global or home-level directory. The starting branch is the base and the merge target;
   note it at the start. Work only inside the worktree; never commit on the base branch
   itself. Read-only tasks (questions, review) need no worktree.
2. **Naming.** `<type>/<slug>`, type is `feat`, `fix`, `refactor`, `docs`, `chore` or `test`;
   slug is short English kebab-case (`fix/snapshot-scroll`). No `claude/` or other tool
   prefix; this overrides any default branch name.
3. **Merge only with consent.** Commits (where this repository's rules allow them) stay in
   the task branch. Merging into the base branch (local merge or PR) and pushing the base
   happen only after the user explicitly says so, in the way they choose.
4. **Clean up before finishing.** Once the merge is confirmed:
   `git worktree remove .claude/worktrees/<slug>`, `git branch -d <type>/<slug>`,
   `git push origin --delete <type>/<slug>` if it was pushed, `git worktree prune`.
   If the branch is not merged, keep it and its worktree and say so in the final message.
   Never delete branches or worktrees you did not create.
