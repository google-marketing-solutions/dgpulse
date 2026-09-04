const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { BigQuery } = require('@google-cloud/bigquery');

let PROJECT_ID = process.env.PROJECT_ID;
const DATASET_ID = process.env.DATASET_ID || 'dv360_dgpulse';
let PARTNER_ID = process.env.PARTNER_ID;
let SERVICE_ACCOUNT = process.env.SERVICE_ACCOUNT;
const LOCATION = process.env.LOCATION || process.env.REGION || 'US';

async function ensureTableSchema() {
  console.log('Ensuring all BigQuery table columns exist...');
  const bigquery = new BigQuery({ projectId: PROJECT_ID });
  const alterQueries = [
    `ALTER TABLE \`${PROJECT_ID}.${DATASET_ID}.line_items\` ADD COLUMN IF NOT EXISTS insertionOrderId STRING;`,
    `ALTER TABLE \`${PROJECT_ID}.${DATASET_ID}.dbm_performance\` ADD COLUMN IF NOT EXISTS Revenue_USD FLOAT64, ADD COLUMN IF NOT EXISTS Line_Item STRING, ADD COLUMN IF NOT EXISTS Line_Item_Id INT64;`,
    `ALTER TABLE \`${PROJECT_ID}.${DATASET_ID}.advertisers\` ADD COLUMN IF NOT EXISTS currencyCode STRING;`,
    `ALTER TABLE \`${PROJECT_ID}.${DATASET_ID}.advertiser_settings\` ADD COLUMN IF NOT EXISTS currency_code STRING;`,
    `ALTER TABLE \`${PROJECT_ID}.${DATASET_ID}.creatives\` ADD COLUMN IF NOT EXISTS approvalStatus STRING;`,
    `ALTER TABLE \`${PROJECT_ID}.${DATASET_ID}.ad_group_ads\` ADD COLUMN IF NOT EXISTS approvalStatus STRING, ADD COLUMN IF NOT EXISTS video_id STRING, ADD COLUMN IF NOT EXISTS aspect_ratio FLOAT64;`,
    `CREATE TABLE IF NOT EXISTS \`${PROJECT_ID}.${DATASET_ID}.video_aspect_ratio\` (
      video_id STRING,
      aspect_ratio FLOAT64,
      updated_at TIMESTAMP
    );`,
    `CREATE TABLE IF NOT EXISTS \`${PROJECT_ID}.${DATASET_ID}.dbm_audiences_performance\` (
      Report_Day DATE,
      Partner STRING,
      Partner_Id INT64,
      Advertiser STRING,
      Advertiser_Id INT64,
      Advertiser_Currency STRING,
      Media_Plan STRING,
      Media_Plan_Id INT64,
      Insertion_Order STRING,
      Insertion_Order_Id INT64,
      Line_Item STRING,
      Line_Item_Id INT64,
      Audience_List STRING,
      Audience_List_Id INT64,
      Audience_List_Type STRING,
      Revenue FLOAT64,
      Revenue_USD FLOAT64,
      Impressions INT64,
      Clicks INT64,
      Total_Conversions FLOAT64,
      Post_View_Conversions FLOAT64,
      Post_Click_Conversions FLOAT64,
      CM_Post_Click_Revenue FLOAT64,
      CM_Post_View_Revenue FLOAT64
    );`
  ];
  for (const q of alterQueries) {
    try {
      await bigquery.query({ query: q });
    } catch (e) {
      // Ignore if table doesn't exist yet or already altered
    }
  }
}

async function setupScheduledQueries() {
  if (!PROJECT_ID) {
    try {
      const { execSync } = require('child_process');
      PROJECT_ID = execSync('gcloud config get-value project', { encoding: 'utf8' }).trim();
    } catch (e) {}
  }
  if (!PROJECT_ID) {
    PROJECT_ID = 'cse-dub-hackathon-test';
  }

  if (!PARTNER_ID) {
    try {
      const bqTemp = new BigQuery({ projectId: PROJECT_ID });
      const [rows] = await bqTemp.query({
        query: `SELECT partnerId FROM \`${PROJECT_ID}.${DATASET_ID}.advertisers\` WHERE partnerId IS NOT NULL AND partnerId != '' LIMIT 1`
      });
      if (rows && rows[0] && rows[0].partnerId) {
        PARTNER_ID = rows[0].partnerId;
        console.log(`Auto-detected PARTNER_ID from BigQuery: ${PARTNER_ID}`);
      }
    } catch (e) {}
  }

  if (!PARTNER_ID) {
    try {
      const { execSync } = require('child_process');
      const envJson = execSync(
        'gcloud functions describe dv360-dgpulse --region=us-central1 --format="json(serviceConfig.environmentVariables)" 2>/dev/null',
        { encoding: 'utf8' }
      );
      if (envJson) {
        const parsed = JSON.parse(envJson);
        const envVars = (parsed.serviceConfig && parsed.serviceConfig.environmentVariables) || parsed;
        if (envVars.PARTNER_ID) {
          PARTNER_ID = envVars.PARTNER_ID;
          console.log(`Auto-detected PARTNER_ID from Cloud Function env: ${PARTNER_ID}`);
        }
      }
    } catch (e) {}
  }

  if (!PARTNER_ID) {
    PARTNER_ID = '796100066';
  }

  if (!PROJECT_ID || !PARTNER_ID) {
    throw new Error('PROJECT_ID and PARTNER_ID are required.');
  }

  console.log(`Setting up scheduled queries for Project: ${PROJECT_ID}, Partner: ${PARTNER_ID}...`);
  await ensureTableSchema();

  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  });
  const client = await auth.getClient();
  const datatransfer = google.bigquerydatatransfer({ version: 'v1', auth: client });

  const sqlFiles = [
    'materialize_campaigns.sql',
    'materialize_line_items.sql',
    'materialize_insertion_orders.sql',
    'materialize_assets.sql',
    'materialize_audiences.sql',
    'materialize_creative_variety.sql',
    'materialize_floodlight_activities.sql'
  ];

  // List existing transfer configs for the project across locations
  const locationsToSearch = [LOCATION, 'US', 'us-central1', 'EU', 'europe-west1'];
  const uniqueLocations = Array.from(new Set(locationsToSearch));

  let existingConfigs = [];
  for (const loc of uniqueLocations) {
    try {
      const parent = `projects/${PROJECT_ID}/locations/${loc}`;
      const res = await datatransfer.projects.locations.transferConfigs.list({ parent });
      if (res.data.transferConfigs) {
        existingConfigs.push(...res.data.transferConfigs);
      }
    } catch (e) {
      // Location might not be valid or have configs, ignore
    }
  }

  try {
    const res = await datatransfer.projects.transferConfigs.list({ parent: `projects/${PROJECT_ID}` });
    if (res.data.transferConfigs) {
      existingConfigs.push(...res.data.transferConfigs);
    }
  } catch (e) {}

  for (const sqlFile of sqlFiles) {
    const viewName = path.basename(sqlFile, '.sql');
    const displayName = `Materialize DV360 ${viewName} Daily`;
    const rawSql = fs.readFileSync(sqlFile, 'utf8');
    const processedSql = rawSql
      .replace(/__PROJECT_ID__/g, PROJECT_ID)
      .replace(/__DATASET_ID__/g, DATASET_ID)
      .replace(/__PARTNER_ID__/g, PARTNER_ID);

    const matchingConfig = existingConfigs.find(c => c.displayName === displayName);

    const transferConfigBody = {
      displayName: displayName,
      dataSourceId: 'scheduled_query',
      destinationDatasetId: DATASET_ID,
      schedule: 'every day 08:00',
      params: {
        query: processedSql
      }
    };
    if (SERVICE_ACCOUNT) {
      transferConfigBody.serviceAccountName = SERVICE_ACCOUNT;
    }

    if (matchingConfig) {
      console.log(`Refreshing existing Scheduled Query: ${displayName} (${matchingConfig.name})...`);
      try {
        await datatransfer.projects.locations.transferConfigs.delete({ name: matchingConfig.name });
      } catch (delErr) {
        console.warn(`Warning removing old config ${matchingConfig.name}:`, delErr.message);
      }
    }

    console.log(`Creating fresh Scheduled Query: ${displayName}...`);
    try {
      let targetRegion = 'us-central1';
      try {
        const [meta] = await bigquery.dataset(DATASET_ID).getMetadata();
        if (meta && meta.location) targetRegion = meta.location.toLowerCase();
      } catch (e) {}

      const parent = `projects/${PROJECT_ID}/locations/${targetRegion}`;
      await datatransfer.projects.locations.transferConfigs.create({
        parent: parent,
        requestBody: transferConfigBody
      });
      console.log(`Successfully created Scheduled Query: ${displayName}`);
    } catch (createErr) {
      console.error(`Error creating Scheduled Query ${displayName}:`, createErr.message);
    }
  }

  console.log('All Scheduled Queries refreshed in BigQuery Data Transfer Service.');

  // Ingest real Demand Gen Ad Group Ads before materializing creative variety
  try {
    const { sync } = require('./sync_ad_group_ads');
    await sync();
  } catch (syncErr) {
    console.warn('Warning syncing ad group ads:', syncErr.message);
  }

  // Run immediate materialization queries to update BigQuery tables right now
  console.log('Running immediate materialization queries across all tables...');
  const bigquery = new BigQuery({ projectId: PROJECT_ID });
  for (const sqlFile of sqlFiles) {
    console.log(`Materializing ${sqlFile}...`);
    const rawSql = fs.readFileSync(sqlFile, 'utf8');
    const processedSql = rawSql
      .replace(/__PROJECT_ID__/g, PROJECT_ID)
      .replace(/__DATASET_ID__/g, DATASET_ID)
      .replace(/__PARTNER_ID__/g, PARTNER_ID);
    try {
      await bigquery.query({ query: processedSql });
      console.log(`✓ Successfully materialized ${sqlFile}`);
    } catch (queryErr) {
      console.error(`✗ Error materializing ${sqlFile}:`, queryErr.message);
    }
  }
}

if (require.main === module) {
  setupScheduledQueries()
    .then(() => {
      console.log('All Scheduled Queries setup and materialization completed successfully.');
      process.exit(0);
    })
    .catch(err => {
      console.error('Failed to setup scheduled queries:', err);
      process.exit(1);
    });
}

module.exports = { setupScheduledQueries };
