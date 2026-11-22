// Pure logic of the deploy board (scripts/deploy-board.mjs writes it into a GitHub issue). No I/O here, so every rule is unit tested (tests/unit/deploy-board.test.ts).
// The board is STATELESS: everything is derived from GitHub (CI runs of `main`, their `deploy-web` job, open PRs, releases), so there is no history to lose.
export const BOARD_VERSION = 1;
export const REPO = 'owner/overcut';
export const CHECK = 'verify';
export const DEPLOY_JOB = 'deploy-web';
/** Commits that only touch these never go live (same list as the `changed` step of the deploy-web job in .github/workflows/ci.yml). */
export const NO_DEPLOY = /^(docs\/|process\/|\.claude\/|\.github\/|.*\.md$)/;
const STATE_RE = /<!--board ([\s\S]*?) board-->/;

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
export const ago = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? '<1m' : m < 90 ? `${m}m` : m < 2880 ? `${(m / 60).toFixed(1)}h` : `${Math.round(m / 1440)}d`; };

/** 'pass' | 'fail' | 'pending' | 'none' from the check runs of one commit. A cancelled run was superseded: it says nothing, so it counts as pending (a newer run is coming) unless nothing else exists. */
export function ciVerdict(checkRuns) {
  const mine = (checkRuns ?? []).filter((r) => r.name === CHECK).sort((a, b) => Date.parse(b.started_at ?? 0) - Date.parse(a.started_at ?? 0));
  if (!mine.length) return 'none';
  const r = mine[0];
  if (r.status !== 'completed') return 'pending';
  if (r.conclusion === 'cancelled') return 'pending';
  return ['success', 'neutral', 'skipped'].includes(r.conclusion) ? 'pass' : 'fail';
}

/** 'draft' | 'conflicts' | 'red' | 'running' | 'unverified' | 'behind' | 'ready'. */
export function prStage(pr) {
  if (pr.draft) return 'draft';
  if (pr.mergeable === false || pr.mergeableState === 'dirty') return 'conflicts';
  if (pr.ci === 'fail') return 'red';
  if (pr.ci === 'pending') return 'running';
  if (pr.ci === 'none') return 'unverified';
  if (pr.mergeableState === 'behind') return 'behind';
  return 'ready';
}
export const STAGE_LABEL = { ready: '✅ ready to merge', behind: '↻ behind main (update, re-run CI)', running: '⏳ CI running', red: '🔴 CI red', conflicts: '⚠️ merge conflicts', unverified: '❔ no CI yet', draft: '📝 draft' };
export const STAGE_ORDER = Object.keys(STAGE_LABEL);

/** 🔵 changes the shipped app, ⚪ docs/process only, ❓ file list unknown. */
export const commitMarker = (files) => (!files ? '❓' : files.length && files.every((f) => NO_DEPLOY.test(f)) ? '⚪' : files.length ? '🔵' : '⚪');

/**
 * One CI run of `main` (+ its jobs) -> what happened to the web deploy of that commit.
 * state: 'live' (deployed) | 'failed' | 'no-change' (docs/process only) | 'idle' (no VERCEL_TOKEN) | 'building' | 'waiting' (verify not finished) | 'red' (verify failed) | 'unknown'.
 * The deploy-web job names its outcome in step names (ci.yml): "Deploy to Vercel", "Skipped: no app change", "Idle: VERCEL_TOKEN missing".
 */
export function deployOutcome(run, jobs) {
  const verify = (jobs ?? []).find((j) => j.name === CHECK);
  const dep = (jobs ?? []).find((j) => j.name === DEPLOY_JOB);
  const base = { sha: run.head_sha, url: run.html_url, subject: String(run.head_commit?.message ?? run.display_title ?? '').split('\n')[0], commitAt: Date.parse(run.head_commit?.timestamp ?? run.created_at) };
  if (verify?.conclusion === 'failure') return { ...base, state: 'red' };
  if (!dep) return { ...base, state: verify?.status === 'completed' && verify.conclusion === 'cancelled' ? 'unknown' : 'waiting' };
  if (dep.status !== 'completed') return { ...base, state: dep.steps?.find((s) => s.name === 'Deploy to Vercel')?.status === 'in_progress' ? 'building' : 'waiting' };
  const step = (n) => dep.steps?.find((s) => s.name === n)?.conclusion;
  const at = Date.parse(dep.completed_at);
  if (step('Deploy to Vercel') === 'success') return { ...base, state: 'live', at, latencyMin: Math.max(0, Math.round((at - base.commitAt) / 60e3)) };
  if (step('Deploy to Vercel') === 'failure' || dep.conclusion === 'failure') return { ...base, state: 'failed', at };
  if (step('Idle: VERCEL_TOKEN missing') === 'success') return { ...base, state: 'idle', at };
  if (step('Skipped: no app change') === 'success') return { ...base, state: 'no-change', at };
  return { ...base, state: dep.conclusion === 'cancelled' ? 'unknown' : 'no-change', at };
}

/** The newest (list is newest first) commit that really went live. */
export const liveDeploy = (outcomes) => (outcomes ?? []).find((o) => o.state === 'live') ?? null;

/** Alerts, most severe first: [{ id, severity: 'critical'|'warn', text }]. in = { mainRed {sha,url,subject}|null, deployFailed outcome|null, idle bool, redLive bool, readErrors [] }. */
export function computeAlerts(i) {
  const a = [];
  if (i.redLive) a.push({ id: 'red-live', severity: 'critical', text: `Production runs a commit whose \`verify\` failed (${i.redLive.sha.slice(0, 7)})` });
  if (i.mainRed) a.push({ id: `red-main:${i.mainRed.sha}`, severity: i.redLive ? 'critical' : 'warn', text: `\`main\` is red at ${i.mainRed.sha.slice(0, 7)} (${i.mainRed.subject}): ${i.mainRed.url}` });
  if (i.deployFailed) a.push({ id: `deploy-failed:${i.deployFailed.sha}`, severity: 'warn', text: `The web deploy of ${i.deployFailed.sha.slice(0, 7)} failed: ${i.deployFailed.url}` });
  if (i.idle) a.push({ id: 'deploy-idle', severity: 'warn', text: 'Web deploy is idle: the repo secret VERCEL_TOKEN is missing (DEPLOYING.md)' });
  for (const e of i.readErrors ?? []) a.push({ id: `read:${e}`, severity: 'warn', text: `The board could not read ${e}; that section may be stale` });
  return a;
}

/** Markdown + hidden machine block. d = { now, head {sha,subject,at}, mainCi, live, outcomes, pending [{sha,subject,at,files}], prs|null, release|null, alerts, readErrors }. */
export function render(d) {
  const { now } = d;
  const L = ['# Deploy board', '_Written by `scripts/deploy-board.mjs` (GitHub Actions: after every CI run and every 15 min). Do not edit by hand; see DEPLOYING.md._', ''];
  const crit = d.alerts.filter((a) => a.severity === 'critical');
  const head = crit.length ? '🔴 PROBLEM' : d.alerts.length ? '🟠 ATTENTION' : !d.live ? '⚪ NO WEB DEPLOYMENT RECORDED YET' : d.pending.some((c) => c.marker === '🔵') ? '🟡 CHANGES WAITING TO GO LIVE' : '🟢 UP TO DATE';
  const why = d.alerts[0]?.text ?? (!d.live ? 'none of the last CI runs deployed the web app; the first merged app change will' : d.pending.some((c) => c.marker === '🔵') ? 'merged app changes are on their way (CI, then the deploy job)' : 'production runs the newest app change on `main`');
  L.push(`**${head}** — ${why}`, '');
  L.push('| | |', '|---|---|');
  L.push(`| Live on production | ${d.live ? `\`${d.live.sha.slice(0, 7)}\` (live ${ago(now - d.live.at)} ago, [run](${d.live.url}))` : 'unknown (no deployment in the last CI runs)'} |`);
  L.push(`| \`main\` head | ${d.head ? `\`${d.head.sha.slice(0, 7)}\` ${String(d.head.subject).slice(0, 70)} · ${ago(now - d.head.at)} ago` : 'unknown'} |`);
  L.push(`| CI \`verify\` on head | ${{ pass: '🟢 green', fail: '🔴 red', pending: '⏳ running', none: 'no result yet' }[d.mainCi] ?? d.mainCi} |`);
  L.push(`| Merged, not live yet | ${d.pending.filter((c) => c.marker === '🔵').length} app change${d.pending.filter((c) => c.marker === '🔵').length === 1 ? '' : 's'} (${d.pending.length} commit${d.pending.length === 1 ? '' : 's'} in all) |`);
  L.push(`| Native apps | ${d.release ? `${d.release.tag}${d.release.draft ? ' (draft release, not published)' : ''} · ${ago(now - d.release.at)} ago` : 'no release yet (version tag `vX.Y.Z`, owner only)'} |`);
  L.push(`| Updated | ${iso(now)} |`);
  if (d.alerts.length) { L.push('', '### Alerts'); for (const a of d.alerts) L.push(`- ${a.severity === 'critical' ? '🔴' : '🟠'} ${a.text}`); }
  L.push('', '### Pipeline: branch → PR → main → live');
  if (d.prs) {
    const counts = {};
    for (const p of d.prs) counts[prStage(p)] = (counts[prStage(p)] ?? 0) + 1;
    const parts = STAGE_ORDER.filter((k) => counts[k]).map((k) => `${counts[k]} ${STAGE_LABEL[k].replace(/^\S+ /, '')}`);
    L.push(`**${d.prs.length} open PR${d.prs.length === 1 ? '' : 's'}**${parts.length ? ` (${parts.join(' · ')})` : ''} → merged, waiting to go live: **${d.pending.filter((c) => c.marker === '🔵').length}** → live`);
    if (d.prs.length) {
      L.push('', '| PR | change | branch | state | CI `verify` | age |', '|---|---|---|---|---|---|');
      for (const p of [...d.prs].sort((a, b) => STAGE_ORDER.indexOf(prStage(a)) - STAGE_ORDER.indexOf(prStage(b)) || a.at - b.at)) {
        const ci = { pass: 'green', fail: 'red', pending: 'running', none: 'none' }[p.ci] ?? p.ci;
        L.push(`| [#${p.number}](https://github.com/${REPO}/pull/${p.number}) ${String(p.title).replace(/\|/g, '/').slice(0, 70)} | ${commitMarker(p.files)} | \`${String(p.branch).slice(0, 40)}\` | ${STAGE_LABEL[prStage(p)]} | ${ci} | ${ago(now - p.at)} |`);
      }
    } else L.push('_Nothing in flight upstream of `main`._');
  } else L.push('_Open PRs unavailable this run (GitHub API failed)._');
  if (d.pending.length) {
    L.push('', '### Merged to main, not live yet', '🔵 changes the app · ⚪ docs/process only (never deployed)');
    for (const c of d.pending.slice(0, 12)) L.push(`- \`${c.sha.slice(0, 7)}\` ${c.marker} ${String(c.subject).slice(0, 90)} · ${ago(now - c.at)} ago`);
    if (d.pending.length > 12) L.push(`- … and ${d.pending.length - 12} more`);
  }
  const shown = d.outcomes.filter((o) => ['live', 'failed', 'building', 'idle'].includes(o.state)).slice(0, 10);
  if (shown.length) {
    L.push('', '### Recent web deployments', '| when (UTC) | commit | commit→live | result |', '|---|---|---|---|');
    for (const o of shown) L.push(`| ${o.at ? iso(o.at).slice(5, 16).replace('T', ' ') : '…'} | [\`${o.sha.slice(0, 7)}\`](${o.url}) | ${o.latencyMin != null ? `${o.latencyMin}m` : '…'} | ${o.state} |`);
    const lat = shown.filter((o) => o.state === 'live' && o.latencyMin != null).map((o) => o.latencyMin).sort((a, b) => a - b);
    if (lat.length) L.push('', `Stats (last ${lat.length} live deployments): median commit→live **${lat[Math.floor(lat.length / 2)]}m**, worst ${lat[lat.length - 1]}m.`);
  }
  const data = { v: BOARD_VERSION, at: iso(now), digest: digest(d), live: d.live?.sha ?? null, head: d.head?.sha ?? null, alerts: d.alerts.map((a) => a.id), prs: (d.prs ?? []).map((p) => ({ n: p.number, stage: prStage(p) })), pending: d.pending.map((c) => ({ sha: c.sha, marker: c.marker })) };
  L.push('', `<!--board ${JSON.stringify(data)} board-->`);
  return L.join('\n');
}

/** A key that changes only when the content does (ages excluded), so an idle board is not rewritten every run. */
export const digest = (d) => [d.live?.sha, d.head?.sha, d.mainCi, d.release?.tag, d.release?.draft, ...d.alerts.map((a) => a.id), ...(d.prs ?? []).map((p) => `${p.number}:${prStage(p)}`), d.prs ? 'p' : 'P?', ...d.pending.map((c) => `${c.sha.slice(0, 7)}${c.marker}`), ...d.outcomes.slice(0, 10).map((o) => `${o.sha.slice(0, 7)}${o.state}`)].join('|');

export function parseBoard(body) {
  const m = typeof body === 'string' ? body.match(STATE_RE) : null;
  if (!m) return null;
  try { const j = JSON.parse(m[1]); return j && j.v === BOARD_VERSION ? j : null; } catch { return null; }
}
