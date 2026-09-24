/**
 * @fileoverview Decides, in one run, which Bid Manager metrics a given report
 * shape will accept.
 *
 * This is a reusable instrument rather than a one-off script. It submits a
 * matrix of candidate report shapes to queries.create, which validates
 * synchronously and rejects an invalid combination immediately -- no report is
 * generated and nothing is polled -- so dozens of shapes can be settled in the
 * time the round trips take. The variant matrix below is rewritten for each
 * question; the harness around it does not change.
 *
 * Three rules this tool exists to enforce, each learned by getting it wrong:
 *
 *   Every shape gets a control. A dimension set that is itself invalid will
 *   reject anything, and reading that as "the metric is unavailable" is how an
 *   early round reported a verdict on metrics it had never actually tested.
 *   Cells whose control failed are printed as untestable, not as evidence.
 *
 *   Only HTTP 400 is a verdict. A 429, 401 or 5xx means the question went
 *   unanswered; those print as ERROR rather than REJECTED, because treating a
 *   rate limit as a rejection would have us delete a metric that was fine.
 *
 *   Vary one thing at a time, or vary everything at once and read it as a
 *   factorial. What does not work is assuming two shapes differ in one respect
 *   when they differ in three.
 *
 * Cumulative findings, all from queries.create validation against partner
 * the partner under test. Kept here because each round's conclusion is the next round's
 * premise, and because these are expensive answers worth not re-deriving:
 *
 *   ACCEPTED by the performance report, now in production --
 *   METRIC_CM360_POST_CLICK_REVENUE, METRIC_CM360_POST_VIEW_REVENUE.
 *
 *   REJECTED by the performance report, each one on its own, so no subset of
 *   them would have worked -- METRIC_PERCENTAGE_FROM_CURRENT_IO_GOAL,
 *   METRIC_TRUEVIEW_LOST_IS_BUDGET, METRIC_TRUEVIEW_LOST_IS_RANK.
 *
 *   METRIC_PERCENTAGE_FROM_CURRENT_IO_GOAL is valid at date + advertiser +
 *   currency + insertion order. The API is explicit: "Insertion Order or
 *   Insertion Order ID is required when Percentage from Current IO Goal is
 *   selected." It is refused at any finer grain -- creative, device, inventory
 *   source and line item are each individually disqualifying -- and also
 *   refused, for reasons this round is chasing, by the real IO pacing report.
 *
 *   METRIC_TRUEVIEW_LOST_IS_BUDGET, METRIC_TRUEVIEW_LOST_IS_RANK and their
 *   sibling METRIC_TRUEVIEW_IMPRESSION_SHARE are accepted under report type
 *   YOUTUBE at line item, at ad group, and at IO + line item + ad group. All
 *   are refused under STANDARD at every grain, and refused even under YOUTUBE
 *   once FILTER_TRUEVIEW_AD is added. Obtainable, but only from a
 *   YouTube-typed report of their own.
 *
 * The question this run is asking is documented immediately above FACTORS.
 *
 * Nothing is left behind. Every query created is deleted in the finally block
 * and on SIGINT, and all of them are ONE_TIME and prefixed ZZ_DGPULSE_MPROBE_
 * so they cannot be mistaken for, or collide with, the production reports whose
 * titles createOrGetPerformanceReportQuery and createOrGetIoPacingReportQuery
 * match on.
 *
 * Usage: node probe_performance_metrics.js <partnerId>
 */
const fs = require('fs');
const { execSync } = require('child_process');
const DV360Client = require('./dv360');

const PARTNER_ID = process.argv[2] || process.env.PARTNER_ID;

if (!PARTNER_ID) {
  console.error('Usage: node probe_performance_metrics.js <partnerId>');
  process.exit(1);
}

async function initializeClient() {
  let refreshToken = process.env.REFRESH_TOKEN;
  if (!refreshToken && fs.existsSync('.env')) {
    for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
      const idx = line.indexOf('=');
      if (idx !== -1 && line.slice(0, idx).trim() === 'REFRESH_TOKEN') {
        refreshToken = line.slice(idx + 1).trim().replace(/^"|"$/g, '');
      }
    }
  }
  if (!refreshToken) {
    const envJson = execSync(
      `gcloud functions describe dv360-dgpulse-${PARTNER_ID} --region=us-central1 ` +
      `--format="json(serviceConfig.environmentVariables)"`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
    );
    const parsed = JSON.parse(envJson);
    refreshToken = ((parsed.serviceConfig || {}).environmentVariables || {}).REFRESH_TOKEN;
  }
  if (!fs.existsSync('client_secret.json')) throw new Error('No client_secret.json here.');
  if (!refreshToken) throw new Error('No refresh token found.');
  const keys = JSON.parse(fs.readFileSync('client_secret.json', 'utf8'));
  return new DV360Client(keys.installed || keys.web || keys, null, refreshToken);
}

// The production groupBys, copied from createOrGetPerformanceReportQuery.
const FULL_DIMS = [
  'FILTER_DATE',
  'FILTER_PARTNER',
  'FILTER_ADVERTISER',
  'FILTER_ADVERTISER_CURRENCY',
  'FILTER_MEDIA_PLAN',
  'FILTER_INSERTION_ORDER',
  'FILTER_LINE_ITEM',
  'FILTER_CREATIVE_ID',
  'FILTER_DEVICE_TYPE',
  'FILTER_INVENTORY_SOURCE_NAME'
];

// The 17 metrics that are known to work: the original 15 plus the conversion
// split, which is deployed and producing verified numbers.
const BASE_METRICS = [
  'METRIC_IMPRESSIONS',
  'METRIC_CLICKS',
  'METRIC_MEDIA_COST_ADVERTISER',
  'METRIC_MEDIA_COST_USD',
  'METRIC_TOTAL_CONVERSIONS',
  'METRIC_LAST_CLICKS',
  'METRIC_LAST_IMPRESSIONS',
  'METRIC_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS',
  'METRIC_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS',
  'METRIC_ACTIVE_VIEW_ELIGIBLE_IMPRESSIONS',
  'METRIC_TRUEVIEW_VIEWS',
  'METRIC_RICH_MEDIA_VIDEO_PLAYS',
  'METRIC_RICH_MEDIA_VIDEO_FIRST_QUARTILE_COMPLETES',
  'METRIC_RICH_MEDIA_VIDEO_MIDPOINTS',
  'METRIC_RICH_MEDIA_VIDEO_THIRD_QUARTILE_COMPLETES',
  'METRIC_RICH_MEDIA_VIDEO_COMPLETIONS',
  'METRIC_VIDEO_COMPLETION_RATE'
];

// Round three settled the impression share family and left one loose end.
//
//   SETTLED -- METRIC_TRUEVIEW_LOST_IS_BUDGET, METRIC_TRUEVIEW_LOST_IS_RANK
//   and the sibling METRIC_TRUEVIEW_IMPRESSION_SHARE are all accepted under
//   report type YOUTUBE at line item, at ad group, and at IO + line item + ad
//   group. All three are refused under STANDARD at every grain. Adding the
//   YouTube ad itself breaks them even under YOUTUBE. So they are obtainable,
//   but only from a YouTube-typed report -- a separate query, table and join,
//   which is a scope decision rather than a technical question.
//
//   OPEN -- METRIC_PERCENTAGE_FROM_CURRENT_IO_GOAL was accepted at date +
//   advertiser + currency + insertion order, but refused when submitted as
//   part of the real IO pacing report.
//
// Round four closes that loose end. I previously described the gap between
// those two shapes as "FILTER_PARTNER or the ALL_TIME range", and that was
// careless -- there are three differences, not two:
//
//   P  FILTER_PARTNER present in the groupBys
//   R  ALL_TIME rather than a short window
//   M  the four impressions/clicks/cost metrics riding alongside
//
// With three binary factors, testing them one at a time can mislead if two
// interact, so all eight combinations are submitted at once, each with a
// control that carries the same shape without the IO goal metric. Eight plus
// four controls is still one run of a few seconds, and it names the culprit
// outright instead of narrowing towards it.
//
// What hangs on the answer:
//
//   If P alone is responsible, this is nearly free. Partner_Id is written to
//   dbm_io_spend_daily but never read from it -- the io_spend_daily CTE in
//   materialize_insertion_orders.sql selects insertion order, date, currency,
//   revenue and impressions, and nothing else. The partner_id columns in the
//   three materializations come from dbm_performance, which keeps its own
//   FILTER_PARTNER. So the groupBy can be dropped from the pacing report
//   without touching anything downstream.
//
//   If R is responsible, it is expensive: the pacing report needs ALL_TIME to
//   measure a budget segment, so the metric would need its own query.
//
//   If M is responsible, the metric cannot share a report with cost metrics
//   and likewise needs its own query.

const IO_GOAL = 'METRIC_PERCENTAGE_FROM_CURRENT_IO_GOAL';

const CORE_DIMS = ['FILTER_DATE', 'FILTER_ADVERTISER', 'FILTER_ADVERTISER_CURRENCY'];
const CORE_IO_DIMS = [...CORE_DIMS, 'FILTER_INSERTION_ORDER'];

// The IO pacing report exactly as createOrGetIoPacingReportQuery builds it.
// Copied rather than imported so that a change there shows up here as a failing
// control instead of silently altering what is being tested.
const IO_PACING_DIMS = [
  'FILTER_DATE',
  'FILTER_PARTNER',
  'FILTER_ADVERTISER',
  'FILTER_ADVERTISER_CURRENCY',
  'FILTER_INSERTION_ORDER'
];
const IO_PACING_METRICS = [
  'METRIC_IMPRESSIONS',
  'METRIC_CLICKS',
  'METRIC_MEDIA_COST_ADVERTISER',
  'METRIC_MEDIA_COST_USD'
];

// FILTER_PARTNER is only ever a groupBy here. It stays in the filters on every
// shape, as it does in production, so the factor under test is the breakdown
// and not the scoping.
const FACTORS = {
  P: [
    { key: 'P1', label: 'with partner', dims: IO_PACING_DIMS },
    { key: 'P0', label: 'no partner', dims: CORE_IO_DIMS }
  ],
  R: [
    { key: 'RA', label: 'ALL_TIME', range: 'ALL_TIME' },
    { key: 'R7', label: 'LAST_7_DAYS', range: 'LAST_7_DAYS' }
  ],
  M: [
    { key: 'M1', label: 'with cost metrics', metrics: IO_PACING_METRICS },
    { key: 'M0', label: 'metric alone', metrics: [] }
  ]
};

const VARIANTS = [];

// The deployed pacing report, unmodified. If this is ever refused the script is
// out of date with createOrGetIoPacingReportQuery and nothing else here means
// anything.
VARIANTS.push({
  key: 'C_DEPLOYED', label: 'IO pacing report exactly as deployed',
  dims: IO_PACING_DIMS, metrics: IO_PACING_METRICS,
  range: 'ALL_TIME', frequency: 'ONE_TIME'
});

for (const p of FACTORS.P) {
  for (const r of FACTORS.R) {
    for (const m of FACTORS.M) {
      const cell = `${p.key}_${r.key}_${m.key}`;
      const label = `${p.label}, ${r.label}, ${m.label}`;

      // M0 carries only the IO goal metric, so a control without it would be a
      // report with no metrics at all. Those cells are controlled by the M1
      // control at the same P and R.
      if (m.metrics.length) {
        VARIANTS.push({
          key: `C_${cell}`, label: `control: ${label}, no IO goal`,
          dims: p.dims, metrics: m.metrics, range: r.range, frequency: 'ONE_TIME'
        });
      }

      VARIANTS.push({
        key: `T_${cell}`, label: `${label}, + IO goal`,
        cell, p: p.key, r: r.key, m: m.key,
        dims: p.dims, metrics: [...m.metrics, IO_GOAL],
        range: r.range, frequency: 'ONE_TIME'
      });
    }
  }
}

const apiMessage = err =>
  (err.response && err.response.data && err.response.data.error &&
   err.response.data.error.message) || err.message || String(err);

async function main() {
  const client = await initializeClient();
  const stamp = Date.now();
  const created = [];

  console.log(`Partner ${PARTNER_ID}`);
  console.log(`${VARIANTS.length} shapes, validation only -- no reports are run.\n`);

  const cleanup = async () => {
    for (const queryId of created) {
      try { await client.dbm.queries.delete({ queryId }); } catch (e) { /* best effort */ }
    }
  };
  process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

  const results = [];

  const probe = async (v, i) => {
    const body = {
      metadata: {
        title: `ZZ_DGPULSE_MPROBE_${stamp}_${i}`,
        dataRange: { range: v.range || 'LAST_7_DAYS' },
        format: 'CSV'
      },
      params: {
        type: v.type || 'STANDARD',
        groupBys: v.dims,
        metrics: v.metrics,
        filters: [{ type: 'FILTER_PARTNER', value: String(PARTNER_ID) }]
      },
      schedule: { frequency: v.frequency || 'ONE_TIME' }
    };
    try {
      const res = await client.dbm.queries.create({ requestBody: body });
      if (res.data && res.data.queryId) created.push(res.data.queryId);
      results.push({ v, ok: true });
    } catch (err) {
      // A rejected shape and a rate limit both arrive here as exceptions, and
      // conflating them would be the worst outcome this script could produce:
      // a throttled request would be recorded as a rejected metric and we would
      // remove something that was fine. Only a 400 is the API telling us the
      // report is invalid. Anything else -- 429, 401, 5xx, a socket error --
      // means the question went unanswered.
      const status = (err.response && err.response.status) || err.code;
      results.push({
        v,
        ok: false,
        inconclusive: Number(status) !== 400,
        status,
        error: apiMessage(err)
      });
    }
  };

  try {
    // Chunked rather than one burst. These are independent validations so they
    // want to run concurrently, but fifteen simultaneous creates is enough to
    // draw a rate limit, and a throttled probe answers nothing.
    const CONCURRENCY = 4;
    for (let start = 0; start < VARIANTS.length; start += CONCURRENCY) {
      const chunk = VARIANTS.slice(start, start + CONCURRENCY);
      await Promise.all(chunk.map((v, j) => probe(v, start + j)));
      if (start + CONCURRENCY < VARIANTS.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    const by = key => results.find(r => r.v.key === key);
    const order = VARIANTS.map(v => v.key);
    results.sort((a, b) => order.indexOf(a.v.key) - order.indexOf(b.v.key));

    console.log('===== RESULTS =====');
    for (const r of results) {
      const verdict = r.ok ? 'ACCEPTED' : r.inconclusive ? 'ERROR' : 'REJECTED';
      console.log(`${verdict.padEnd(10)} ${r.v.key.padEnd(22)} ${r.v.label}`);
      if (!r.ok) console.log(`           ${r.status ? `[${r.status}] ` : ''}${r.error}`);
    }

    const inconclusive = results.filter(r => r.inconclusive);
    if (inconclusive.length) {
      console.log(`\n${inconclusive.length} shape(s) failed for a reason other than an invalid report.`);
      console.log('Those are not verdicts on the metric -- rerun before concluding anything');
      console.log('about them. If the status is 401 the refresh token has expired.');
    }

    console.log('\n===== VERDICT =====');

    const okKey = k => { const r = by(k); return !!(r && r.ok); };

    if (!okKey('C_DEPLOYED')) {
      const c = by('C_DEPLOYED');
      console.log('C_DEPLOYED was rejected, so the IO pacing shape in this script no longer');
      console.log('matches createOrGetIoPacingReportQuery. Reconcile IO_PACING_DIMS and');
      console.log('IO_PACING_METRICS before reading anything below.');
      if (c && c.error) console.log(`  ${c.error}`);
      return;
    }

    // Each cell is usable only if its own control passed. An M0 cell carries
    // the IO goal metric alone, so it borrows the M1 control at the same P and
    // R -- a report with no metrics at all is not a thing that can be tested.
    const cells = [];
    for (const p of FACTORS.P) {
      for (const r of FACTORS.R) {
        for (const m of FACTORS.M) {
          const cell = `${p.key}_${r.key}_${m.key}`;
          const controlKey = `C_${p.key}_${r.key}_M1`;
          cells.push({
            cell, p: p.key, r: r.key, m: m.key,
            label: `${p.label}, ${r.label}, ${m.label}`,
            controlOk: okKey(controlKey),
            ok: okKey(`T_${cell}`)
          });
        }
      }
    }

    console.log('METRIC_PERCENTAGE_FROM_CURRENT_IO_GOAL, by cell:\n');
    for (const c of cells) {
      const state = !c.controlOk ? 'untestable' : c.ok ? 'ACCEPTED' : 'rejected';
      console.log(`  ${state.padEnd(11)} ${c.label}`);
    }

    const testable = cells.filter(c => c.controlOk);
    const passing = testable.filter(c => c.ok);
    const untestable = cells.length - testable.length;
    if (untestable) {
      console.log(`\n${untestable} cell(s) had a rejected control and prove nothing either way.`);
    }

    console.log('');
    if (!passing.length) {
      console.log('No combination works. The metric cannot be had at insertion order grain');
      console.log('from any variation of the pacing report, which contradicts the earlier');
      console.log('acceptance at date + advertiser + currency + insertion order. Something');
      console.log('outside these three factors is involved -- re-run the accepted shape');
      console.log('verbatim before going further.');
      return;
    }

    // A factor is responsible if every passing cell holds one value of it while
    // some testable cell with the other value fails. Reported per factor rather
    // than as a winning combination, because the fix differs by factor.
    const blame = [];
    for (const [name, levels] of Object.entries(FACTORS)) {
      const key = name === 'P' ? 'p' : name === 'R' ? 'r' : 'm';
      const passingLevels = new Set(passing.map(c => c[key]));
      if (passingLevels.size === 1) {
        const required = [...passingLevels][0];
        const failedWithOther = testable.some(c => c[key] !== required && !c.ok);
        if (failedWithOther) {
          blame.push({ name, required, label: levels.find(l => l.key === required).label });
        }
      }
    }

    if (!blame.length) {
      console.log('No single factor explains the pattern; the blockers interact. Read the');
      console.log('cell table above and pick a passing combination directly.');
    } else {
      console.log(`Responsible factor(s): ${blame.map(b => `${b.name} (must be "${b.label}")`).join(', ')}.`);
    }
    console.log('');

    // Settled on 2026-09-21. The factorial was clean: M was the sole blocking
    // factor -- all four M0 cells accepted, all four M1 cells rejected, with P
    // and R irrelevant. The metric therefore refuses to share a report with the
    // cost metrics, so serving it would mean a third query, sync step and table
    // for one column. It was dropped from the codebase instead. This branch is
    // kept only so the harness still prints a conclusion if the API behaviour
    // changes and someone re-runs it.
    console.log('For the record: this metric was dropped from DGPulse rather than');
    console.log('served, because it will not share a report with the cost metrics and');
    console.log('was not worth a third query, sync step and table. If the cells above');
    console.log('now show a passing M1 combination, that constraint has lifted and the');
    console.log('decision is worth revisiting.');
  } finally {
    console.log(`\nDeleting ${created.length} probe quer${created.length === 1 ? 'y' : 'ies'}...`);
    await cleanup();
    console.log('Done.');
  }
}

main().catch(err => { console.error('FAILED:', apiMessage(err)); process.exit(1); });
