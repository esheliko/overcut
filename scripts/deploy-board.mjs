#!/usr/bin/env node
// Writes the deploy board into ONE GitHub issue (label `deploy-board`, created on the first run): what is live, what is in flight (PRs, merged but not live), recent deployments, alerts.
//   node scripts/deploy-board.mjs           gather, then create/update the issue
//   node scripts/deploy-board.mjs --dry     gather and print the board, write nothing
// Runs in GitHub Actions (.github/workflows/deploy-board.yml; GH_TOKEN). Needs no Vercel token: the deploy happens in the CI job `deploy-web`, whose outcome is read from the run.
// Every source is read fail-soft: an unreadable source becomes a note on the board, never a crash and never a wrong number. If the CI runs themselves are unreadable nothing is written.
import { execFileSync } from 'node:child_process';
import { REPO, ciVerdict, commitMarker, computeAlerts, deployOutcome, digest, liveDeploy, parseBoard, render } from './deploy-board-core.mjs';

const LABEL = 'deploy-board';
const MAX_RUNS = 25, MAX_PENDING = 20, MAX_PRS = 15, REFRESH_MIN = 15;
const gh = (path, ...extra) => JSON.parse(execFileSync('gh', ['api', ...extra, path], { encoding: 'utf8', maxBuffer: 64e6 }));
const write = (method, path, body) => execFileSync('gh', ['api', '-X', method, path, '--input', '-'], { input: JSON.stringify(body), encoding: 'utf8' });
const readErrors = [];
const soft = (name, fn, fallback) => { try { return fn(); } catch (e) { readErrors.push(name); console.error(`read failed: ${name}: ${String(e.message).split('\n')[0]}`); return fallback; } };

function gather(now) {
  const runs = soft('CI runs', () => gh(`repos/${REPO}/actions/workflows/ci.yml/runs?branch=main&event=push&per_page=${MAX_RUNS}`).workflow_runs, null);
  if (!runs) return null;
  const outcomes = runs.map((r) => deployOutcome(r, soft('CI jobs', () => gh(`repos/${REPO}/actions/runs/${r.id}/jobs?per_page=30`).jobs, [])));
  const live = liveDeploy(outcomes);
  const headCommit = soft('main head', () => gh(`repos/${REPO}/commits/main`), null);
  const head = headCommit ? { sha: headCommit.sha, subject: String(headCommit.commit.message).split('\n')[0], at: Date.parse(headCommit.commit.committer.date) } : null;
  const mainCi = head ? soft('main CI', () => ciVerdict(gh(`repos/${REPO}/commits/${head.sha}/check-runs?per_page=100`).check_runs), 'none') : 'none';
  // merged commits newer than the live one (all of them when nothing is live yet), newest first
  const pending = head && live && head.sha !== live.sha ? soft('commits since live', () => {
    const c = gh(`repos/${REPO}/compare/${live.sha}...main`);
    return c.commits.slice(-MAX_PENDING).reverse().map((x) => {
      let files = null;
      try { files = gh(`repos/${REPO}/commits/${x.sha}`).files.map((f) => f.filename); } catch { /* marker becomes ❓ */ }
      return { sha: x.sha, subject: String(x.commit.message).split('\n')[0], at: Date.parse(x.commit.committer.date), marker: commitMarker(files) };
    });
  }, []) : [];
  const prs = soft('open PRs', () => gh(`repos/${REPO}/pulls?state=open&per_page=${MAX_PRS}`).map((p) => {
    let ci = 'none', m = {}, files = null;
    try { ci = ciVerdict(gh(`repos/${REPO}/commits/${p.head.sha}/check-runs?per_page=100`).check_runs); } catch { /* none */ }
    try { m = gh(`repos/${REPO}/pulls/${p.number}`); } catch { /* mergeability is a nicety */ }
    try { files = gh(`repos/${REPO}/pulls/${p.number}/files?per_page=100`).map((f) => f.filename); } catch { /* ❓ */ }
    return { number: p.number, title: p.title, branch: p.head.ref, at: Date.parse(p.created_at), ci, draft: !!p.draft, mergeable: m.mergeable ?? null, mergeableState: m.mergeable_state ?? null, files };
  }), null);
  const release = soft('releases', () => { const r = gh(`repos/${REPO}/releases?per_page=1`)[0]; return r ? { tag: r.tag_name, draft: r.draft, at: Date.parse(r.published_at ?? r.created_at) } : null; }, null);
  const newest = outcomes.find((o) => o.state !== 'unknown');
  const mainRed = mainCi === 'fail' ? { sha: head.sha, subject: head.subject, url: outcomes.find((o) => o.sha === head.sha)?.url ?? `https://github.com/${REPO}/actions` } : null;
  const redLive = live ? outcomes.some((o) => o.sha === live.sha && o.state === 'red') : false;
  const alerts = computeAlerts({ mainRed, deployFailed: newest?.state === 'failed' ? newest : null, idle: newest?.state === 'idle', redLive, readErrors: [...new Set(readErrors)] });
  return { now, head, mainCi, live, outcomes, pending, prs, release, alerts };
}

function main() {
  const dry = process.argv.includes('--dry');
  const now = Date.now();
  const d = gather(now);
  if (!d) { console.error('CI runs unreadable: board not written'); process.exit(dry ? 1 : 0); }
  const body = render(d);
  if (dry) { console.log(body); return; }
  let issue = null;
  try { issue = gh(`repos/${REPO}/issues?labels=${LABEL}&state=open&per_page=5`).find((i) => !i.pull_request) ?? null; } catch { console.error('could not look up the board issue; not writing'); return; }
  const prev = issue ? parseBoard(issue.body) : null;
  if (prev && prev.digest === digest(d) && now - Date.parse(prev.at) < REFRESH_MIN * 60e3) { console.log('board unchanged'); return; }
  if (issue) write('PATCH', `repos/${REPO}/issues/${issue.number}`, { body });
  else write('POST', `repos/${REPO}/issues`, { title: 'Deploy board', body, labels: [LABEL] });
  console.log(`board written (${d.alerts.length} alerts, ${d.prs?.length ?? '?'} open PRs, ${d.pending.length} merged not live)`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
