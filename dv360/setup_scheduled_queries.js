const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { BigQuery } = require('@google-cloud/bigquery');

const PROJECT_ID = process.env.PROJECT_ID;
const DATASET_ID = process.env.DATASET_ID || 'dv360_dgpulse';
const PARTNER_ID = process.env.PARTNER_ID;
const SERVICE_ACCOUNT = process.env.SERVICE_ACCOUNT;
const LOCATION = process.env.LOCATION || process.env.REGION || 'US';

async function ensureTableSchema() {
  console.log('Ensuring all BigQuery table columns exist...');
  const bigquery = new BigQuery({ projectId: PROJECT_ID });
  const alterQueries = [
    `ALTER TABLE \`${PROJECT_ID}.${DATASET_ID}.line_items\` ADD COLUMN IF NOT EXISTS insertionOrderId STRING;`,
    `ALTER TABLE \`${PROJECT_ID}.${DATASET_ID}.dbm_performance\` ADD COLUMN IF NOT EXISTS Revenue_USD FLOAT64, ADD COLUMN IF NOT EXISTS Line_Item STRING, ADD COLUMN IF NOT EXISTS Line_Item_Id INT64;`,
    `ALTER TABLE \`${PROJECT_ID}.${DATASET_ID}.advertisers\` ADD COLUMN IF NOT EXISTS currencyCode STRING;`,
    `ALTER TABLE \`${PROJECT_ID}.${DATASET_ID}.advertiser_settings\` ADD COLUMN IF NOT EXISTS currency_code STRING;`,
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
  if (!PROJECT_ID || !PARTNER_ID) {
    throw new Error('PROJECT_ID and PARTNER_ID are required.');
  }

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
      console.log(`Updating existing Scheduled Query: ${displayName} (${matchingConfig.name})...`);
      try {
        await datatransfer.projects.locations.transferConfigs.patch({
          name: matchingConfig.name,
          updateMask: 'params,schedule,destinationDatasetId',
          requestBody: transferConfigBody
        });
        console.log(`Successfully updated Scheduled Query: ${displayName}`);
      } catch (patchErr) {
        console.warn(`Patch failed for ${matchingConfig.name}, recreating:`, patchErr.message);
        try {
          await datatransfer.projects.locations.transferConfigs.delete({ name: matchingConfig.name });
          const parent = `projects/${PROJECT_ID}/locations/${matchingConfig.datasetRegion || LOCATION || 'US'}`;
          await datatransfer.projects.locations.transferConfigs.create({
            parent: parent,
            requestBody: transferConfigBody
          });
          console.log(`Successfully recreated Scheduled Query: ${displayName}`);
        } catch (recreateErr) {
          console.error(`Error recreating ${displayName}:`, recreateErr.message);
        }
      }
    } else {
      console.log(`Creating new Scheduled Query: ${displayName}...`);
      try {
        const parent = `projects/${PROJECT_ID}/locations/${LOCATION || 'US'}`;
        await datatransfer.projects.locations.transferConfigs.create({
          parent: parent,
          requestBody: transferConfigBody
        });
        console.log(`Successfully created Scheduled Query: ${displayName}`);
      } catch (createErr) {
        console.error(`Error creating Scheduled Query ${displayName}:`, createErr.message);
      }
    }
  }

  console.log('All Scheduled Queries setup/update complete.');
}

if (require.main === module) {
  setupScheduledQueries()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Failed to setup scheduled queries:', err);
      process.exit(1);
    });
}

module.exports = { setupScheduledQueries };
