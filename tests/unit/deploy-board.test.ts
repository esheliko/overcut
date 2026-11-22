import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain .mjs script, no types
import { ciVerdict, commitMarker, computeAlerts, deployOutcome, digest, liveDeploy, parseBoard, prStage, render } from "../../scripts/deploy-board-core.mjs";

const now = Date.parse("2026-11-22T12:00:00Z");
const run = (sha: string, ts = "2026-11-22T11:00:00Z") => ({ head_sha: sha, html_url: `https://x/run/${sha}`, head_commit: { message: `Change ${sha} (#1)\n\nbody`, timestamp: ts }, created_at: ts });
const step = (name: string, conclusion: string | null, status = "completed") => ({ name, conclusion, status });
const verify = (conclusion: string | null, status = "completed") => ({ name: "verify", status, conclusion });
const deploy = (steps: unknown[], conclusion: string | null = "success", status = "completed") => ({ name: "deploy-web", status, conclusion, completed_at: "2026-11-22T11:08:00Z", steps });

test("deployOutcome: every way the deploy-web job can end", () => {
  const live = deployOutcome(run("a1"), [verify("success"), deploy([step("Deploy to Vercel", "success")])]);
  assert.equal(live.state, "live");
  assert.equal(live.latencyMin, 8);
  assert.equal(deployOutcome(run("a2"), [verify("success"), deploy([step("Deploy to Vercel", "failure")], "failure")]).state, "failed");
  assert.equal(deployOutcome(run("a3"), [verify("success"), deploy([step("Skipped: no app change", "success"), step("Deploy to Vercel", "skipped")])]).state, "no-change");
  assert.equal(deployOutcome(run("a4"), [verify("success"), deploy([step("Idle: VERCEL_TOKEN missing", "success"), step("Deploy to Vercel", "skipped")])]).state, "idle");
  assert.equal(deployOutcome(run("a5"), [verify("failure")]).state, "red");
  assert.equal(deployOutcome(run("a6"), [verify(null, "in_progress")]).state, "waiting");
  assert.equal(deployOutcome(run("a7"), [verify("success"), deploy([step("Deploy to Vercel", null, "in_progress")], null, "in_progress")]).state, "building");
  assert.equal(deployOutcome(run("a8"), []).state, "waiting");
});

test("liveDeploy is the newest commit that really went live", () => {
  const list = [{ sha: "n1", state: "no-change" }, { sha: "l2", state: "live" }, { sha: "l1", state: "live" }];
  assert.equal(liveDeploy(list).sha, "l2");
  assert.equal(liveDeploy([{ sha: "x", state: "idle" }]), null);
});

test("ciVerdict reads only `verify`, newest run wins, a cancelled run is not a verdict", () => {
  const r = (conclusion: string | null, started: string, status = "completed", name = "verify") => ({ name, status, conclusion, started_at: started });
  assert.equal(ciVerdict([]), "none");
  assert.equal(ciVerdict([r("success", "2026-11-22T10:00:00Z", "completed", "other")]), "none");
  assert.equal(ciVerdict([r("failure", "2026-11-22T10:00:00Z"), r("success", "2026-11-22T10:30:00Z")]), "pass");
  assert.equal(ciVerdict([r("success", "2026-11-22T10:00:00Z"), r("failure", "2026-11-22T10:30:00Z")]), "fail");
  assert.equal(ciVerdict([r(null, "2026-11-22T10:00:00Z", "in_progress")]), "pending");
  assert.equal(ciVerdict([r("cancelled", "2026-11-22T10:00:00Z")]), "pending");
});

test("prStage orders the flow: draft, conflicts, red, running, unverified, behind, ready", () => {
  const p = { draft: false, mergeable: true, mergeableState: "clean", ci: "pass" };
  assert.equal(prStage(p), "ready");
  assert.equal(prStage({ ...p, draft: true }), "draft");
  assert.equal(prStage({ ...p, mergeableState: "dirty" }), "conflicts");
  assert.equal(prStage({ ...p, ci: "fail" }), "red");
  assert.equal(prStage({ ...p, ci: "pending" }), "running");
  assert.equal(prStage({ ...p, ci: "none" }), "unverified");
  assert.equal(prStage({ ...p, mergeableState: "behind" }), "behind");
});

test("commitMarker: docs/process only never goes live", () => {
  assert.equal(commitMarker(["docs/a.md", "process/rules.json", ".github/workflows/ci.yml", "README.md"]), "⚪");
  assert.equal(commitMarker(["docs/a.md", "crates/core/src/lib.rs"]), "🔵");
  assert.equal(commitMarker(null), "❓");
});

test("alerts: red main, failed deploy, idle deploy, read errors", () => {
  assert.deepEqual(computeAlerts({}), []);
  const a = computeAlerts({ mainRed: { sha: "abcdef1234", subject: "s", url: "u" }, deployFailed: { sha: "abcdef1234", url: "u" }, idle: true, redLive: false, readErrors: ["open PRs"] });
  assert.deepEqual(a.map((x: { id: string }) => x.id.split(":")[0]), ["red-main", "deploy-failed", "deploy-idle", "read"]);
  assert.equal(computeAlerts({ mainRed: { sha: "abcdef1234", subject: "s", url: "u" }, redLive: { sha: "abcdef1234" } })[0].severity, "critical");
});

const base = () => ({
  now,
  head: { sha: "bbbbbbb1111", subject: "Fix timeline (#7)", at: now - 600e3 },
  mainCi: "pass",
  live: { sha: "aaaaaaa1111", at: now - 3600e3, url: "https://x/run/a" },
  outcomes: [
    { sha: "aaaaaaa1111", url: "https://x/run/a", state: "live", at: now - 3600e3, latencyMin: 8 },
    { sha: "9999999", url: "https://x/run/9", state: "failed", at: now - 7200e3 },
  ],
  pending: [{ sha: "bbbbbbb1111", subject: "Fix timeline (#7)", at: now - 600e3, marker: "🔵" }, { sha: "ccccccc2222", subject: "Docs (#6)", at: now - 900e3, marker: "⚪" }],
  prs: [{ number: 8, title: "Add trim | tool", branch: "claude/trim", at: now - 1800e3, ci: "pending", draft: false, mergeable: true, mergeableState: "clean", files: ["crates/core/src/x.rs"] }],
  release: { tag: "v0.1.0", draft: true, at: now - 86400e3 },
  alerts: [] as { id: string; severity: string; text: string }[],
});

test("render shows live commit, pipeline, waiting commits, deployments, and a parseable block", () => {
  const md: string = render(base());
  assert.match(md, /^# Deploy board/);
  assert.match(md, /\*\*🟡 CHANGES WAITING TO GO LIVE\*\*/);
  assert.match(md, /Live on production \| `aaaaaaa`/);
  assert.match(md, /\*\*1 open PR\*\* \(1 CI running\) → merged, waiting to go live: \*\*1\*\* → live/);
  assert.match(md, /\| \[#8\]\(https:\/\/github\.com\/[^)]*\/pull\/8\) Add trim \/ tool \| 🔵 \| `claude\/trim` \| ⏳ CI running \| running \| 30m \|/);
  assert.match(md, /- `bbbbbbb` 🔵 Fix timeline \(#7\) · 10m ago/);
  assert.match(md, /\| `?\[?`?aaaaaaa`?\]?.*\| 8m \| live \|/);
  assert.match(md, /v0\.1\.0 \(draft release/);
  const b = parseBoard(md);
  assert.equal(b.live, "aaaaaaa1111");
  assert.deepEqual(b.prs, [{ n: 8, stage: "running" }]);
});

test("render: up to date, alert, and unavailable PRs", () => {
  const d = base();
  assert.match(render({ ...d, pending: [], head: d.live as never }), /🟢 UP TO DATE/);
  assert.match(render({ ...d, alerts: [{ id: "deploy-idle", severity: "warn", text: "Web deploy is idle" }] }), /🟠 ATTENTION\*\* — Web deploy is idle/);
  assert.match(render({ ...d, alerts: [{ id: "red-live", severity: "critical", text: "bad" }] }), /🔴 PROBLEM/);
  assert.match(render({ ...d, prs: null }), /Open PRs unavailable/);
  assert.match(render({ ...d, live: null, pending: [], alerts: [] }), /NO WEB DEPLOYMENT RECORDED YET/);
});

test("digest ignores ages but changes with content", () => {
  const a = base();
  assert.equal(digest(a), digest({ ...a, now: now + 5 * 60e3 }));
  assert.notEqual(digest(a), digest({ ...a, mainCi: "fail" }));
  assert.notEqual(digest(a), digest({ ...a, pending: [] }));
});

test("parseBoard rejects other versions and garbage", () => {
  assert.equal(parseBoard("no block"), null);
  assert.equal(parseBoard("<!--board {nope board-->"), null);
  assert.equal(parseBoard('<!--board {"v":99} board-->'), null);
});
