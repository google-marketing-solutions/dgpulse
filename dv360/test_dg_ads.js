/**
 * Diagnostic script to inspect Demand Gen line items, ad groups, and ad group ads
 * directly from DV360 API v4 for partner / advertiser.
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

async function run() {
  console.log('--- Inspecting Demand Gen Entities in DV360 ---');
  const client = await initializeClient();

  // 1. Find Demand Gen line items in BigQuery
  const [rows] = await bigquery.query({
    query: `SELECT DISTINCT advertiserId, lineItemId, insertionOrderId, displayName, lineItemType 
            FROM \`${DATASET_ID}.line_items\` 
            WHERE lineItemType LIKE '%DEMAND_GEN%' OR displayName LIKE '%DEMANDGEN%' OR displayName LIKE '%DGEN%'`
  });

  console.log(`Found ${rows.length} Demand Gen Line Items in BigQuery:`);
  console.log(JSON.stringify(rows, null, 2));

  for (const row of rows) {
    const advId = row.advertiserId;
    const liId = row.lineItemId;
    console.log(`\n=== Checking Advertiser ${advId} (Line Item: ${liId} - ${row.displayName}) ===`);

    // Check Ad Groups
    try {
      const res = await client.dv360.advertisers.adGroups.list({
        advertiserId: advId,
        filter: `lineItemId="${liId}"`
      });
      const ags = res.data.adGroups || [];
      console.log(`Found ${ags.length} Ad Groups under Line Item ${liId}:`);
      console.log(JSON.stringify(ags, null, 2));

      for (const ag of ags) {
        try {
          const adsRes = await client.dv360.advertisers.adGroupAds.list({
            advertiserId: advId,
            filter: `adGroupId="${ag.adGroupId}"`
          });
          const ads = adsRes.data.adGroupAds || [];
          console.log(`  Found ${ads.length} Ad Group Ads under Ad Group ${ag.adGroupId}:`);
          console.log(JSON.stringify(ads, null, 2));
        } catch (adErr) {
          console.warn(`  Could not fetch adGroupAds for adGroup ${ag.adGroupId}:`, adErr.message);
        }
      }
    } catch (agErr) {
      console.warn(`Could not fetch adGroups for line item ${liId}:`, agErr.message);
    }
  }
}

run().catch(console.error);
