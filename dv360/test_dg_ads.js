/**
 * Concise summary script to inspect Demand Gen assets in DV360 API v4.
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
  const client = await initializeClient();

  const [rows] = await bigquery.query({
    query: `SELECT DISTINCT advertiserId, lineItemId, insertionOrderId, displayName 
            FROM \`${DATASET_ID}.line_items\` 
            WHERE lineItemType = 'LINE_ITEM_TYPE_DEMAND_GEN'`
  });

  const summary = [];

  for (const row of rows) {
    try {
      const agRes = await client.dv360.advertisers.adGroups.list({
        advertiserId: row.advertiserId,
        filter: `lineItemId="${row.lineItemId}"`
      });
      const ags = agRes.data.adGroups || [];

      for (const ag of ags) {
        const adRes = await client.dv360.advertisers.adGroupAds.list({
          advertiserId: row.advertiserId,
          filter: `adGroupId="${ag.adGroupId}"`
        });
        const ads = adRes.data.adGroupAds || [];

        for (const ad of ads) {
          const vAd = ad.demandGenVideoAd;
          const iAd = ad.demandGenImageAd;

          const headlines = (vAd && vAd.headlines ? vAd.headlines.length : 0) + (iAd && iAd.headlines ? iAd.headlines.length : 0);
          const descriptions = (vAd && vAd.descriptions ? vAd.descriptions.length : 0) + (iAd && iAd.descriptions ? iAd.descriptions.length : 0);
          const horizImgs = iAd && iAd.marketingImages ? iAd.marketingImages.length : 0;
          const squareImgs = iAd && iAd.squareMarketingImages ? iAd.squareMarketingImages.length : 0;
          const vertImgs = iAd && iAd.portraitMarketingImages ? iAd.portraitMarketingImages.length : 0;
          const videos = vAd && vAd.videos ? vAd.videos.length : 0;

          summary.push({
            'IO ID': row.insertionOrderId,
            'Line Item': row.displayName.substring(0, 30) + '...',
            'Ad Name': ad.displayName.substring(0, 25),
            'Type': vAd ? 'Video' : (iAd ? 'Image' : 'Other'),
            'Videos': videos,
            'Horiz Img': horizImgs,
            'Square Img': squareImgs,
            'Vert Img': vertImgs,
            'Headlines': headlines,
            'Desc': descriptions
          });
        }
      }
    } catch (e) {
      console.warn(`Error on LI ${row.lineItemId}:`, e.message);
    }
  }

  console.log('\n--- DEMAND GEN ASSET COUNTS SUMMARY ---');
  if (summary.length > 0) {
    console.table(summary);
  } else {
    console.log('No Demand Gen ad group ads found.');
  }
}

run().catch(console.error);
