---
name: reply-pr
description: Write and post a GitHub comment on the user's behalf, with the required model-attribution callout. Triggers on "reply to this comment", "respond to the reviewer", "post a comment on the PR", "leave a review comment", "resolve the thread". Not for PR descriptions, commit messages, or text the user wants posted verbatim.
---

# reply-pr

Use this skill for every comment you post to GitHub as the user: PR comments, inline review comments, replies to bots or humans, and written reasons for dismissing a finding. Skip PR descriptions, commit messages, and text the user gave you to post verbatim; post that unchanged.

## Format

Open every comment with a callout. Put the reply after it, outside the callout.

```
> [!NOTE]
> Replying as <model> for <user>.

<reply>
```

- `<model>` is the model name the harness reports. If the harness reports none, use the harness name. Never guess.
- `<user>` is the login of the account that will post: `gh api user -q .login`.

## Write the reply

- Put the verdict first: fixed, declined, disagree, question, or done.
- Cite the code or output that supports it. Use `path:line`, a commit SHA, or a short quoted log.
- Keep it short. Skip thanks, praise, and filler.
- Mark fact and opinion. Say "I checked X and it returns Y" for fact. Say "I think" for opinion.
- When you decline a finding, give one concrete reason and name the follow-up if there is one.

## Before posting

1. Scan the text for secrets, tokens, internal hostnames, local paths, emails, and private project names. Remove them.
2. Check the Markdown against the callout template above, and check that the links resolve.
3. Confirm the target: right repo, right PR number, right thread.

## Post

Use `gh`. Write the body to a file to keep quoting safe.

```
gh pr comment <pr> --repo <owner>/<repo> --body-file <file>
gh api repos/<owner>/<repo>/pulls/<pr>/comments/<id>/replies -F body=@<file>
```

For a review thread, reply through the thread so the comment stays attached to its code.

## After posting

- Confirm GitHub returned a comment URL. If it did not, the post failed. Report that and retry once.
- Resolve a thread only after your reply is posted, and not one a human opened unless the fix landed and you said so in the reply.
- List thread ids, then resolve with the thread's `id`:
  ```
  gh api graphql -f query='query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$n){reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{databaseId path body}}}}}}}' -f owner=<owner> -f repo=<repo> -F n=<pr>
  gh api graphql -f query='mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{isResolved}}}' -f threadId=<id>
  ```
