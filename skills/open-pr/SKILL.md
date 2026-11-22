---
name: open-pr
description: Create a pull request for the current branch, or edit an existing PR's title, body, or test plan. Triggers on "open a PR", "create a pull request", "push and open a PR", "update the PR description", "fix the PR title", "submit this for review".
---

# open-pr

Open or update a PR for the current branch. Post any comment through [reply-pr](../reply-pr).

## Steps

1. Look for an open PR on this branch. Reuse it instead of opening a second one. A merged or closed PR on the same branch is history: open a new PR for the new commits.
   ```
   gh pr list --head <branch> --state open --json number,state,url
   ```
2. Find the base. Diff the branch against it.
   ```
   git diff <base>...HEAD --stat
   ```
3. Read the diff. Confirm it matches the stated goal and nothing else. If it holds unrelated changes, leave them in the working tree and put only the intended ones on the PR branch. Never discard or revert the user's work to do it.
4. Scrub the title, body, and diff of secrets, tokens, private URLs, local paths, and personal data.
5. Push the branch. Open the PR as a real PR, not a draft, so bots and CI run.
6. Print the PR URL.

## Title

- Check the repo's convention first: `gh pr list --state merged --limit 10 --json title`.
- If the repo has none, use `<type>: <description>` with type feat, fix, refactor, docs, test, chore, perf, or ci.
- State the effect a user or reader sees, not the mechanism.
  - Weak: `fix: add null check in session loader`
  - Strong: `fix: stop crash when a saved session has no title`

## Body

Write three parts in this order.

1. The problem, in the user's own words. Quote or closely paraphrase what they said. One to three sentences.
2. The fix, in one or two sentences.
3. A test plan.

```
## Test plan
- [x] Ran `<command>`: <result>
- [ ] Reviewer: check <thing only a human can check>
```

Tick items you ran this session. Leave items for the reviewer open. Do not tick what you did not run. Add a model credit line only if the repo or the user asks for one.

## Size

Hold the PR to its goal. Decline these with a reason, and list them as follow-ups:

- extra tests beyond the change
- guards for rare cases
- compatibility shims nobody asked for
- micro-performance edits

Re-run the diff check after every push.

## Rate limit fallback

If `gh pr create` fails with a GraphQL rate-limit error, use REST with a body file. `gh api rate_limit` shows when the limit resets.

```
gh api repos/{owner}/{repo}/pulls -f title="<title>" -f head="<branch>" -f base="<base>" -F body=@<file>
```

To edit an existing PR use `gh pr edit` or `gh api -X PATCH repos/{owner}/{repo}/pulls/<n>`.

## Hand off

- If the user asked you to watch the PR, hand off to [watch-pr](../watch-pr).
- If you are inside [ship-pr](../ship-pr) or [ready-pr](../ready-pr), return to that skill.
