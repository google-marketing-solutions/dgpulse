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
const DATASET_ID = process.env.DATASET_ID || 'dv360_dgpulse';

let dv360Client = null;

const fs = require('fs');

/**
 * Downloads client_secret.json from GCS or local filesystem and initializes DV360Client.
 */
async function initializeClient() {
  if (dv360Client) return dv360Client;

  let bucketName = process.env.BUCKET_NAME;
  let refreshToken = process.env.REFRESH_TOKEN;

  // 1. Check local .env file if missing
  if ((!bucketName || !refreshToken) && fs.existsSync('.env')) {
    const envContent = fs.readFileSync('.env', 'utf8');
    for (const line of envContent.split('\n')) {
      const [k, v] = line.split('=');
      if (k && v) {
        if (!bucketName && k.trim() === 'BUCKET_NAME') bucketName = v.trim().replace(/^"|"$/g, '');
        if (!refreshToken && k.trim() === 'REFRESH_TOKEN') refreshToken = v.trim().replace(/^"|"$/g, '');
      }
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
    throw new Error('Missing REFRESH_TOKEN environment variable.');
  }

  dv360Client = new DV360Client(
    credentials,
    null,
    refreshToken
  );

  return dv360Client;
}

/**
 * Parses standard CSV text with quote handling.
 */
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length === 0) return [];

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

  const headers = parseLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const rawLine = lines[i];
    if (rawLine.startsWith('Total') || rawLine.startsWith('Grand Total') || rawLine.startsWith(',')) {
      continue;
    }
    const cols = parseLine(rawLine);
    if (cols.length < headers.length) continue;
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = cols[idx];
    });
    rows.push(row);
  }
  return rows;
}

/**
 * Maps CSV column names to BigQuery dbm_performance table schema.
 */
function mapCsvRowToBq(r) {
  const parseDate = (d) => {
    if (!d) return null;
    const parts = d.split(/[\/\-]/);
    if (parts.length === 3) {
      if (parts[0].length === 4) return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
      return `${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
    }
    return d;
  };

  const getCol = (patterns) => {
    for (const key of Object.keys(r)) {
      for (const pat of patterns) {
        if (key.toLowerCase().includes(pat.toLowerCase())) {
          return r[key];
        }
      }
    }
    return null;
  };

  const num = (v) => {
    if (v === null || v === undefined || v === '') return 0;
    const cleaned = String(v).replace(/[^\d.-]/g, '');
    const n = Number(cleaned);
    return isNaN(n) ? 0 : n;
  };

  const intNum = (v) => {
    if (v === null || v === undefined || v === '') return 0;
    const cleaned = String(v).replace(/[^\d-]/g, '');
    const n = parseInt(cleaned, 10);
    return isNaN(n) ? 0 : n;
  };

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
    Post_Click_Conversions: 0,
    Post_View_Conversions: 0,
    CM_Post_Click_Revenue: 0,
    CM_Post_View_Revenue: 0,
    Percentage_From_Current_IO_Goal: 0,
    TrueView_Lost_IS_Budget: 0,
    TrueView_Lost_IS_Rank: 0
  };
}

/**
 * Ensures DBM performance query exists and triggers a run.
 */
async function setupDbmReport(partnerIdOverride) {
  const partnerId = partnerIdOverride || PARTNER_ID;
  if (!partnerId) {
    throw new Error('PARTNER_ID is required.');
  }

  const client = await initializeClient();
  const { queryId, isNew } = await client.createOrGetPerformanceReportQuery(partnerId);

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
async function syncDbmPerformanceReport(partnerIdOverride) {
  const partnerId = partnerIdOverride || PARTNER_ID;
  if (!partnerId) throw new Error('PARTNER_ID is required.');

  const client = await initializeClient();
  const { queryId } = await client.createOrGetPerformanceReportQuery(partnerId);

  const downloadUrl = await client.getLatestReportDownloadUrl(queryId);
  if (!downloadUrl) {
    console.log(`No completed report found yet for query ${queryId}. Triggering execution...`);
    try {
      await client.runQuery(queryId);
    } catch (e) {
      console.warn('Warning triggering DBM query:', e.message);
    }
    return { success: false, message: 'Report execution triggered. Data will be available on next sync.' };
  }

  console.log(`Downloading latest DBM report from ${downloadUrl}...`);
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Failed to download report: ${response.statusText}`);
  }

  const csvText = await response.text();
  const parsedRows = parseCsv(csvText);
  console.log(`Parsed ${parsedRows.length} rows from DBM CSV.`);

  if (parsedRows.length === 0) {
    return { success: true, count: 0, message: 'DBM CSV contained no data rows.' };
  }

  const bqRows = parsedRows.map(mapCsvRowToBq).filter(r => r.Insertion_Order_Id > 0 || r.Impressions > 0 || r.Revenue > 0 || r.Revenue_USD > 0);
  console.log(`Mapped ${bqRows.length} valid performance rows for BigQuery.`);

  if (bqRows.length > 0) {
    try {
      const dataset = bigquery.dataset(DATASET_ID);
      const [table] = await dataset.table('dbm_performance').get();
      const pId = (table.metadata && table.metadata.tableReference && table.metadata.tableReference.projectId) || bigquery.projectId || process.env.PROJECT_ID;
      if (pId) {
        await bigquery.query({
          query: `TRUNCATE TABLE \`${pId}.${DATASET_ID}.dbm_performance\`;`
        });
      }
    } catch (delErr) {
      console.warn('Warning clearing dbm_performance table:', delErr.message);
    }

    const batchSize = 500;
    for (let i = 0; i < bqRows.length; i += batchSize) {
      const batch = bqRows.slice(i, i + batchSize);
      await bigquery.dataset(DATASET_ID).table('dbm_performance').insert(batch);
    }
    console.log(`Successfully inserted ${bqRows.length} rows into ${DATASET_ID}.dbm_performance.`);
  }

  return { success: true, count: bqRows.length };
}

// CLI / Execution helper
if (require.main === module) {
  const partnerIdArg = process.argv[2] || process.env.PARTNER_ID;
  const action = process.argv[3] || 'sync';

  if (action === 'setup') {
    setupDbmReport(partnerIdArg)
      .then(result => {
        console.log('DBM Report setup complete:', JSON.stringify(result));
        process.exit(0);
      })
      .catch(err => {
        console.error('Error setting up DBM report:', err);
        process.exit(1);
      });
  } else {
    syncDbmPerformanceReport(partnerIdArg)
      .then(result => {
        console.log('DBM Report sync complete:', JSON.stringify(result));
        process.exit(0);
      })
      .catch(err => {
        console.error('Error syncing DBM report:', err);
        process.exit(1);
      });
  }
}

module.exports = { setupDbmReport, syncDbmPerformanceReport };
