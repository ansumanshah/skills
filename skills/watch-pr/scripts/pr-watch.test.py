#!/usr/bin/env python3
"""Offline tests for pr-watch. No gh process or network access is allowed."""

import sys

sys.dont_write_bytecode = True

import argparse
import copy
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import call, patch


loader = importlib.machinery.SourceFileLoader("pr_watch", str(Path(__file__).with_name("pr-watch")))
spec = importlib.util.spec_from_loader(loader.name, loader)
watcher = importlib.util.module_from_spec(spec)
loader.exec_module(watcher)


def snapshot(**changes):
    result = {
        "headRefOid": "abc123", "baseRefName": "main", "state": "OPEN",
        "mergeStateStatus": "CLEAN", "reviewDecision": "APPROVED",
        "author": {"login": "pr-author"}, "viewer": "agent",
        "url": "https://github.com/owner/repo/pull/7", "checks": [],
        "required": [], "comments": [], "reviews": [], "threads": [],
    }
    result.update(changes)
    return result


def check(name="test", status="pass", **changes):
    result = {"name": name, "bucket": status,
              "state": {"pass": "SUCCESS", "fail": "FAILURE", "pending": "IN_PROGRESS",
                        "skipping": "SKIPPED", "cancel": "CANCELLED"}[status],
              "link": f"https://example.test/checks/{name}"}
    result.update(changes)
    return result


def comment(identity="C1", login="reviewer", **changes):
    result = {"id": identity, "author": {"login": login}, "body": "Please look here.",
              "url": f"https://example.test/comments/{identity}"}
    result.update(changes)
    return result


def remembered():
    return {"initialized": True, "seen": []}


class OfflineTest(unittest.TestCase):
    def setUp(self):
        # A missed mock must fail locally instead of launching gh.
        self.process_guard = patch.object(watcher.subprocess, "run",
                                          side_effect=AssertionError("external process forbidden"))
        self.process_guard.start()
        self.addCleanup(self.process_guard.stop)


class EvaluationTests(OfflineTest):
    def test_no_checks_grace(self):
        memory = {}
        for now in (0, 30, 89):
            self.assertEqual(watcher.evaluate(snapshot(), memory, "green", now), ([], None))
        self.assertEqual(watcher.evaluate(snapshot(), memory, "green", 90), ([], 0))
        self.assertEqual(watcher.NO_CHECKS_GRACE, 90)

    def test_push_resets_grace(self):
        memory = {}
        watcher.evaluate(snapshot(), memory, "green", 0)
        self.assertEqual(watcher.evaluate(snapshot(), memory, "green", 90)[1], 0)
        pushed = snapshot(headRefOid="new-head")
        self.assertIsNone(watcher.evaluate(pushed, memory, "green", 100)[1])
        self.assertIsNone(watcher.evaluate(pushed, memory, "green", 130)[1])
        self.assertEqual(watcher.evaluate(pushed, memory, "green", 190)[1], 0)

    def test_failure_printed_once(self):
        memory = remembered()
        failed = snapshot(checks=[check(status="fail")])
        lines, code = watcher.evaluate(failed, memory, "green", 0)
        failures = [line for line in lines if line.startswith("check failed:")]
        self.assertEqual(code, 1)
        self.assertEqual(len(failures), 1)
        self.assertIn("test", failures[0])
        self.assertIn("https://example.test/checks/test", failures[0])
        self.assertEqual(watcher.evaluate(failed, memory, "green", 30), ([], 1))

    def test_required_checks_ignore_other_failures(self):
        memory = {}
        data = snapshot(required=["build"], checks=[check("build"), check("lint", "fail")])
        self.assertEqual(watcher.evaluate(data, memory, "green", 0), ([], None))
        self.assertEqual(watcher.evaluate(data, memory, "green", 30), ([], 0))

    def test_unresolved_thread_blocks_ready_with_url(self):
        data = snapshot(threads=[{"isResolved": False, "comments": [comment()]}])
        lines, code = watcher.evaluate(data, {}, "ready", 0)
        self.assertEqual(code, 1)
        self.assertEqual(len(lines), 1)
        self.assertIn("unresolved thread", lines[0])
        self.assertIn("https://example.test/comments/C1", lines[0])

    def test_first_run_baseline_then_new_comment(self):
        memory = {}
        data = snapshot(comments=[comment("old")])
        self.assertEqual(watcher.evaluate(data, memory, "change", 0), ([], None))
        data["comments"].append(comment("new"))
        lines, code = watcher.evaluate(data, memory, "change", 30)
        self.assertEqual(code, 0)
        self.assertEqual(lines, ["comment by reviewer: https://example.test/comments/new"])

    def test_author_viewer_and_ci_comments_ignored(self):
        logins = ["PR-AUTHOR", "AGENT", "github-actions", "github-actions[bot]",
                  "vercel", "netlify[bot]", "some-deploy[bot]", "dependabot"]
        data = snapshot(comments=[comment(str(i), login) for i, login in enumerate(logins)])
        self.assertEqual(watcher.evaluate(data, remembered(), "change", 0), ([], None))

    def test_merged(self):
        for until in ("green", "ready", "change"):
            with self.subTest(until=until):
                lines, code = watcher.evaluate(snapshot(state="MERGED"), remembered(), until, 0)
                self.assertEqual(code, 0)
                self.assertIn("PR merged:", lines[0])

    def test_check_waves_require_two_matching_polls(self):
        memory = {}
        data = snapshot(checks=[check("build")])
        self.assertIsNone(watcher.evaluate(data, memory, "green", 0)[1])
        data["checks"].append(check("test", "pending"))
        self.assertIsNone(watcher.evaluate(data, memory, "green", 30)[1])
        data["checks"][1] = check("test")
        self.assertIsNone(watcher.evaluate(data, memory, "green", 60)[1])
        self.assertEqual(watcher.evaluate(data, memory, "green", 90)[1], 0)

    def test_order_and_links_do_not_change_stability(self):
        memory = {}
        data = snapshot(checks=[check("build"), check("test")])
        watcher.evaluate(data, memory, "green", 0)
        data["checks"].reverse()
        data["checks"][0]["link"] = "https://example.test/new-link"
        self.assertEqual(watcher.evaluate(data, memory, "green", 30)[1], 0)

    def test_changed_head_requires_two_polls_even_with_same_checks(self):
        memory = {}
        data = snapshot(checks=[check()])
        watcher.evaluate(data, memory, "green", 0)
        watcher.evaluate(data, memory, "green", 30)
        data["headRefOid"] = "new"
        self.assertIsNone(watcher.evaluate(data, memory, "green", 60)[1])

    def test_required_check_not_registered_never_green(self):
        for checks in ([], [check("unrelated")]):
            with self.subTest(checks=checks):
                memory = {}
                data = snapshot(required=["required"], checks=checks)
                watcher.evaluate(data, memory, "green", 0)
                self.assertIsNone(watcher.evaluate(data, memory, "green", 120)[1])

    def test_skipped_passes_cancelled_fails(self):
        memory = {}
        data = snapshot(checks=[check(status="skipping")])
        watcher.evaluate(data, memory, "green", 0)
        self.assertEqual(watcher.evaluate(data, memory, "green", 30)[1], 0)
        self.assertEqual(watcher.evaluate(snapshot(checks=[check(status="cancel")]),
                                          {}, "green", 0)[1], 1)

    def test_review_bot_checks_only_gate_when_required(self):
        for bot in ("Greptile", "MACROSCOPE", "CodeRabbit"):
            with self.subTest(bot=bot):
                memory = {}
                data = snapshot(checks=[check(), check(bot, "pending")])
                watcher.evaluate(data, memory, "green", 0)
                self.assertEqual(watcher.evaluate(data, memory, "green", 30)[1], 0)
                data["required"] = [bot]
                self.assertIsNone(watcher.evaluate(data, memory, "green", 60)[1])

    def test_ready_waits_for_greptile_macroscope_but_not_coderabbit(self):
        for bot in ("Greptile review", "Macroscope", "CodeRabbit"):
            with self.subTest(bot=bot):
                memory = {}
                data = snapshot(checks=[check(), check(bot, "pending")])
                watcher.evaluate(data, memory, "ready", 0)
                expected = 0 if bot == "CodeRabbit" else None
                self.assertEqual(watcher.evaluate(data, memory, "ready", 30)[1], expected)
                data["checks"][1] = check(bot, "fail")
                watcher.evaluate(data, memory, "ready", 60)
                self.assertEqual(watcher.evaluate(data, memory, "ready", 90)[1], 0)

    def test_advisory_bot_result_is_reported(self):
        data = snapshot(checks=[check("CodeRabbit", "fail"), check("build", "pending")])
        lines, code = watcher.evaluate(data, remembered(), "green", 0)
        self.assertIsNone(code)
        self.assertEqual(len(lines), 1)
        self.assertIn("review check fail: CodeRabbit", lines[0])

    def test_summary_counts_once_per_head(self):
        memory = remembered()
        data = snapshot(checks=[check(), check("skip", "skipping")])
        lines, _ = watcher.evaluate(data, memory, "change", 0)
        self.assertEqual(lines, ["checks finished on abc123: 1 pass, 1 skipping"])
        self.assertEqual(watcher.evaluate(data, memory, "change", 30), ([], None))

    def test_reviews_and_thread_comments_ignore_edits(self):
        memory = remembered()
        reviews = [comment("R1", state="APPROVED", body=""),
                   comment("R2", state="CHANGES_REQUESTED", body=""),
                   comment("R3", state="COMMENTED"),
                   comment("R4", state="COMMENTED", body="")]
        data = snapshot(reviews=reviews, threads=[{"isResolved": True, "comments": [comment("T1")]}])
        original = copy.deepcopy(data)
        lines, code = watcher.evaluate(data, memory, "change", 0)
        self.assertEqual(len(lines), 4)
        self.assertEqual(code, 0)
        self.assertEqual(data, original)
        reviews[0]["body"] = "edited"
        reviews[1]["state"] = "DISMISSED"
        reviews[3]["body"] = "added by editing an existing review"
        data["threads"][0]["comments"][0]["body"] = "edited too"
        self.assertEqual(watcher.evaluate(data, memory, "change", 30), ([], None))

    def test_links_are_not_truncated_and_events_have_one_line(self):
        url = "https://example.test/" + "x" * 200
        data = snapshot(comments=[comment(login="reviewer\nname", url=url)])
        lines, code = watcher.evaluate(data, remembered(), "change", 0)
        self.assertEqual(code, 0)
        self.assertEqual(lines, [f"comment by reviewer name: {url}"])

    def test_review_bots_comments_are_events(self):
        for bot in ("greptile[bot]", "macroscope[bot]", "coderabbitai[bot]"):
            with self.subTest(bot=bot):
                lines, code = watcher.evaluate(snapshot(comments=[comment(login=bot)]),
                                                remembered(), "change", 0)
                self.assertEqual(code, 0)
                self.assertEqual(len(lines), 1)

    def test_dirty_closed_and_ready_blockers(self):
        for data, until, expected in [
                (snapshot(mergeStateStatus="DIRTY"), "green", 1),
                (snapshot(state="CLOSED"), "green", 1),
                (snapshot(mergeStateStatus="BEHIND"), "ready", 1),
                (snapshot(reviewDecision="CHANGES_REQUESTED"), "ready", 1),
                (snapshot(mergeStateStatus="BEHIND"), "green", None)]:
            with self.subTest(data=data, until=until):
                memory = remembered()
                lines, code = watcher.evaluate(data, memory, until, 0)
                self.assertEqual(code, expected)
                self.assertTrue(lines)
                self.assertFalse(watcher.evaluate(data, memory, until, 30)[0])

    def test_change_exits_zero_for_first_printed_event(self):
        lines, code = watcher.evaluate(snapshot(checks=[check(status="fail")]),
                                        remembered(), "change", 0)
        self.assertTrue(lines)
        self.assertEqual(code, 0)

    def test_ready_waits_while_merge_state_unknown(self):
        memory = remembered()
        data = snapshot(checks=[check()], mergeStateStatus="UNKNOWN")
        self.assertEqual(watcher.evaluate(data, memory, "ready", 0)[1], None)
        self.assertEqual(watcher.evaluate(data, memory, "ready", 30)[1], None)
        clean = snapshot(checks=[check()], mergeStateStatus="CLEAN")
        self.assertEqual(watcher.evaluate(clean, memory, "ready", 60)[1], 0)


class TransportTests(OfflineTest):
    def result(self, code=0, stdout="[]", stderr=""):
        return subprocess.CompletedProcess(["gh"], code, stdout, stderr)

    def test_transient_retry_backoff(self):
        with patch.object(watcher.subprocess, "run", side_effect=[
                self.result(1, stderr="HTTP 503"), self.result(1, stderr="HTTP 429"),
                self.result(1, stderr="connection reset"), self.result()]) as run, \
                patch.object(watcher.time, "sleep") as sleep, patch("sys.stderr", new_callable=io.StringIO):
            self.assertEqual(watcher.gh(["api", "test"]), "[]")
            self.assertEqual(sleep.call_args_list, [call(2), call(4), call(8)])
            self.assertEqual(run.call_count, 4)
            self.assertEqual(run.call_args.args[0], ["gh", "api", "test"])
            self.assertNotIn("shell", run.call_args.kwargs)

    def test_timeout_retries_then_raises(self):
        with patch.object(watcher.subprocess, "run", side_effect=subprocess.TimeoutExpired("gh", 60)), \
                patch.object(watcher.time, "sleep") as sleep, patch("sys.stderr", new_callable=io.StringIO):
            with self.assertRaises(watcher.GitHubError):
                watcher.gh(["api", "test"])
            self.assertEqual(sleep.call_args_list, [call(2), call(4), call(8)])

    def test_nontransient_error_not_retried(self):
        with patch.object(watcher.subprocess, "run", return_value=self.result(1, stderr="not logged in")) as run:
            with self.assertRaises(watcher.GitHubError):
                watcher.gh(["api", "test"])
            self.assertEqual(run.call_count, 1)

    def test_checks_exit_codes_and_no_checks(self):
        for code in (0, 1, 8):
            with self.subTest(code=code), patch.object(watcher.subprocess, "run", return_value=self.result(code)):
                self.assertEqual(watcher.gh_json(["pr", "checks"], allowed=(0, 1, 8)), [])
        with patch.object(watcher.subprocess, "run", return_value=self.result(1, "", "no checks reported on 'branch'")):
            self.assertEqual(watcher.gh_json(["pr", "checks"], allowed=(0, 1, 8), empty_checks=True), [])

    def test_invalid_json_is_github_failure(self):
        with patch.object(watcher.subprocess, "run", return_value=self.result(stdout="<html>")):
            with self.assertRaises(watcher.GitHubError):
                watcher.gh_json(["api", "test"])

    def test_check_named_no_checks_reported_is_not_discarded(self):
        checks = [check("no checks reported regression", "fail")]
        result = self.result(1, json.dumps(checks))
        with patch.object(watcher.subprocess, "run", return_value=result):
            self.assertEqual(watcher.gh_json(["pr", "checks"], allowed=(0, 1, 8),
                                              empty_checks=True), checks)

    def test_required_protection_403_404_and_branch_encoding(self):
        for code in (403, 404):
            with self.subTest(code=code), patch.object(watcher, "gh_json", side_effect=watcher.GitHubError(f"HTTP {code}")), \
                    patch.object(watcher, "gh", side_effect=watcher.GitHubError(f"HTTP {code}")):
                self.assertEqual(watcher.required_checks("o/r", "release/next"), [])
        with patch.object(watcher, "gh_json", return_value=["build"]) as gh_json, \
                patch.object(watcher, "gh", return_value="security\nbuild\n") as gh:
            # Classic protection and rulesets are merged, so a ruleset-only check still gates.
            self.assertEqual(watcher.required_checks("o/r", "release/next"), ["build", "security"])
            self.assertIn("release%2Fnext", gh_json.call_args.args[0][1])
            self.assertIn("repos/o/r/rules/branches/release%2Fnext", gh.call_args.args[0])

    def test_truncated_threads_block_ready(self):
        thread = {"isResolved": True, "comments": {"pageInfo": {"hasNextPage": False}, "nodes": []}}
        graph = {"data": {"repository": {"pullRequest": {"reviewThreads": {
            "pageInfo": {"hasNextPage": True}, "nodes": [thread]}}}}}
        with patch.object(watcher, "gh_json", side_effect=[[check()], graph]):
            polled = watcher.fetch_snapshot("o/r", 7, snapshot(), "agent", [])
        self.assertTrue(polled["truncated"])
        memory = {}
        watcher.evaluate(polled, memory, "ready", 0)
        lines, code = watcher.evaluate(polled, memory, "ready", 100)
        self.assertEqual(code, 1)

    def test_fetch_snapshot_has_two_calls_plus_separate_view(self):
        thread = {"isResolved": False, "comments": {"nodes": [comment()]}}
        graph = {"data": {"repository": {"pullRequest": {"reviewThreads": {"nodes": [thread]}}}}}
        with patch.object(watcher, "gh_json", side_effect=[snapshot(), [check()], graph]) as gh_json:
            view = watcher.view_pr("o/r", 7)
            result = watcher.fetch_snapshot("o/r", 7, view, "agent", ["test"])
            self.assertEqual(gh_json.call_count, 3)
            self.assertEqual(result["threads"][0]["comments"], [comment()])
            args = gh_json.call_args_list[2].args[0]
            self.assertIn("number=7", args)
            self.assertIn("query=" + watcher.THREAD_QUERY, args)

    def test_graphql_partial_errors_are_poll_failure(self):
        with patch.object(watcher, "gh_json", side_effect=[[], {"errors": [{"message": "timeout"}]}]):
            with self.assertRaises(watcher.GitHubError):
                watcher.fetch_snapshot("o/r", 7, snapshot(), "agent", [])


class StateAndCliTests(OfflineTest):
    def test_state_roundtrip_only_keeps_event_memory(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            memory = remembered()
            watcher.evaluate(snapshot(comments=[comment()]), memory, "change", 0)
            watcher.save_state(path, memory)
            loaded = watcher.load_state(path, path.stat().st_mtime)
            self.assertNotIn("head", loaded)
            self.assertEqual(watcher.evaluate(snapshot(comments=[comment()]), loaded, "change", 30), ([], None))
            self.assertEqual(list(Path(directory).iterdir()), [path])

    def test_stale_and_corrupt_state_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            self.assertEqual(watcher.load_state(path, 0), {})
            path.write_text("invalid json")
            self.assertEqual(watcher.load_state(path, 0), {})
            path.write_text(json.dumps(remembered()))
            now = path.stat().st_mtime
            self.assertTrue(watcher.load_state(path, now + watcher.STATE_MAX_AGE))
            self.assertEqual(watcher.load_state(path, now + watcher.STATE_MAX_AGE + 1), {})

    def test_failed_atomic_replace_preserves_old_state_and_cleans_temp(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            path.write_text("original")
            with patch.object(watcher.os, "replace", side_effect=OSError("disk error")):
                with self.assertRaises(OSError):
                    watcher.save_state(path, remembered())
            self.assertEqual(path.read_text(), "original")
            self.assertEqual(list(Path(directory).iterdir()), [path])

    def test_lock_reports_pid_and_releases(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "nested" / "state.json"
            with watcher.hold_lock(path):
                with self.assertRaisesRegex(watcher.LockHeld, f"pid {os.getpid()}"):
                    with watcher.hold_lock(path):
                        self.fail("second lock acquired")
            with watcher.hold_lock(path):
                self.assertEqual(path.with_suffix(".lock").read_text(), str(os.getpid()))

    def test_url_repo_precedence_and_defaults(self):
        for suffix in ("", "/", "/files", "/commits", "/checks"):
            with self.subTest(suffix=suffix):
                args = watcher.parse_args([f"https://github.com/Owner/Repo/pull/7{suffix}", "--repo", "ignored/repo"])
                self.assertEqual((args.repo, args.pr, args.until, args.every), ("Owner/Repo", 7, "green", 30))
        with patch.dict(os.environ, {"XDG_STATE_HOME": "/tmp/test-state"}):
            self.assertEqual(str(watcher.state_path(args.repo, args.pr)),
                             "/tmp/test-state/pr-watch/owner__repo__7.json")

    def test_bad_arguments(self):
        for args in (["0"], ["-1"], ["7", "--every", "9"], ["7", "--every", "nan"],
                     ["7", "--every", "inf"], ["7", "--repo", "../repo"],
                     ["7", "--repo", ""], ["7", "--repo", "owner/.."],
                     ["https://example.test/o/r/pull/7"], ["7", "--until", "maybe"]):
            with self.subTest(args=args), patch("sys.stderr", new_callable=io.StringIO):
                with self.assertRaises(SystemExit) as error:
                    watcher.parse_args(args)
                self.assertEqual(error.exception.code, 2)

    def test_repo_inference_and_lock_main(self):
        with patch.object(watcher, "gh_json", return_value={"nameWithOwner": "o/r"}) as gh_json, \
                tempfile.TemporaryDirectory() as directory, \
                patch.dict(os.environ, {"XDG_STATE_HOME": directory}), \
                patch.object(watcher, "watch", return_value=0) as watch:
            self.assertEqual(watcher.main(["7"]), 0)
            gh_json.assert_called_once_with(["repo", "view", "--json", "nameWithOwner"])
            self.assertEqual(watch.call_args.args[0].repo, "o/r")
            path = watcher.state_path("o/r", 7)
            with watcher.hold_lock(path), patch("sys.stderr", new_callable=io.StringIO) as stderr:
                self.assertEqual(watcher.main(["7", "--repo", "o/r"]), 2)
                self.assertIn(str(os.getpid()), stderr.getvalue())


class PollLoopTests(OfflineTest):
    def args(self, until="green"):
        return argparse.Namespace(repo="o/r", pr=7, until=until, every=30)

    def test_ten_failed_polls(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(watcher, "gh", return_value="agent\n") as gh, \
                patch.object(watcher, "view_pr", side_effect=watcher.GitHubError("HTTP 503")) as view, \
                patch.object(watcher.time, "sleep") as sleep, patch("sys.stderr", new_callable=io.StringIO) as stderr:
            self.assertEqual(watcher.watch(self.args(), Path(directory) / "state.json"), 1)
            self.assertEqual(view.call_count, 10)
            self.assertEqual(gh.call_count, 1)
            self.assertEqual(sleep.call_count, 9)
            self.assertIn("(10/10)", stderr.getvalue())

    def test_unknown_pr_exits_two(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(watcher, "gh", return_value="agent\n"), \
                patch.object(watcher, "view_pr", side_effect=watcher.GitHubError("unknown", unknown=True)), \
                patch("sys.stderr", new_callable=io.StringIO):
            self.assertEqual(watcher.watch(self.args(), Path(directory) / "state.json"), 2)

    def test_real_poll_wiring_call_budget_and_flush(self):
        graph = {"data": {"repository": {"pullRequest": {"reviewThreads": {"nodes": []}}}}}
        output = []
        def run(argv, **kwargs):
            output.append(argv)
            if argv[1:3] == ["api", "user"]:
                value = "agent\n"
            elif argv[1:3] == ["pr", "view"]:
                value = json.dumps(snapshot(comments=[comment()] if len(output) > 5 else []))
            elif argv[1:3] == ["pr", "checks"]:
                value = json.dumps([check()])
            elif argv[1:3] == ["api", "graphql"]:
                value = json.dumps(graph)
            elif argv[1:3] == ["api", "--paginate"]:
                value = ""
            else:
                value = "[]"
            return subprocess.CompletedProcess(argv, 0, value, "")

        with tempfile.TemporaryDirectory() as directory, patch.object(watcher.subprocess, "run", side_effect=run), \
                patch.object(watcher.time, "sleep") as sleep, patch("builtins.print") as printing:
            code = watcher.watch(self.args("change"), Path(directory) / "state.json")
            self.assertEqual(code, 0)
            self.assertEqual(len(output), 10)  # 4 setup calls (viewer, view, protection, rulesets), then two polls of 3.
            self.assertEqual(sleep.call_count, 1)
            printing.assert_called_once_with("comment by reviewer: https://example.test/comments/C1", flush=True)

    def test_success_resets_failure_count_and_failure_breaks_stability(self):
        good = snapshot(checks=[check()])
        outcomes = [watcher.GitHubError("oops")] * 9 + [good] + [watcher.GitHubError("oops")] * 9 + [good, good]
        with tempfile.TemporaryDirectory() as directory, patch.object(watcher, "gh", return_value="agent"), \
                patch.object(watcher, "view_pr", return_value=snapshot()), \
                patch.object(watcher, "required_checks", return_value=[]), \
                patch.object(watcher, "fetch_snapshot", side_effect=outcomes) as fetch, \
                patch.object(watcher.time, "sleep"), patch("sys.stderr", new_callable=io.StringIO):
            self.assertEqual(watcher.watch(self.args(), Path(directory) / "state.json"), 0)
            self.assertEqual(fetch.call_count, 21)


if __name__ == "__main__":
    unittest.main(verbosity=2)
