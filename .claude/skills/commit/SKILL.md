---
name: commit
description: Commit the current changes with a concise description (60 chars or less). Use when the user asks to commit their work.
---

# Commit

Commit the current working changes.

## Steps

1. Run `git status` and `git diff` (and `git diff --staged`) to review what has changed.
2. Check if any updates to the README.md are likely needed or wanted for the changes, ask for confirmation before modifying it.
3. Stage the relevant changes with `git add`.
4. Write a commit message that describes the changes in **60 characters or less**.
5. Commit with that message.

## Rules

- The commit message must be **60 characters or less**.
- Do **not** add any attribution or co-authorship line (no "Co-Authored-By", "Generated with", "Co-created by", etc.).
- Do **not** push. Stop after committing.
