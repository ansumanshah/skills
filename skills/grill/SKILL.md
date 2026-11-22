---
name: grill
description: Interview a user to settle a plan, design, decision, or idea. Use for "grill me", "poke holes in this", "stress-test my plan", "interview me about this", or before building from fuzzy requirements.
---

# Grill

## Build the decision tree

Challenge the premise once at the start: is this the right problem to solve?
Make that a root decision. Recommend a problem and outcome, with a reason.
Record each decision with an ID, prerequisites, status, and answer.
Record explicit choices already made as settled. Turn remaining assumptions into open nodes.
Attach prerequisites before asking about scope, constraints, tradeoffs, or success checks.
Treat unresolved facts as prerequisites too.
The askable set is every open decision whose prerequisites are settled.
Finish this step when every known open choice has a node and dependencies.

## Own the fact finding

Answer factual questions from the repo, tools, docs, or web.
Use a fresh-context subagent for lookups when the harness provides one.
Give it a narrow question and the sources it needs. Otherwise, look up facts directly.
While a lookup runs, ask the questions that do not depend on its result.
Ask the user for choices; bring evidence for facts.
Finish each lookup by recording its source and settling the factual prerequisite.

## Ask one complete round

Ask the whole askable set in one numbered round.
Give each question a short title, real options where available, and a recommendation.
Put the recommendation in the question so that "yes" accepts it.
Give one line of reasoning for each recommendation.
Use this copyable format for independent questions:

```text
Round 2
1. Audience: Start with operators? Options: operators / customers.
   Recommended: operators, because they own the task today.
2. Output: Start with a report? Options: report / automatic action.
   Recommended: report, because the input quality is unproven.
Reply: yes to all but 2; 2 = automatic action.
```

Wait for the user's answers. A recommendation alone leaves its node open.
Apply answers to the tree, settle nodes, and add newly exposed decisions.
Keep ambiguous answers open. Recompute the askable set for the next round.
Ask dependent questions in a later round, even if a prerequisite appears in this round.
When an answer conflicts with prior answers, code, or evidence, show the conflict next round.
Cite the conflict, recommend a resolution, and reopen affected decisions.
Finish a round when the tree accounts for each answer and remaining dependency.

## Confirm the settled plan

Finish interviewing when every decision is settled and every assumption is resolved.
Summarize every decision in one line each. Ask the user to confirm the full summary.
Begin implementation only after that confirmation.
Check where the project keeps decisions, such as ADRs or `docs/decisions/`.
Offer to save the summary there only if that location already exists.
