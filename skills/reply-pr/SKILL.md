---
name: reply-pr
description: Write and post any GitHub comment on the user's behalf, with the required model-attribution callout. Use for PR comments, inline review comments, replies to bots or humans, and written reasons for dismissing a review finding. Triggers on "reply to this comment", "respond to the reviewer", "post a comment on the PR", "answer CodeRabbit", "dismiss this finding", "resolve the thread", "leave a review comment". Does not apply to PR descriptions, commit messages, or text the user wants posted verbatim.
---

# reply-pr

Use this skill for every comment you post to GitHub as the user. Other skills ([open-pr](../open-pr), [watch-pr](../watch-pr), [second-opinion](../second-opinion), [panel-review](../panel-review), [ship-pr](../ship-pr), [ready-pr](../ready-pr), [take-over](../take-over), [stale-pr](../stale-pr)) route their comments here.

## Scope

- Covers: PR comments, inline review comments, replies to bots, reasons for dismissing a finding.
- Skips: PR descriptions, commit messages, and text the user gave you to post verbatim. Post that text unchanged.

## Format

Open every comment with a callout. Put the reply after it, outside the callout.

```
> [!NOTE]
> Replying as <model> for <user>.

<reply>
```

- `<model>` is the model name the harness reports. If the harness reports none, use the harness name. Never guess.
- `<user>` is the GitHub login of the account that will post.

## Write the reply

- Put the verdict first: fixed, declined, disagree, question, or done.
- Cite the code or output that supports it. Use `path:line`, a commit SHA, or a short quoted log.
- Keep it short. Skip thanks, praise, and filler.
- Mark what is fact and what is opinion. Say "I checked X and it returns Y" for fact. Say "I think" for opinion.
- When you decline a finding, give one concrete reason and name the follow-up if there is one.

## Before posting

1. Scan the text for secrets, tokens, internal hostnames, local paths, emails, and private project names. Remove them.
2. Preview the final Markdown, callout included. Check that it renders as a callout and the links resolve.
3. Confirm the target: right repo, right PR number, right thread.

## Post

Use `gh`. Write the body to a file to keep quoting safe.

```
gh pr comment <pr> --repo <o/r> --body-file <file>
gh api repos/<o>/<r>/pulls/<pr>/comments/<id>/replies -F body=@<file>
```

For a review thread, reply through the thread so the comment stays attached to its code.

## After posting

- Confirm GitHub returned a comment URL. If it did not, the post failed. Report that and retry once.
- Resolve a thread only after your reply is posted. Never resolve first.
- Do not resolve threads a human opened unless the fix landed and you said so in the reply.
