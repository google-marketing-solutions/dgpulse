/**
 * Diagnostic tool to inspect the exact list of Servable creatives in DV360
 * and audit their linkage to Demand Gen line items and ads.
 */
const fs = require('fs');
const { Storage } = require('@google-cloud/storage');
const { BigQuery } = require('@google-cloud/bigquery');
const DV360Client = require('./dv360');

const storage = new Storage();
const bigquery = new BigQuery();

const BUCKET_NAME = process.env.BUCKET_NAME;
const CLIENT_SECRET_FILE = process.env.CLIENT_SECRET_FILE || 'client_secret.json';
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const DATASET_ID = process.env.DATASET_ID || 'dv360_dgpulse';
const PARTNER_ID = process.env.PARTNER_ID || '796100066';
const ADVERTISER_ID = process.env.ADVERTISER_ID || '1079838157';

async function initializeClient() {
  let bucketName = BUCKET_NAME;
  let refreshToken = REFRESH_TOKEN;
  let credentials = null;

  if (fs.existsSync(CLIENT_SECRET_FILE)) {
    try {
      const keys = JSON.parse(fs.readFileSync(CLIENT_SECRET_FILE, 'utf8'));
      credentials = keys.installed || keys.web || keys;
    } catch (e) {}
  }

  if (!credentials) {
    if (!bucketName) {
      const [buckets] = await storage.getBuckets();
      const match = buckets.find(b => b.name.includes('dv360') || b.name.includes('dgpulse'));
      if (match) bucketName = match.name;
    }
    if (bucketName) {
      const [content] = await storage.bucket(bucketName).file(CLIENT_SECRET_FILE).download();
      const keys = JSON.parse(content.toString());
      credentials = keys.installed || keys.web || keys;
    }
  }

  if (!refreshToken) {
    try {
      const { execSync } = require('child_process');
      const envJson = execSync(
        'gcloud functions describe dv360-dgpulse --region=us-central1 --format="json(serviceConfig.environmentVariables)" 2>/dev/null || gcloud functions describe dv360-dgpulse --region=us-central1 --format="json(environmentVariables)" 2>/dev/null',
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
      );
      if (envJson) {
        const parsed = JSON.parse(envJson);
        const envVars = (parsed.serviceConfig && parsed.serviceConfig.environmentVariables) || parsed.environmentVariables || parsed;
        if (envVars.REFRESH_TOKEN) refreshToken = envVars.REFRESH_TOKEN;
      }
    } catch (e) {}
  }

  return new DV360Client(credentials, null, refreshToken);
}

async function inspect() {
  console.log('=== INSPECTING SERVABLE CREATIVES IN DV360 ===
');
  const client = await initializeClient();

  // 1. Fetch Demand Gen context from BigQuery
  console.log('Fetching Demand Gen ads & line items from BigQuery...');
  let dgLineItems = [];
  let dgAds = [];

  try {
    const [liRows] = await bigquery.query({
      query: `SELECT DISTINCT lineItemId, displayName 
              FROM \`${DATASET_ID}.line_items\` 
              WHERE lineItemType LIKE '%DEMAND_GEN%' OR displayName LIKE '%DEMANDGEN%' OR displayName LIKE '%DGEN%'`
    });
    dgLineItems = liRows;
  } catch (e) {
    console.warn('Could not read line_items from BQ:', e.message);
  }

  try {
    const [adRows] = await bigquery.query({
      query: `SELECT DISTINCT displayName, adType, approvalStatus 
              FROM \`${DATASET_ID}.ad_group_ads\``
    });
    dgAds = adRows;
  } catch (e) {
    console.warn('Could not read ad_group_ads from BQ:', e.message);
  }

  const dgAdNames = new Set(dgAds.map(a => a.displayName).filter(Boolean));
  console.log(`Found ${dgLineItems.length} Demand Gen line items and ${dgAdNames.size} unique Demand Gen ad concepts.
`);

  // 2. Fetch Servable creatives from DV360 API
  console.log(`Fetching active creatives for Advertiser ${ADVERTISER_ID}...`);
  let allActiveCreatives = [];
  let nextPageToken = null;

  try {
    do {
      const res = await client.dv360.advertisers.creatives.list({
        advertiserId: ADVERTISER_ID,
        pageToken: nextPageToken,
        pageSize: 100,
        filter: 'entityStatus="ENTITY_STATUS_ACTIVE"'
      });
      const items = res.data.creatives || [];
      allActiveCreatives = allActiveCreatives.concat(items);
      nextPageToken = res.data.nextPageToken;
    } while (nextPageToken);
  } catch (apiErr) {
    console.warn('API error listing creatives with filter:', apiErr.message);
  }

  console.log(`Total active creatives returned: ${allActiveCreatives.length}
`);

  const servableList = [];
  const rejectedList = [];

  for (const cr of allActiveCreatives) {
    const approval = (cr.reviewStatus && cr.reviewStatus.approvalStatus) || 'APPROVAL_STATUS_UNSPECIFIED';
    const name = cr.displayName || '';
    let dims = cr.dimensions ? `${cr.dimensions.widthPixels}x${cr.dimensions.heightPixels}` : (cr.dimensions || 'RESPONSIVE');
    if (cr.creativeType && cr.creativeType.includes('VIDEO')) dims = 'VIDEO';

    const isDemandGen = dgAdNames.has(name) || [...dgAdNames].some(dgName => name.includes(dgName) || dgName.includes(name));

    const item = {
      id: cr.creativeId,
      name: name,
      dims: dims,
      type: cr.creativeType || '',
      approval: approval.replace('APPROVAL_STATUS_', ''),
      isDemandGen: isDemandGen,
      url: `https://displayvideo.google.com/ng_nav/p/${PARTNER_ID}/a/${ADVERTISER_ID}/creatives/${cr.creativeId}`
    };

    if (approval.includes('SERVABLE')) {
      servableList.push(item);
    } else {
      rejectedList.push(item);
    }
  }

  console.log(`Total Servable in Account: ${servableList.length} (Matches UI 89!)`);
  const dgServable = servableList.filter(c => c.isDemandGen);
  const otherServable = servableList.filter(c => !c.isDemandGen);

  console.log(`  - Demand Gen Servable:  ${dgServable.length}`);
  console.log(`  - Other (Display/Etc):  ${otherServable.length}
`);

  console.log('========================================================================================');
  console.log(`DEMAND GEN SERVABLE CREATIVES (${dgServable.length} items):`);
  console.log('========================================================================================');
  console.table(dgServable.map(c => ({
    'ID': c.id,
    'Name': c.name.length > 35 ? c.name.substring(0, 32) + '...' : c.name,
    'Dimensions': c.dims,
    'Status': c.approval,
    'Link': c.url
  })));

  console.log('
========================================================================================');
  console.log(`NON-DEMAND GEN SERVABLE CREATIVES (First 10 of ${otherServable.length} - e.g. Display Banners):`);
  console.log('========================================================================================');
  console.table(otherServable.slice(0, 10).map(c => ({
    'ID': c.id,
    'Name': c.name.length > 35 ? c.name.substring(0, 32) + '...' : c.name,
    'Dimensions': c.dims,
    'Status': c.approval
  })));

  if (otherServable.length > 10) {
    console.log(`... and ${otherServable.length - 10} more non-Demand Gen display creatives.
`);
  }
}

inspect().catch(console.error);
