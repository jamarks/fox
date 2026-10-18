"""foxjob against a local "GitHub": a bare repo as origin, fake fx and gh on PATH. Nothing real is touched."""
import importlib, json, os, subprocess, sys, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
FAKE_FX = """#!/usr/bin/env python3
import json, os, sys
mode = os.environ.get("FAKE_FX_MODE", "done")
if mode == "big":
    open("big.txt", "w").write("x\\n" * 500)
elif mode == "done":
    open("hello.txt", "w").write("hello\\n")
status = "skip" if mode == "skip" else "done"
print(json.dumps({"final_output": 'Made it.\\nRESULT: {"status": "%s", "summary": "said hello", "verified": "ran the tests"}' % status}))
"""
FAKE_GH = """#!/usr/bin/env python3
import json, os, sys
state_file = os.environ["FAKE_GH_STATE"]
state = json.load(open(state_file)) if os.path.exists(state_file) else {"open": [], "merged": []}
args = sys.argv[1:]
if args[:2] == ["pr", "list"]:
    print(json.dumps(state["merged"] if args[args.index("--state") + 1] == "merged" else state["open"]))
elif args[:2] == ["pr", "create"]:
    n = len(state["open"]) + 1
    url = "https://github.com/o/r/pull/%d" % n
    state["open"].append({"number": n, "headRefName": args[args.index("--head") + 1], "url": url, "title": args[args.index("--title") + 1]})
    json.dump(state, open(state_file, "w"))
    print(url)
"""


def sh(*args, cwd=None):
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


class FoxJobTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="foxjob-"))
        bin_dir = self.tmp / "bin"; bin_dir.mkdir()
        for name, body in (("fx", FAKE_FX), ("gh", FAKE_GH)):
            (bin_dir / name).write_text(body); (bin_dir / name).chmod(0o755)
        os.environ.update({
            "PATH": f"{bin_dir}:{os.environ['PATH']}", "FAKE_GH_STATE": str(self.tmp / "gh.json"),
            "FOXJOB_WORK": str(self.tmp / "work"), "FOXJOB_GIT_BASE": f"file://{self.tmp}/remote/",
            "FOX_JOB_OUTPUT": str(self.tmp / "out"), "FAKE_FX_MODE": "done",
            "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t",
        })
        self.origin = self.tmp / "remote" / "o" / "r.git"
        self.origin.parent.mkdir(parents=True)
        sh("git", "init", "-q", "--bare", "-b", "main", str(self.origin))
        seed = self.tmp / "seed"
        sh("git", "clone", "-q", str(self.origin), str(seed))
        sh("git", "checkout", "-q", "-b", "main", cwd=seed)
        (seed / "README").write_text("hi\n")
        sh("git", "add", "README", cwd=seed); sh("git", "commit", "-qm", "seed", cwd=seed)
        sh("git", "push", "-q", "origin", "main", cwd=seed)
        sh("git", "push", "-q", "origin", "main:release", cwd=seed)
        self.seed = seed
        sys.path.insert(0, str(HERE.parent))
        import foxjob
        self.fj = importlib.reload(foxjob)  # picks up the environment above

    def propose(self, **kw):
        return self.fj.propose_change("o/r", branch="agent/hello", title="Say hello", task="Add hello.txt",
                                      test="test -f hello.txt", **kw)

    def test_a_checked_change_becomes_a_pull_request(self):
        p = self.propose()
        self.assertEqual((p.status, p.url, p.files, p.summary), ("opened", "https://github.com/o/r/pull/1", 1, "said hello"))
        self.assertEqual(sh("git", "show", "agent/hello:hello.txt", cwd=self.origin), "hello")
        self.assertEqual(sh("git", "log", "-1", "--format=%B", "agent/hello", cwd=self.origin), "Say hello\n\nsaid hello")
        self.assertEqual(sh("git", "rev-parse", "main", cwd=self.origin), sh("git", "rev-parse", "release", cwd=self.origin),
                         "main and release untouched")
        self.assertEqual(self.propose().status, "exists")

    def test_nothing_is_pushed_when_fx_skips_goes_too_big_or_tests_fail(self):
        for mode, test, reason in (("skip", "true", "fx did not do it"), ("big", "true", "too big"), ("done", "false", "failed")):
            self.fj.CHILD_ENV["FAKE_FX_MODE"] = mode  # what fx is started with
            with self.assertRaises(self.fj.Failure) as e:
                self.fj.propose_change("o/r", branch=f"agent/{mode}", title="t", task="t", test=test)
            self.assertIn(reason, e.exception.reason)
        self.assertEqual(sh("git", "branch", "--list", "agent/*", cwd=self.origin), "")

    def test_too_many_waiting_pull_requests_stops_a_new_one(self):
        Path(os.environ["FAKE_GH_STATE"]).write_text(json.dumps({"open": [{"number": 1, "headRefName": "agent/x", "url": "u", "title": "x"}], "merged": []}))
        self.assertEqual(self.propose(max_open=1).status, "busy")

    def test_merged_work_is_published_fast_forward_only(self):
        (self.seed / "new").write_text("merged\n")
        sh("git", "add", "new", cwd=self.seed); sh("git", "commit", "-qm", "merged PR", cwd=self.seed)
        sh("git", "push", "-q", "origin", "main", cwd=self.seed)
        sha = sh("git", "rev-parse", "HEAD", cwd=self.seed)
        Path(os.environ["FAKE_GH_STATE"]).write_text(json.dumps({"open": [], "merged": [
            {"number": 7, "headRefName": "agent/x", "mergeCommit": {"oid": sha}, "url": "u7", "title": "x"},
            {"number": 8, "headRefName": "someone/else", "mergeCommit": {"oid": sha}, "url": "u8", "title": "y"}]}))
        published = self.fj.publish_merged("o/r")
        self.assertEqual([p["number"] for p in published], [7])
        self.assertEqual(sh("git", "rev-parse", "release", cwd=self.origin), sha)
        self.assertEqual(self.fj.publish_merged("o/r"), [], "already out")

    def test_result_lines_and_sizes(self):
        self.assertEqual(self.fj.parse_result('x\nRESULT: {"status": "skip", "summary": "no"}')["status"], "skip")
        for bad in ("no result", 'RESULT: {"status": "maybe", "summary": "?"}', "RESULT: {nope}"):
            with self.assertRaises(self.fj.Failure):
                self.fj.parse_result(bad)
        self.assertEqual(self.fj.count_lines("3\t1\ta.py\n-\t-\timg.png\n10\t0\tb.py"), 14)


if __name__ == "__main__":
    unittest.main()
