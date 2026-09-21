/**
 * @fileoverview Establishes, in a single run, whether the three rejected
 * pacing metrics can be obtained from Bid Manager in any usable shape.
 *
 * Round one (this same script, earlier form) tested five metrics the
 * performance report had been extended with, after queries.create started
 * refusing the 22-metric shape and took the whole performance sync down with
 * it. It found:
 *
 *   ACCEPTED, singly and together, alongside the production dimensions --
 *     METRIC_CM360_POST_CLICK_REVENUE, METRIC_CM360_POST_VIEW_REVENUE.
 *     Both are now in the production metrics array.
 *
 *   REJECTED against the production dimensions, each one on its own --
 *     METRIC_PERCENTAGE_FROM_CURRENT_IO_GOAL, METRIC_TRUEVIEW_LOST_IS_BUDGET,
 *     METRIC_TRUEVIEW_LOST_IS_RANK. Since each fails alone, no smaller
 *     grouping of them will work.
 *
 * Round one could not say *why* those three are refused, and its report
 * claimed more than it knew. Its minimal-dimension family was built on
 * date + advertiser while the base metrics included cost, so every shape in
 * that family died on "Advertiser Currency must be included as a dimension"
 * before the API ever considered the metric. The family had no control of its
 * own, so the flaw was invisible to the script and it printed "unavailable"
 * for metrics it had not actually tested. Round two exists because of that.
 *
 * The question now is narrow: for each of the three, is there any shape that
 * works? Four per metric, each carrying the candidate alone so nothing else
 * can be blamed --
 *
 *   STD     core dims, STANDARD        is it valid in STANDARD at all
 *   STD_IO  core + insertion order     does it need IO context
 *   YT      core dims, YOUTUBE         is it YouTube-only, as the audience
 *                                      segment metrics turned out to be
 *   YT_IO   core + IO, YOUTUBE         both
 *
 * plus a drop-one sweep over the production groupBys, which distinguishes
 * "this metric is unavailable" from "this metric cannot coexist with
 * FILTER_CREATIVE_ID" -- a difference worth a second query, not a dropped
 * feature.
 *
 * Every family has a control proving its dimension set is valid on its own,
 * and a family whose control fails is reported as uninterpretable rather than
 * read as evidence. That is the specific lesson from round one.
 *
 * Why one run rather than a sequence. queries.create validates synchronously
 * and rejects a bad shape immediately -- no report is generated, nothing is
 * polled -- so every shape can be tested at once and the whole matrix returns
 * in the time the round trips take.
 *
 * Nothing is left behind. Every query created is deleted in the finally block
 * and on SIGINT, and all of them are ONE_TIME and prefixed ZZ_DGPULSE_MPROBE_
 * so they cannot be mistaken for, or collide with, the production report whose
 * title createOrGetPerformanceReportQuery matches on.
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

// Round one settled the revenue pair: both accepted, singly and together, and
// they are now in the production metrics array. What it did not settle is why
// the three below are refused, because its minimal control was itself invalid
// -- MIN_DIMS omitted FILTER_ADVERTISER_CURRENCY while the base metrics
// included cost, so the API answered "Advertiser Currency must be included as
// a dimension" and never got as far as judging the metric. Round two fixes
// that and asks the question properly.
const CANDIDATES = [
  { key: 'IO_GOAL', metric: 'METRIC_PERCENTAGE_FROM_CURRENT_IO_GOAL' },
  { key: 'LOST_BUDGET', metric: 'METRIC_TRUEVIEW_LOST_IS_BUDGET' },
  { key: 'LOST_RANK', metric: 'METRIC_TRUEVIEW_LOST_IS_RANK' }
];

// The smallest shape the API accepts. Currency is mandatory whenever a cost or
// revenue metric is present, and round one proved it is cheaper to include it
// than to discover its absence as a misleading rejection.
const CORE_DIMS = ['FILTER_DATE', 'FILTER_ADVERTISER', 'FILTER_ADVERTISER_CURRENCY'];
const CORE_IO_DIMS = [...CORE_DIMS, 'FILTER_INSERTION_ORDER'];

// Dimensions suspected of being the blocker, dropped one at a time from the
// production list. An IO-level metric has no meaning at creative granularity
// and a TrueView metric has none on non-YouTube inventory, so if any single
// dimension is responsible it is very likely one of these four.
const SUSPECT_DIMS = [
  'FILTER_CREATIVE_ID',
  'FILTER_DEVICE_TYPE',
  'FILTER_INVENTORY_SOURCE_NAME',
  'FILTER_LINE_ITEM'
];

const VARIANTS = [];

// Controls. Each proves a family's dimension set is valid on its own, so that a
// failure in that family is attributable to the metric rather than the shape.
// Round one had no control for its minimal family and the whole family was
// wasted; that is the mistake being corrected here.
VARIANTS.push({ key: 'C_FULL', label: 'base 17, production dims', dims: FULL_DIMS, metrics: BASE_METRICS });
VARIANTS.push({ key: 'C_CORE', label: 'impressions only, core dims', dims: CORE_DIMS, metrics: ['METRIC_IMPRESSIONS'] });
VARIANTS.push({ key: 'C_CORE_IO', label: 'impressions only, core + IO', dims: CORE_IO_DIMS, metrics: ['METRIC_IMPRESSIONS'] });
VARIANTS.push({ key: 'C_YT', label: 'impressions only, core dims, YOUTUBE', dims: CORE_DIMS, metrics: ['METRIC_IMPRESSIONS'], type: 'YOUTUBE' });

// Each candidate entirely alone, with no base metrics to muddy the result.
// Four shapes per metric, answering in order: is it valid in STANDARD at all;
// does it need insertion order present; is it a YouTube-only metric; does it
// need both.
for (const c of CANDIDATES) {
  VARIANTS.push({ key: `STD_${c.key}`, label: `${c.metric} alone, core dims`, family: 'STD', candidate: c.key, dims: CORE_DIMS, metrics: [c.metric] });
  VARIANTS.push({ key: `STD_IO_${c.key}`, label: `${c.metric} alone, core + IO`, family: 'STD_IO', candidate: c.key, dims: CORE_IO_DIMS, metrics: [c.metric] });
  VARIANTS.push({ key: `YT_${c.key}`, label: `${c.metric} alone, YOUTUBE`, family: 'YT', candidate: c.key, dims: CORE_DIMS, metrics: [c.metric], type: 'YOUTUBE' });
  VARIANTS.push({ key: `YT_IO_${c.key}`, label: `${c.metric} alone, YOUTUBE + IO`, family: 'YT_IO', candidate: c.key, dims: CORE_IO_DIMS, metrics: [c.metric], type: 'YOUTUBE' });
}

// Drop-one sweep. If a candidate passes with exactly one dimension removed, we
// know the cost of having it: that dimension, in a second query. Only useful
// for candidates that turn out to be valid in STANDARD somewhere.
for (const c of CANDIDATES) {
  for (const d of SUSPECT_DIMS) {
    VARIANTS.push({
      key: `DROP_${d.replace('FILTER_', '')}_${c.key}`,
      label: `base + ${c.metric}, without ${d}`,
      family: 'DROP', candidate: c.key, dropped: d,
      dims: FULL_DIMS.filter(x => x !== d),
      metrics: [...BASE_METRICS, c.metric]
    });
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
        dataRange: { range: 'LAST_7_DAYS' },
        format: 'CSV'
      },
      params: {
        type: v.type || 'STANDARD',
        groupBys: v.dims,
        metrics: v.metrics,
        filters: [{ type: 'FILTER_PARTNER', value: String(PARTNER_ID) }]
      },
      schedule: { frequency: 'ONE_TIME' }
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
      console.log(`${verdict.padEnd(10)} ${r.v.key.padEnd(18)} ${r.v.label}`);
      if (!r.ok) console.log(`           ${r.status ? `[${r.status}] ` : ''}${r.error}`);
    }

    const inconclusive = results.filter(r => r.inconclusive);
    if (inconclusive.length) {
      console.log(`\n${inconclusive.length} shape(s) failed for a reason other than an invalid report.`);
      console.log('Those are not verdicts on the metric -- rerun before concluding anything');
      console.log('about them. If the status is 401 the refresh token has expired.');
    }

    console.log('\n===== VERDICT =====');

    // Every control is checked, not just the first. Round one interpreted a
    // whole family against a control that had itself been rejected, and the
    // resulting "unavailable" verdict was wrong. A family whose control failed
    // is reported as unusable rather than quietly read as evidence.
    const CONTROLS = {
      C_FULL: ['DROP'],
      C_CORE: ['STD'],
      C_CORE_IO: ['STD_IO'],
      C_YT: ['YT', 'YT_IO']
    };
    const deadFamilies = new Set();
    for (const [key, families] of Object.entries(CONTROLS)) {
      const r = by(key);
      if (!r || !r.ok) {
        families.forEach(f => deadFamilies.add(f));
        console.log(`Control ${key} was rejected -- ${families.join(', ')} results are not interpretable.`);
        if (r && !r.ok) console.log(`  ${r.error}`);
      }
    }
    if (deadFamilies.size) console.log('');

    const usableIn = (c, family) => {
      if (deadFamilies.has(family)) return false;
      const prefix = family === 'STD' ? 'STD_' : family === 'STD_IO' ? 'STD_IO_' :
                     family === 'YT' ? 'YT_' : 'YT_IO_';
      const r = by(`${prefix}${c.key}`);
      return !!(r && r.ok);
    };

    for (const c of CANDIDATES) {
      console.log(c.metric);
      const std = usableIn(c, 'STD');
      const stdIo = usableIn(c, 'STD_IO');
      const yt = usableIn(c, 'YT');
      const ytIo = usableIn(c, 'YT_IO');

      const drops = deadFamilies.has('DROP') ? [] :
        SUSPECT_DIMS.filter(d => {
          const r = by(`DROP_${d.replace('FILTER_', '')}_${c.key}`);
          return r && r.ok;
        });

      if (drops.length) {
        console.log(`  Blocked by a single dimension. Removing any one of these makes the`);
        console.log(`  production report accept it: ${drops.join(', ')}.`);
        console.log(`  Do not remove it from the main report -- other materializations read`);
        console.log(`  those columns. Take the metric from a second query that omits it.`);
      } else if (std || stdIo) {
        console.log(`  Valid in STANDARD on a narrower shape (${[std && 'core', stdIo && 'core+IO'].filter(Boolean).join(', ')}),`);
        console.log(`  but no single dimension removal rescues the production report, so more`);
        console.log(`  than one of our dimensions conflicts. Needs its own query at that`);
        console.log(`  narrower grain, joined on date + advertiser${stdIo ? ' + insertion order' : ''}.`);
      } else if (yt || ytIo) {
        console.log(`  YOUTUBE-only (${[yt && 'core', ytIo && 'core+IO'].filter(Boolean).join(', ')}). Not available from a STANDARD`);
        console.log(`  report at any grain. This is the same shape the audience report needed.`);
      } else {
        console.log(`  Rejected in every shape tried: STANDARD and YOUTUBE, with and without`);
        console.log(`  insertion order, and with each suspect dimension removed. Treat as`);
        console.log(`  genuinely unavailable and drop the column rather than shipping a zero.`);
      }
      console.log('');
    }

    const anyRecoverable = CANDIDATES.some(c =>
      usableIn(c, 'STD') || usableIn(c, 'STD_IO') || usableIn(c, 'YT') || usableIn(c, 'YT_IO') ||
      SUSPECT_DIMS.some(d => {
        const r = by(`DROP_${d.replace('FILTER_', '')}_${c.key}`);
        return r && r.ok;
      }));

    if (!anyRecoverable && !deadFamilies.size) {
      console.log('None of the three is obtainable. The honest options are to drop');
      console.log('io_goal_pacing_pct, lost_is_budget and lost_is_rank from the three');
      console.log('performance materializations, or to leave them NULL and remove them');
      console.log('from the dashboard. They must not go back to being zeros.');
    }
  } finally {
    console.log(`\nDeleting ${created.length} probe quer${created.length === 1 ? 'y' : 'ies'}...`);
    await cleanup();
    console.log('Done.');
  }
}

main().catch(err => { console.error('FAILED:', apiMessage(err)); process.exit(1); });
