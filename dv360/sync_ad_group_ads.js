/**
 * @fileoverview Fetches Demand Gen Ad Groups and Ad Group Ads from DV360 API v4
 * and stores them in BigQuery table `ad_group_ads` for 1:1 parity with Google Ads DGPulse.
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
const TABLE_ID = 'ad_group_ads';

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

  if (!credentials) throw new Error(`Missing ${CLIENT_SECRET_FILE} locally or in GCS bucket.`);
  if (!refreshToken) throw new Error('Missing REFRESH_TOKEN environment variable.');

  return new DV360Client(credentials, null, refreshToken);
}

async function ensureTable() {
  const schema = [
    { name: 'adGroupAdId', type: 'STRING', mode: 'REQUIRED' },
    { name: 'adGroupId', type: 'STRING', mode: 'NULLABLE' },
    { name: 'lineItemId', type: 'STRING', mode: 'NULLABLE' },
    { name: 'insertionOrderId', type: 'STRING', mode: 'NULLABLE' },
    { name: 'campaignId', type: 'STRING', mode: 'NULLABLE' },
    { name: 'advertiserId', type: 'STRING', mode: 'NULLABLE' },
    { name: 'displayName', type: 'STRING', mode: 'NULLABLE' },
    { name: 'entityStatus', type: 'STRING', mode: 'NULLABLE' },
    { name: 'adType', type: 'STRING', mode: 'NULLABLE' },
    { name: 'videos_count', type: 'INT64', mode: 'NULLABLE' },
    { name: 'horizontal_images_count', type: 'INT64', mode: 'NULLABLE' },
    { name: 'square_images_count', type: 'INT64', mode: 'NULLABLE' },
    { name: 'portrait_images_count', type: 'INT64', mode: 'NULLABLE' },
    { name: 'headlines_count', type: 'INT64', mode: 'NULLABLE' },
    { name: 'descriptions_count', type: 'INT64', mode: 'NULLABLE' },
    { name: 'created_at', type: 'TIMESTAMP', mode: 'NULLABLE' }
  ];

  const dataset = bigquery.dataset(DATASET_ID);
  const table = dataset.table(TABLE_ID);

  const [exists] = await table.exists();
  if (!exists) {
    console.log(`Creating BigQuery table ${DATASET_ID}.${TABLE_ID}...`);
    await dataset.createTable(TABLE_ID, { schema });
    console.log(`Table ${DATASET_ID}.${TABLE_ID} created.`);
  }
}

async function sync() {
  console.log('--- Starting Demand Gen Ad Group Ads Sync ---');
  await ensureTable();
  const client = await initializeClient();

  // Find Demand Gen line items and map to insertion orders & campaigns
  const [rows] = await bigquery.query({
    query: `SELECT DISTINCT 
              li.advertiserId, 
              li.lineItemId, 
              COALESCE(NULLIF(li.insertionOrderId, ''), CAST(dbm.Insertion_Order_Id AS STRING)) AS insertionOrderId,
              COALESCE(NULLIF(li.campaignId, ''), CAST(dbm.Media_Plan_Id AS STRING)) AS campaignId
            FROM \`${DATASET_ID}.line_items\` li
            LEFT JOIN \`${DATASET_ID}.dbm_performance\` dbm 
              ON CAST(li.lineItemId AS INT64) = dbm.Line_Item_Id
            WHERE li.lineItemType LIKE '%DEMAND_GEN%' 
               OR li.displayName LIKE '%DEMANDGEN%' 
               OR li.displayName LIKE '%DGEN%'`
  });

  console.log(`Found ${rows.length} Demand Gen line item configurations.`);

  const adRows = [];
  const now = new Date().toISOString();

  for (const row of rows) {
    const advId = row.advertiserId;
    const liId = row.lineItemId;
    let ioId = row.insertionOrderId || '';
    let campId = row.campaignId || '';

    // If ioId or campId is still missing, fetch Line Item directly via API
    if (!ioId || !campId) {
      try {
        const liObj = await client.dv360.advertisers.lineItems.get({
          advertiserId: advId,
          lineItemId: liId
        });
        if (liObj.data) {
          if (!ioId && liObj.data.insertionOrderId) ioId = String(liObj.data.insertionOrderId);
          if (!campId && liObj.data.campaignId) campId = String(liObj.data.campaignId);
        }
      } catch (e) {}
    }

    try {
      const agRes = await client.dv360.advertisers.adGroups.list({
        advertiserId: advId,
        filter: `lineItemId="${liId}"`
      });
      const ags = agRes.data.adGroups || [];

      for (const ag of ags) {
        const agId = ag.adGroupId;
        const adRes = await client.dv360.advertisers.adGroupAds.list({
          advertiserId: advId,
          filter: `adGroupId="${agId}"`
        });
        const ads = adRes.data.adGroupAds || [];

        for (const ad of ads) {
          const vAd = ad.demandGenVideoAd;
          const iAd = ad.demandGenImageAd;
          const cAd = ad.demandGenCarouselAd;
          const pAd = ad.demandGenProductAd;

          let adType = 'DEMAND_GEN_OTHER_AD';
          if (vAd) adType = 'DEMAND_GEN_VIDEO_AD';
          else if (iAd) adType = 'DEMAND_GEN_IMAGE_AD';
          else if (cAd) adType = 'DEMAND_GEN_CAROUSEL_AD';
          else if (pAd) adType = 'DEMAND_GEN_PRODUCT_AD';

          const headlinesCount = (vAd && vAd.headlines ? vAd.headlines.length : 0) + (iAd && iAd.headlines ? iAd.headlines.length : 0);
          const descriptionsCount = (vAd && vAd.descriptions ? vAd.descriptions.length : 0) + (iAd && iAd.descriptions ? iAd.descriptions.length : 0);
          const horizImgsCount = iAd && iAd.marketingImages ? iAd.marketingImages.length : 0;
          const squareImgsCount = iAd && iAd.squareMarketingImages ? iAd.squareMarketingImages.length : 0;
          const vertImgsCount = iAd && iAd.portraitMarketingImages ? iAd.portraitMarketingImages.length : 0;
          const videosCount = vAd && vAd.videos ? vAd.videos.length : 0;

          adRows.push({
            adGroupAdId: String(ad.adGroupAdId),
            adGroupId: String(agId),
            lineItemId: String(liId),
            insertionOrderId: String(ioId),
            campaignId: String(campId),
            advertiserId: String(advId),
            displayName: String(ad.displayName || ''),
            entityStatus: String(ad.entityStatus || ''),
            adType: adType,
            videos_count: videosCount,
            horizontal_images_count: horizImgsCount,
            square_images_count: squareImgsCount,
            portrait_images_count: vertImgsCount,
            headlines_count: headlinesCount,
            descriptions_count: descriptionsCount,
            created_at: now
          });
        }
      }
    } catch (err) {
      console.warn(`Warning processing line item ${liId}:`, err.message);
    }
  }

  console.log(`Processed ${adRows.length} Ad Group Ads.`);

  if (adRows.length > 0) {
    // Delete existing rows and insert fresh batch
    try {
      await bigquery.query({
        query: `DELETE FROM \`${DATASET_ID}.${TABLE_ID}\` WHERE true`
      });
    } catch (delErr) {
      // Table might be newly created or empty
    }

    // Insert in batches of 500
    for (let i = 0; i < adRows.length; i += 500) {
      const batch = adRows.slice(i, i + 500);
      await bigquery.dataset(DATASET_ID).table(TABLE_ID).insert(batch);
    }
    console.log(`✓ Successfully ingested ${adRows.length} Ad Group Ads into BigQuery ${DATASET_ID}.${TABLE_ID}.`);
  }
}

if (require.main === module) {
  sync().catch(console.error);
}

module.exports = { sync };
