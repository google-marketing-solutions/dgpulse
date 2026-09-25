/*
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @fileoverview Automation script to create the DBM performance report query during deployment.
 * Connects via DV360Client and sets up a daily DBM report query for the partner.
 */
const { Storage } = require('@google-cloud/storage');
const { BigQuery } = require('@google-cloud/bigquery');
const DV360Client = require('./dv360');

const storage = new Storage();
const bigquery = new BigQuery();

const BUCKET_NAME = process.env.BUCKET_NAME;
const CLIENT_SECRET_FILE = process.env.CLIENT_SECRET_FILE || 'client_secret.json';
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const PARTNER_ID = process.env.PARTNER_ID;
const DATASET_ID = process.env.DATASET_ID || (PARTNER_ID ? `dv360_dgpulse_${PARTNER_ID}` : 'dv360_dgpulse');

let dv360Client = null;

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Replaces the contents of a BigQuery table using a load job.
 *
 * Streaming inserts (`table.insert`) were previously used here in batches of
 * 500. At ~500k rows that is ~1,000 sequential round trips, which dominated the
 * deployment time. A load job sends everything in a single request, is not
 * billed, and applies WRITE_TRUNCATE atomically, so it also removes the need
 * for a separate TRUNCATE that could fail against the streaming buffer.
 *
 * @param {string} targetDatasetId
 * @param {string} tableName
 * @param {!Array<!Object>} rows
 * @returns {!Promise<number>} Number of rows loaded.
 */
async function replaceTableRows(targetDatasetId, tableName, rows) {
  if (!rows || rows.length === 0) return 0;

  const tmpFile = path.join(os.tmpdir(), `dgpulse_${tableName}_${Date.now()}.ndjson`);
  fs.writeFileSync(tmpFile, rows.map(r => JSON.stringify(r)).join('\n'));

  try {
    console.log(`Loading ${rows.length} rows into ${targetDatasetId}.${tableName}...`);
    const [job] = await bigquery
      .dataset(targetDatasetId)
      .table(tableName)
      .load(tmpFile, {
        sourceFormat: 'NEWLINE_DELIMITED_JSON',
        writeDisposition: 'WRITE_TRUNCATE',
        // Omitting the schema makes the load reuse the destination table's
        // existing schema rather than guessing one from the data.
        autodetect: false
      });

    const jobErrors = job && job.status && job.status.errors;
    if (jobErrors && jobErrors.length > 0) {
      throw new Error(`Load job failed: ${JSON.stringify(jobErrors)}`);
    }
    console.log(`Successfully loaded ${rows.length} rows into ${targetDatasetId}.${tableName}.`);
    return rows.length;
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch (cleanupErr) {
      console.warn(`Warning removing temp file ${tmpFile}:`, cleanupErr.message);
    }
  }
}

/**
 * Downloads client_secret.json from GCS or local filesystem and initializes DV360Client.
 *
 * @param {string=} partnerIdOverride Partner the caller is acting for. Callers
 *     that were given a partner explicitly (for example from a CLI argument)
 *     must pass it: process.env.PARTNER_ID is not set when this module is run
 *     from the command line.
 */
async function initializeClient(partnerIdOverride) {
  if (dv360Client) return dv360Client;

  const partnerId = partnerIdOverride || PARTNER_ID;

  let bucketName = process.env.BUCKET_NAME;
  let refreshToken = process.env.REFRESH_TOKEN;
  let tokenSource = refreshToken ? 'REFRESH_TOKEN environment variable' : null;

  // 1. Check local .env file if missing
  if ((!bucketName || !refreshToken) && fs.existsSync('.env')) {
    const envContent = fs.readFileSync('.env', 'utf8');
    for (const line of envContent.split('\n')) {
      const [k, v] = line.split('=');
      if (k && v) {
        if (!bucketName && k.trim() === 'BUCKET_NAME') bucketName = v.trim().replace(/^"|"$/g, '');
        if (!refreshToken && k.trim() === 'REFRESH_TOKEN') {
          refreshToken = v.trim().replace(/^"|"$/g, '');
          tokenSource = '.env file';
        }
      }
    }
  }

  // 1b. Auto-discover from the deployed Cloud Function's environment variables
  // if still missing.
  //
  // The function name is derived from the partner the caller actually asked
  // for. This previously read the module-level PARTNER_ID, which is populated
  // only from the environment, so `node create_report.js <partnerId> setup`
  // resolved to the legacy unsuffixed function instead -- the CLI argument
  // never reached here -- and picked up its long-dead refresh token. Every call
  // then failed with invalid_grant while the valid token sat unused on the
  // partner's own function.
  //
  // There is deliberately no fallback to the unsuffixed name once a partner is
  // known. It cannot help, since one partner's token does not live on another
  // partner's function, and it actively hurts by silently substituting stale
  // credentials for what should be a clear "function not found".
  if (!bucketName || !refreshToken) {
    const functionName = partnerId ? `dv360-dgpulse-${partnerId}` : 'dv360-dgpulse';
    try {
      const { execSync } = require('child_process');
      const envJson = execSync(
        `gcloud functions describe ${functionName} --region=us-central1 --format="json(serviceConfig.environmentVariables)" 2>/dev/null || ` +
        `gcloud functions describe ${functionName} --region=us-central1 --format="json(environmentVariables)" 2>/dev/null`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
      );
      if (envJson) {
        const parsed = JSON.parse(envJson);
        const envVars = (parsed.serviceConfig && parsed.serviceConfig.environmentVariables) || parsed.environmentVariables || parsed;
        if (!bucketName && envVars.BUCKET_NAME) bucketName = envVars.BUCKET_NAME;
        if (!refreshToken && envVars.REFRESH_TOKEN) {
          refreshToken = envVars.REFRESH_TOKEN;
          tokenSource = `Cloud Function ${functionName}`;
        }
      }
    } catch (e) {
      console.warn(`Could not read configuration from Cloud Function ${functionName}: ${e.message}`);
    }
  }

  let credentials = null;

  // 2. Try local client_secret.json
  if (fs.existsSync(CLIENT_SECRET_FILE)) {
    try {
      const keys = JSON.parse(fs.readFileSync(CLIENT_SECRET_FILE, 'utf8'));
      credentials = keys.installed || keys.web || keys;
    } catch (e) {}
  }

  // 3. Try GCS bucket if not found locally
  if (!credentials) {
    if (!bucketName) {
      try {
        const [buckets] = await storage.getBuckets();
        const match = buckets.find(b => b.name.includes('dv360') || b.name.includes('dgpulse'));
        if (match) bucketName = match.name;
      } catch (e) {}
    }

    if (bucketName) {
      console.log(`Downloading ${CLIENT_SECRET_FILE} from bucket ${bucketName}...`);
      const [content] = await storage
        .bucket(bucketName)
        .file(CLIENT_SECRET_FILE)
        .download();

      const keys = JSON.parse(content.toString());
      credentials = keys.installed || keys.web || keys;
    }
  }

  if (!credentials) {
    throw new Error(`Missing ${CLIENT_SECRET_FILE} locally or in GCS bucket.`);
  }

  if (!refreshToken) {
    throw new Error(
      `Missing REFRESH_TOKEN. Checked: environment, .env, and Cloud Function ` +
      `${partnerId ? `dv360-dgpulse-${partnerId}` : 'dv360-dgpulse'}.`);
  }

  // Recorded explicitly because invalid_grant has two unrelated causes here --
  // an expired token, or the wrong token being discovered -- and they are
  // indistinguishable from the error alone.
  console.log(`Using refresh token from: ${tokenSource || 'unknown source'}.`);

  dv360Client = new DV360Client(
    credentials,
    null,
    refreshToken
  );

  return dv360Client;
}

/**
 * Parses a DBM report CSV into an array of row objects.
 *
 * DBM appends a metadata footer after the data, separated by a blank line:
 *
 *   Date,Partner ID,...,Media Cost (USD)
 *   2025/03/03,1234567890,...
 *   ...
 *                                  <- blank separator
 *   Report Time:,2026/09/16 13:02 PM
 *   Date Range:,All Time
 *   Filter by Advertiser ID:,1234567890,0987654321,...
 *
 * That blank line is the only reliable data/footer boundary, so it must be
 * detected before empty lines are discarded. A previous version filtered all
 * blank lines up front and then relied on a column-count check to reject the
 * footer, which only worked by accident: it held for the wide performance
 * report (~20 columns) but not for the narrower IO pacing report, where
 * "Filter by Advertiser ID:" plus seven advertiser IDs was wide enough to pass
 * and landed in BigQuery as `Invalid date: 'Filter by Advertiser ID:'`.
 */
function parseCsv(text) {
  const rawLines = text.split(/\r?\n/);

  const parseLine = (line) => {
    const values = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"' && (i === 0 || line[i - 1] !== '\\')) {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim().replace(/^"|"$/g, '').trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim().replace(/^"|"$/g, '').trim());
    return values;
  };

  const headerIndex = rawLines.findIndex(line => line.trim().length > 0);
  if (headerIndex === -1) return [];

  const headers = parseLine(rawLines[headerIndex]);
  const rows = [];
  for (let i = headerIndex + 1; i < rawLines.length; i++) {
    const rawLine = rawLines[i];

    // First blank line after the header ends the data section.
    if (rawLine.trim().length === 0) break;

    if (rawLine.startsWith('Total') || rawLine.startsWith('Grand Total') || rawLine.startsWith(',')) {
      continue;
    }

    const cols = parseLine(rawLine);
    if (cols.length < headers.length) continue;

    // Backstop in case a future report omits the blank separator: every footer
    // line is a "Label:" followed by its values, and no data value ends in a
    // colon.
    if (cols[0].endsWith(':')) continue;

    const row = {};
    headers.forEach((h, idx) => {
      row[h] = cols[idx];
    });
    rows.push(row);
  }
  return rows;
}

/**
 * Normalises a DBM date cell to YYYY-MM-DD, or null if it isn't a date.
 *
 * Returning null rather than the raw input matters: these values land in a
 * BigQuery DATE column, and a single unparseable string aborts the entire load
 * job. Dropping the value lets the per-report row filters discard the row.
 */
const parseDate = (d) => {
  if (!d) return null;
  const parts = d.split(/[\/\-]/);
  if (parts.length !== 3) return null;
  if (!parts.every(p => /^\d+$/.test(p.trim()))) return null;

  const [a, b, c] = parts.map(p => p.trim());
  const iso = a.length === 4
    ? `${a}-${b.padStart(2, '0')}-${c.padStart(2, '0')}`
    : `${c}-${a.padStart(2, '0')}-${b.padStart(2, '0')}`;

  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
};

/**
 * Resolves a value from a parsed CSV row by matching column names against a
 * prioritised list of patterns.
 *
 * Patterns are the OUTER loop on purpose: the caller passes them most-specific
 * first, and that priority must win regardless of the order the columns happen
 * to appear in the CSV. Iterating columns first would make the binding depend
 * on DV360's column ordering, so a broad pattern such as 'Revenue' could
 * capture an unintended column like 'Total Conversion Revenue'.
 */
function getColFrom(row, patterns) {
  const keys = Object.keys(row);
  for (const pat of patterns) {
    const needle = pat.toLowerCase();
    // Prefer an exact column-name match before falling back to a substring match.
    for (const key of keys) {
      if (key.toLowerCase() === needle) return row[key];
    }
    for (const key of keys) {
      if (key.toLowerCase().includes(needle)) return row[key];
    }
  }
  return null;
}

/**
 * Parses a CSV cell to a number, treating anything unparseable as 0.
 *
 * Be careful what you apply this to. num() cannot distinguish "the advertiser
 * genuinely scored zero" from "this column was never in the CSV", and it
 * resolves that ambiguity as zero. That is exactly how post_click_conversions,
 * post_view_conversions and the CM360 revenue pair sat on the dashboard as
 * confident, permanent zeros while no one had ever asked the API for them --
 * a wrong number is worse than a missing one, because nobody goes looking.
 *
 * So it is only safe for metrics the report actually requests. The guard is
 * the missing-header check in syncDbmPerformanceReport, which warns by name
 * when an expected column is absent; keep that map in step with the metrics
 * array in dv360.js. For a metric that is deliberately not requested, do not
 * reach for a null-returning variant -- drop the column instead. One was
 * written and then deleted here, because a column that can never hold a value
 * earns its schema slot only by being genuinely pending, and none of ours were.
 */
function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  const cleaned = String(v).replace(/[^\d.-]/g, '');
  const n = Number(cleaned);
  return isNaN(n) ? 0 : n;
}

function intNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  const cleaned = String(v).replace(/[^\d-]/g, '');
  const n = parseInt(cleaned, 10);
  return isNaN(n) ? 0 : n;
}

/**
 * Maps CSV column names to BigQuery dbm_performance table schema.
 */
function mapCsvRowToBq(r) {
  const getCol = (patterns) => getColFrom(r, patterns);

  return {
    Report_Day: parseDate(getCol(['Report_Day', 'Date', 'Day'])),
    Partner: getCol(['Partner Name', 'Partner']) || '',
    Partner_Id: intNum(getCol(['Partner ID', 'Partner_Id'])),
    Advertiser: getCol(['Advertiser Name', 'Advertiser']) || '',
    Advertiser_Id: intNum(getCol(['Advertiser ID', 'Advertiser_Id'])),
    Advertiser_Currency: getCol(['Advertiser Currency', 'Currency']) || '',
    Media_Plan: getCol(['Campaign', 'Media Plan']) || '',
    Media_Plan_Id: intNum(getCol(['Campaign ID', 'Media Plan ID'])),
    Insertion_Order: getCol(['Insertion Order Name', 'Insertion Order']) || '',
    Insertion_Order_Id: intNum(getCol(['Insertion Order ID', 'Insertion_Order_Id'])),
    Line_Item: getCol(['Line Item Name', 'Line Item']) || '',
    Line_Item_Id: intNum(getCol(['Line Item ID', 'Line_Item_Id', 'Line Item Id'])),
    Creative_Id: intNum(getCol(['Creative ID', 'Creative_Id'])),
    Device_Type: getCol(['Device Type', 'Device']) || '',
    Inventory_Source: getCol(['Inventory Source Name', 'Inventory Source']) || '',
    Revenue: num(getCol(['Media Cost (Advertiser Currency)', 'Revenue (Adv Currency)', 'Revenue', 'Media Cost (Adv Currency)'])),
    Revenue_USD: num(getCol(['Media Cost (USD)', 'Revenue (USD)', 'Cost (USD)', 'Revenue_USD'])),
    Impressions: intNum(getCol(['Impressions'])),
    Clicks: intNum(getCol(['Clicks'])),
    Total_Conversions: num(getCol(['Total Conversions', 'Conversions'])),
    Active_View_Viewable_Impressions: intNum(getCol(['Viewable Impressions', 'Active View: Viewable'])),
    Active_View_Measurable_Impressions: intNum(getCol(['Measurable Impressions', 'Active View: Measurable'])),
    Active_View_Eligible_Impressions: intNum(getCol(['Eligible Impressions', 'Active View: Eligible'])),
    TrueView_Views: intNum(getCol(['TrueView: Views', 'TrueView Views', 'Views'])),
    Video_Plays: intNum(getCol(['Video: Plays', 'Video Plays', 'Plays'])),
    Video_First_Quartile_Completes: intNum(getCol(['First-Quartile', 'First Quartile'])),
    Video_Midpoints: intNum(getCol(['Midpoint', 'Midpoints'])),
    Video_Third_Quartile_Completes: intNum(getCol(['Third-Quartile', 'Third Quartile'])),
    Video_Completions: intNum(getCol(['Video: Completions', 'Video Completions', 'Completions'])),
    Video_Completion_Rate: num(getCol(['Completion Rate', 'Video Completion Rate'])),
    // Sourced from METRIC_LAST_CLICKS and METRIC_LAST_IMPRESSIONS, which Bid
    // Manager emits under these headers. Both were hardcoded to 0 until the
    // report was actually asked for the metrics -- materialize_campaigns.sql
    // has summed and exposed these columns the whole time, so the dashboard
    // showed a confident, permanent zero.
    //
    // 'Post-Click Conversions' is the documented header; the unhyphenated and
    // 'Last Clicks' spellings are defensive, matching the style used for every
    // other column here, because a header rename silently reintroduces the
    // zero rather than failing.
    Post_Click_Conversions: num(getCol(['Post-Click Conversions', 'Post Click Conversions', 'Last Clicks'])),
    Post_View_Conversions: num(getCol(['Post-View Conversions', 'Post View Conversions', 'Last Impressions'])),
    // CM360 revenue: confirmed accepted by queries.create alongside this
    // report's dimensions, so these two carry real values.
    //
    // Header spellings are the documented display names from
    // bid-manager/reference/rest/v2/filters-metrics, with defensive variants.
    // Getting a header wrong here does not fail loudly -- it just yields 0,
    // which reproduces exactly the bug being fixed. Verify against real data
    // after deploying rather than trusting these strings.
    CM_Post_Click_Revenue: num(getCol(['CM360 Post-Click Revenue', 'CM360 Post Click Revenue', 'Post-Click Revenue'])),
    CM_Post_View_Revenue: num(getCol(['CM360 Post-View Revenue', 'CM360 Post View Revenue', 'Post-View Revenue']))
    // Three metrics were trialled here and removed outright rather than left
    // as permanently empty columns, because a column that can never hold a
    // value is just a slower way of lying about the data:
    //
    //   Percentage_From_Current_IO_Goal -- valid only at insertion order grain
    //   or coarser, and it will not share a report with cost metrics. Both
    //   this report and the IO pacing report carry cost, so it would need a
    //   third query of its own. Pacing is already derived from spend against
    //   flight dates, which makes this largely redundant.
    //
    //   TrueView_Lost_IS_Budget, TrueView_Lost_IS_Rank -- accepted only under
    //   report type YOUTUBE at ad group or line item grain, so likewise a
    //   separate query, table and join. is_limited_by_budget in
    //   materialize_campaigns.sql already answers the same question.
    //
    // probe_performance_metrics.js records the exact shapes each was accepted
    // and refused at, so none of that has to be rediscovered.
  };
}

/**
 * Ensures DBM performance query exists and triggers a run.
 *
 * @param {string=} partnerIdOverride
 * @param {!Array<string>=} insertionOrderIds Demand Gen insertion orders to
 *     scope the report to. Accepted pre-resolved rather than looked up here so
 *     that the setup path can share one lookup with the audience query. Falls
 *     back to reading them itself when called directly.
 */
async function setupDbmReport(partnerIdOverride, insertionOrderIds) {
  const partnerId = partnerIdOverride || PARTNER_ID;
  if (!partnerId) {
    throw new Error('PARTNER_ID is required.');
  }

  const client = await initializeClient(partnerId);
  const ioIds = insertionOrderIds !== undefined
    ? insertionOrderIds
    : await fetchDemandGenInsertionOrderIds(
        process.env.DATASET_ID || `dv360_dgpulse_${partnerId}`);
  const { queryId, isNew } =
      await client.createOrGetPerformanceReportQuery(partnerId, ioIds);

  if (isNew) {
    console.log(`Triggering initial run for new DBM query ${queryId}...`);
    try {
      await client.runQuery(queryId);
      console.log(`Initial run for DBM query ${queryId} requested.`);
    } catch (e) {
      console.warn(`Warning: failed to trigger initial run for DBM query ${queryId}:`, e.message);
    }
  }

  return { queryId, isNew };
}

/**
 * Downloads the latest DBM report and ingests rows into BigQuery dbm_performance table.
 */
async function syncDbmPerformanceReport(partnerIdOverride, datasetIdOverride) {
  const partnerId = partnerIdOverride || PARTNER_ID;
  const targetDatasetId = datasetIdOverride || process.env.DATASET_ID || (partnerId ? `dv360_dgpulse_${partnerId}` : DATASET_ID);
  if (!partnerId) throw new Error('PARTNER_ID is required.');

  const client = await initializeClient(partnerId);
  const insertionOrderIds = await fetchDemandGenInsertionOrderIds(targetDatasetId);
  const { queryId } =
      await client.createOrGetPerformanceReportQuery(partnerId, insertionOrderIds);

  let downloadUrl = await client.getLatestReportDownloadUrl(queryId);
  if (!downloadUrl) {
    console.log(`No completed report found yet for query ${queryId}. Triggering execution...`);
    try {
      await client.runQuery(queryId);
    } catch (e) {
      console.warn('Warning triggering DBM query:', e.message);
    }
    for (let attempt = 1; attempt <= 18; attempt++) {
      console.log(`Waiting for DBM report ${queryId} to finish generating (attempt ${attempt}/18)...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
      downloadUrl = await client.getLatestReportDownloadUrl(queryId);
      if (downloadUrl) break;
    }
    if (!downloadUrl) {
      return { success: false, message: 'Report execution triggered. Data will be available on next sync.' };
    }
  }

  console.log(`Downloading latest DBM report from ${downloadUrl}...`);
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Failed to download report: ${response.statusText}`);
  }

  // The whole CSV is materialised as one JavaScript string, which V8 caps at
  // 0x1fffffe8 characters (~512 MiB). Exceeding it throws "Cannot create a
  // string longer than 0x1fffffe8 characters", which names neither this
  // function nor the report and sent one investigation looking for a memory
  // leak. Scoping the query to the Demand Gen insertion orders is what keeps
  // the file under the ceiling; this catch exists for the case where even the
  // scoped pull is too large, and says what to do about it.
  let csvText;
  try {
    csvText = await response.text();
  } catch (err) {
    if (/string longer than/i.test(err.message)) {
      throw new Error(
        'Performance report CSV is too large to read into memory ' +
        `(${err.message}). The query is scoped to ${insertionOrderIds.length} ` +
        'Demand Gen insertion order(s); a scope of 0 means the entity sync has ' +
        'not populated line_items yet, and the next sync will scope it ' +
        'correctly. If the scope is already correct, the report has outgrown ' +
        'the single-string ceiling and the download has to be streamed rather ' +
        'than buffered -- raising the function memory will not help.');
    }
    throw err;
  }
  const parsedRows = parseCsv(csvText);
  console.log(`Parsed ${parsedRows.length} rows from DBM CSV.`);

  // Guard against the failure mode this pipeline has already shipped once.
  //
  // getCol returns null for a header it cannot find and num() turns that into
  // 0, so a single wrong spelling produces a column of confident zeros with no
  // error anywhere. Five metrics sat like that in production. Naming the
  // missing headers here converts a silent data defect into a visible warning.
  if (parsedRows.length > 0) {
    const headers = Object.keys(parsedRows[0]);
    const expected = {
      'Post-Click Conversions': ['post-click conversions', 'post click conversions', 'last clicks'],
      'Post-View Conversions': ['post-view conversions', 'post view conversions', 'last impressions'],
      'CM360 Post-Click Revenue': ['cm360 post-click revenue', 'cm360 post click revenue', 'post-click revenue'],
      'CM360 Post-View Revenue': ['cm360 post-view revenue', 'cm360 post view revenue', 'post-view revenue']
      // This map must list only metrics the report actually requests. A metric
      // we deliberately do not ask for would be "missing" on every single run,
      // and a warning that always fires is one everybody learns to scroll past
      // -- which would defeat the purpose of having it at all. The lost
      // impression share pair and the IO goal percentage were dropped from
      // here when they were dropped from the request.
    };
    const lower = headers.map(h => h.toLowerCase());
    const missing = Object.keys(expected).filter(
      label => !expected[label].some(p => lower.some(h => h.includes(p))));
    if (missing.length > 0) {
      console.warn(
        `DBM CSV is missing ${missing.length} expected metric column(s): ${missing.join(', ')}. ` +
        'These will be stored as 0. Either the metric was rejected by the report ' +
        'or the header was renamed -- check the mapper patterns in ' +
        'mapCsvRowToBq against the headers below.');
      console.warn(`DBM CSV headers received: ${headers.join(' | ')}`);
    } else {
      console.log(`All ${Object.keys(expected).length} previously-hardcoded metric columns are present in the CSV.`);
    }
  }

  if (parsedRows.length === 0) {
    return { success: true, count: 0, message: 'DBM CSV contained no data rows.' };
  }

  const bqRows = parsedRows.map(mapCsvRowToBq).filter(r => r.Insertion_Order_Id > 0 || r.Impressions > 0 || r.Revenue > 0 || r.Revenue_USD > 0);
  console.log(`Mapped ${bqRows.length} valid performance rows for BigQuery.`);

  await replaceTableRows(targetDatasetId, 'dbm_performance', bqRows);

  return { success: true, count: bqRows.length };
}

/**
 * Maps a row of the YouTube audience report CSV to dbm_audiences_performance.
 *
 * The column set is much narrower than it was, because the report this reads
 * is a YOUTUBE report rather than a STANDARD one (see
 * createOrGetAudienceReportQuery). Specifically absent, and not recoverable
 * here:
 *
 *   Partner / Partner_Id  -- FILTER_PARTNER is not in the groupBys; the report
 *                            is already filtered to one partner.
 *   Media_Plan(_Id)       -- FILTER_MEDIA_PLAN is rejected in this combination.
 *                            materialize_audiences.sql recovers campaign by
 *                            joining the insertion order instead.
 *   Line_Item(_Id)        -- accepted by the API but deliberately omitted, as
 *                            it multiplies rows without feeding the dashboard.
 *   conversions, VTC,     -- no conversion metric can coexist with the audience
 *   CM360 revenue            segment dimension. Every candidate was rejected at
 *                            create time.
 *
 * Audience_Segment carries a taxonomy path such as
 * "/Business Services/Business Financial Services", and Audience_Segment_Type
 * classifies it, e.g. "In-market segment". Neither has a numeric ID in this
 * report, which is why the old Audience_List_Id column is gone rather than
 * merely unpopulated.
 */
function mapAudienceCsvRowToBq(r) {
  const getCol = (patterns) => getColFrom(r, patterns);

  return {
    Report_Day: parseDate(getCol(['Report_Day', 'Date', 'Day'])),
    Advertiser_Id: intNum(getCol(['Advertiser ID', 'Advertiser_Id'])),
    Advertiser_Currency: getCol(['Advertiser Currency', 'Currency']) || '',
    Insertion_Order_Id: intNum(getCol(['Insertion Order ID', 'Insertion_Order_Id'])),
    // The exact headers are "Audience segment" and "Audience segment type",
    // lower-cased after the first word. The alternatives cover the Display
    // wording in case this ever reads a STANDARD report again.
    Audience_Segment: getCol(['Audience segment', 'Audience Segment', 'Audience List']) || '',
    Audience_Segment_Type:
        getCol(['Audience segment type', 'Audience Segment Type', 'Audience List Type']) || '',
    Revenue: num(getCol(['Media Cost (Advertiser Currency)', 'Media Cost (Adv Currency)'])),
    Revenue_USD: num(getCol(['Media Cost (USD)', 'Cost (USD)'])),
    Impressions: intNum(getCol(['Impressions'])),
    Clicks: intNum(getCol(['Clicks']))
  };
}


/**
 * Reads the partner's Demand Gen insertion orders from the synced entity table.
 *
 * Both the audience and the performance reports are scoped to these. Everything
 * DGPulse surfaces is Demand Gen -- every materialize_*.sql filters on it -- so
 * anything else pulled here is discarded downstream anyway. For the reference
 * partner that is 52 of 122 insertion orders.
 *
 * Returns an empty array rather than throwing when the table is missing or
 * empty, which is the expected state on a fresh install: line_items is
 * populated asynchronously by process_advertiser.js and may not have landed
 * when the reports are first set up. The query then falls back to partner scope
 * and is rebuilt on the next run, once the insertion orders are known.
 *
 * @param {string} targetDatasetId
 * @returns {!Promise<!Array<string>>}
 */
async function fetchDemandGenInsertionOrderIds(targetDatasetId) {
  try {
    // Unqualified dataset reference, resolved against the client's default
    // project -- the same assumption replaceTableRows already makes.
    const [rows] = await bigquery.query({
      query:
        'SELECT DISTINCT insertionOrderId ' +
        `FROM \`${targetDatasetId}.line_items\` ` +
        "WHERE lineItemType LIKE '%DEMAND_GEN%' AND insertionOrderId IS NOT NULL"
    });
    const ids = rows.map(r => String(r.insertionOrderId)).filter(Boolean);
    if (ids.length === 0) {
      console.warn(
        `No Demand Gen insertion orders found in ${targetDatasetId}.line_items. ` +
        'The audience and performance reports will be scoped to the whole ' +
        'partner, which is much slower and on a large partner produces a CSV ' +
        'too big to download; both are rescoped automatically once the entity ' +
        'sync has run.');
    } else {
      console.log(`Scoping audience and performance reports to ${ids.length} Demand Gen insertion order(s).`);
    }
    return ids;
  } catch (err) {
    console.warn(
      `Could not read Demand Gen insertion orders from ${targetDatasetId}.line_items ` +
      `(${err.message}). Falling back to partner-wide report scope.`);
    return [];
  }
}

/**
 * Downloads the latest DBM Audience report and ingests rows into BigQuery dbm_audiences_performance table.
 *
 * @param {string=} partnerIdOverride
 * @param {string=} datasetIdOverride
 * @param {{waitForReport: (boolean|undefined)}=} options Set waitForReport to
 *     false from anything running under a timeout. See the comment on the wait
 *     below.
 */
async function syncDbmAudienceReport(partnerIdOverride, datasetIdOverride, options) {
  const partnerId = partnerIdOverride || PARTNER_ID;
  const targetDatasetId = datasetIdOverride || process.env.DATASET_ID || (partnerId ? `dv360_dgpulse_${partnerId}` : DATASET_ID);
  if (!partnerId) throw new Error('PARTNER_ID is required.');

  const client = await initializeClient(partnerId);
  const insertionOrderIds = await fetchDemandGenInsertionOrderIds(targetDatasetId);
  const { queryId } =
    await client.createOrGetAudienceReportQuery(partnerId, insertionOrderIds);

  // Waiting is opt-in because report latency here is dominated by DV360's queue
  // and is not predictable: the same query has been observed completing in 91s,
  // 239s and 500s, of which only ~16s was actual generation. Nothing running
  // under the 540s Cloud Function timeout can safely wait for that.
  //
  // It does not need to. The query carries a DAILY schedule, so DV360 builds it
  // unprompted every morning and the sync just collects the finished file --
  // which is how the performance report has always worked, and why it has never
  // blocked. Installs run in Cloud Shell with no timeout, so they do wait, to
  // give a fresh deployment same-day data instead of an empty dashboard.
  const waitForReport = !options || options.waitForReport !== false;

  let downloadUrl = await client.getLatestReportDownloadUrl(queryId);
  if (!downloadUrl && !waitForReport) {
    return {
      success: true,
      count: 0,
      message: `No completed audience report available yet for query ${queryId}. ` +
               'DV360 builds it on its own daily schedule; it will be ingested ' +
               'on the next sync.'
    };
  }
  if (!downloadUrl) {
    console.log(`No completed audience report found yet for query ${queryId}. Triggering execution...`);

    // runQueryAndWait keys the wait on the reportId this run produced, which
    // matters for two reasons. It distinguishes a report that FAILED from one
    // that is merely slow -- the previous loop polled for any completed report
    // and so reported both as "data will be available on next sync", which
    // would hide a broken report indefinitely. It also cannot be satisfied by a
    // stale report from an earlier day.
    //
    // 20 minutes, against a worst observed time of 12m36s for the unscoped
    // query. This only ever runs at install time, where there is no timeout to
    // respect and an over-short window costs the operator a day of data.
    downloadUrl = await client.runQueryAndWait(queryId, { maxAttempts: 80, intervalMs: 15000 });
    if (!downloadUrl) {
      return { success: false, message: 'Audience report is still generating. Data will be available on next sync.' };
    }
  }

  console.log(`Downloading latest DBM Audience report from ${downloadUrl}...`);
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Failed to download audience report: ${response.statusText}`);
  }

  const csvText = await response.text();
  const parsedRows = parseCsv(csvText);
  console.log(`Parsed ${parsedRows.length} rows from DBM Audience CSV.`);

  if (parsedRows.length === 0) {
    return { success: true, count: 0, message: 'DBM Audience CSV contained no data rows.' };
  }

  const bqRows = parsedRows.map(mapAudienceCsvRowToBq).filter(r => r.Insertion_Order_Id > 0 || r.Impressions > 0 || r.Revenue > 0 || r.Revenue_USD > 0);
  console.log(`Mapped ${bqRows.length} valid audience performance rows for BigQuery.`);

  await replaceTableRows(targetDatasetId, 'dbm_audiences_performance', bqRows);

  return { success: true, count: bqRows.length };
}

/**
 * Maps CSV column names to BigQuery dbm_io_spend_daily table schema.
 */
function mapIoPacingCsvRowToBq(r) {
  const getCol = (patterns) => getColFrom(r, patterns);

  return {
    Report_Day: parseDate(getCol(['Report_Day', 'Date', 'Day'])),
    Partner_Id: intNum(getCol(['Partner ID', 'Partner_Id'])),
    Advertiser_Id: intNum(getCol(['Advertiser ID', 'Advertiser_Id'])),
    Advertiser_Currency: getCol(['Advertiser Currency', 'Currency']) || '',
    Insertion_Order: getCol(['Insertion Order Name', 'Insertion Order']) || '',
    Insertion_Order_Id: intNum(getCol(['Insertion Order ID', 'Insertion_Order_Id'])),
    Revenue: num(getCol(['Media Cost (Advertiser Currency)', 'Media Cost (Adv Currency)', 'Revenue (Adv Currency)'])),
    Revenue_USD: num(getCol(['Media Cost (USD)', 'Revenue (USD)'])),
    Impressions: intNum(getCol(['Impressions'])),
    Clicks: intNum(getCol(['Clicks']))
  };
}

/**
 * Downloads the ALL_TIME IO pacing report and ingests it into dbm_io_spend_daily.
 *
 * Budget pacing compares spend against an insertion order's budget, and that
 * budget can cover a flight of arbitrary length. dbm_performance cannot serve
 * this because it is capped at LAST_90_DAYS, which silently truncates spend for
 * any longer flight and makes every such insertion order look underpaced.
 */
async function syncDbmIoPacingReport(partnerIdOverride, datasetIdOverride) {
  const partnerId = partnerIdOverride || PARTNER_ID;
  const targetDatasetId = datasetIdOverride || process.env.DATASET_ID || (partnerId ? `dv360_dgpulse_${partnerId}` : DATASET_ID);
  if (!partnerId) throw new Error('PARTNER_ID is required.');

  const client = await initializeClient(partnerId);
  const { queryId } = await client.createOrGetIoPacingReportQuery(partnerId);

  // The pacing query is unscheduled (see createOrGetIoPacingReportQuery), so
  // DV360 never refreshes it on its own. Always trigger a run and wait for that
  // specific report; reusing the latest existing report would silently pin
  // pacing to whenever the query was first executed.
  // An ALL_TIME report covers the full account history, so allow a longer
  // window than the 90-day reports before giving up.
  const downloadUrl = await client.runQueryAndWait(queryId, { maxAttempts: 60, intervalMs: 5000 });
  if (!downloadUrl) {
    return { success: false, message: 'IO pacing report is still generating. Data will be available on next sync.' };
  }

  console.log(`Downloading latest DBM IO pacing report from ${downloadUrl}...`);
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Failed to download IO pacing report: ${response.statusText}`);
  }

  const csvText = await response.text();
  const parsedRows = parseCsv(csvText);
  console.log(`Parsed ${parsedRows.length} rows from DBM IO pacing CSV.`);

  if (parsedRows.length === 0) {
    return { success: true, count: 0, message: 'DBM IO pacing CSV contained no data rows.' };
  }

  const bqRows = parsedRows
    .map(mapIoPacingCsvRowToBq)
    .filter(r => r.Insertion_Order_Id > 0 && r.Report_Day);
  console.log(`Mapped ${bqRows.length} valid IO pacing rows for BigQuery.`);

  await replaceTableRows(targetDatasetId, 'dbm_io_spend_daily', bqRows);

  return { success: true, count: bqRows.length };
}

// CLI / Execution helper
if (require.main === module) {
  const partnerIdArg = process.argv[2] || process.env.PARTNER_ID;
  const action = process.argv[3] || 'sync';

  if (action === 'setup') {
    // allSettled, not all: a failure in one report definition must not hide
    // whether the other two were created successfully.
    // The audience and performance queries are both scoped to the Demand Gen
    // insertion orders, so setup has to resolve them here as well; otherwise it
    // would create partner-wide queries that the first sync then has to tear
    // down and rebuild.
    const reportDatasetId = process.env.DATASET_ID ||
        (partnerIdArg ? `dv360_dgpulse_${partnerIdArg}` : DATASET_ID);
    // Resolved once and awaited by both jobs. Looking it up per job would run
    // the same BigQuery query twice and log the scope twice, and the two
    // queries could disagree if the entity sync landed between them.
    const ioIdsPromise = fetchDemandGenInsertionOrderIds(reportDatasetId);
    const setupJobs = [
      {
        name: 'performance',
        promise: ioIdsPromise.then(ioIds => setupDbmReport(partnerIdArg, ioIds))
      },
      {
        name: 'audience',
        promise: Promise.all([
          initializeClient(partnerIdArg),
          ioIdsPromise
        ]).then(([c, ioIds]) => c.createOrGetAudienceReportQuery(partnerIdArg, ioIds))
      },
      { name: 'IO pacing', promise: initializeClient(partnerIdArg).then(c => c.createOrGetIoPacingReportQuery(partnerIdArg)) }
    ];
    Promise.allSettled(setupJobs.map(job => job.promise))
      .then(results => {
        let failures = 0;
        results.forEach((result, i) => {
          const name = setupJobs[i].name;
          if (result.status === 'fulfilled') {
            const queryId = (result.value && result.value.queryId) || 'ok';
            console.log(`DBM ${name} report query ready (${queryId}).`);
            return;
          }
          const err = result.reason || {};
          const apiMessage =
            (err.response && err.response.data && err.response.data.error && err.response.data.error.message) ||
            err.message ||
            String(err);
          console.error(`DBM ${name} report query FAILED: ${apiMessage}`);
          failures++;
        });
        console.log(`DBM Reports setup complete: ${results.length - failures}/${results.length} succeeded.`);
        process.exit(failures > 0 ? 1 : 0);
      })
      .catch(err => {
        console.error('Error setting up DBM reports:', err.message);
        process.exit(1);
      });
  } else {
    const syncJobs = [
      { name: 'performance', promise: syncDbmPerformanceReport(partnerIdArg) },
      { name: 'audience', promise: syncDbmAudienceReport(partnerIdArg) },
      { name: 'IO pacing', promise: syncDbmIoPacingReport(partnerIdArg) }
    ];
    Promise.allSettled(syncJobs.map(job => job.promise))
      .then(results => {
        // Previously this logged JSON.stringify(results), which serialised the
        // entire Gaxios error object -- request body, retry config and all --
        // for every failure, burying the one line that actually mattered.
        let failures = 0;
        results.forEach((result, i) => {
          const name = syncJobs[i].name;
          if (result.status === 'fulfilled') {
            const value = result.value || {};
            if (value.success === false) {
              console.warn(`DBM ${name} report did not complete: ${value.message}`);
            } else {
              console.log(`DBM ${name} report synced (${value.count} rows).`);
            }
            return;
          }
          const err = result.reason || {};
          const apiMessage =
            (err.response && err.response.data && err.response.data.error && err.response.data.error.message) ||
            err.message ||
            String(err);
          console.error(`DBM ${name} report FAILED: ${apiMessage}`);
          failures++;
        });
        console.log(`DBM Reports sync complete: ${results.length - failures}/${results.length} succeeded.`);
        process.exit(failures > 0 ? 1 : 0);
      })
      .catch(err => {
        console.error('Error syncing DBM reports:', err.message);
        process.exit(1);
      });
  }
}

module.exports = { setupDbmReport, syncDbmPerformanceReport, syncDbmAudienceReport, syncDbmIoPacingReport };
