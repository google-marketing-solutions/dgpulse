/**
 * @fileoverview Seeds synthetic demo dataset for DV360 DGPulse Looker Studio template walkthroughs.
 * Usage: node seed_demo_data.js [datasetId] [projectId]
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { BigQuery } = require('@google-cloud/bigquery');

async function resolveProjectId(argProject) {
  if (argProject && argProject !== '{{projectId}}') return argProject;
  if (process.env.PROJECT_ID && process.env.PROJECT_ID !== '{{projectId}}') return process.env.PROJECT_ID;
  if (process.env.GOOGLE_CLOUD_PROJECT && process.env.GOOGLE_CLOUD_PROJECT !== '{{projectId}}') return process.env.GOOGLE_CLOUD_PROJECT;

  // Try gcloud config in Cloud Shell / local terminal
  try {
    const gcloudProj = execSync('gcloud config get-value project 2>/dev/null', { encoding: 'utf8' }).trim();
    if (gcloudProj && gcloudProj !== '(unset)' && !gcloudProj.includes('ERROR')) {
      return gcloudProj;
    }
  } catch (e) {}

  // Try GoogleAuth from googleapis / google-auth-library
  try {
    const { GoogleAuth } = require('google-auth-library');
    const auth = new GoogleAuth();
    const authProj = await auth.getProjectId();
    if (authProj && authProj !== '{{projectId}}') {
      return authProj;
    }
  } catch (e) {}

  throw new Error(
    'Could not resolve Google Cloud project ID. Please set PROJECT_ID (e.g. PROJECT_ID=my-project npm run seed:demo).'
  );
}

async function main() {
  const datasetId = process.argv[2] || process.env.DEMO_DATASET_ID || 'dv360_dgpulse_demo';
  const projectId = await resolveProjectId(process.argv[3]);
  const bigquery = new BigQuery({ projectId });

  // Match install.sh, which creates the real dataset with
  // `bq mk --dataset --location=${REGION}`. A demo dataset in the US
  // multi-region cannot be joined against a regional production dataset, which
  // makes schema comparison between the two impossible.
  const requestedLocation = process.env.LOCATION || process.env.REGION || 'us-central1';

  console.log(`=================================================================`);
  console.log(`🚀 Seeding DV360 DGPulse Demo Dataset`);
  console.log(`Project: ${projectId}`);
  console.log(`Dataset: ${datasetId}`);
  console.log(`=================================================================\n`);

  // Ensure dataset exists
  const dataset = bigquery.dataset(datasetId);
  const [exists] = await dataset.exists();
  let location = requestedLocation;
  if (!exists) {
    console.log(`Creating dataset ${datasetId} in location ${location}...`);
    await bigquery.createDataset(datasetId, { location });
    console.log(`Dataset ${datasetId} created.`);
  } else {
    // Never assume: an existing dataset's location cannot be changed, so read
    // it back and submit the query jobs there.
    const [metadata] = await dataset.getMetadata();
    location = metadata.location || requestedLocation;
    console.log(`Dataset ${datasetId} already exists (location: ${location}).`);
    if (location !== requestedLocation) {
      console.log(
        `⚠️  Existing location ${location} differs from the expected ${requestedLocation}. ` +
        `A dataset's location is immutable -- drop and re-run to change it.`
      );
    }
  }

  const sqlPath = path.join(__dirname, 'generate_demo_data.sql');
  if (!fs.existsSync(sqlPath)) {
    throw new Error(`Cannot find generate_demo_data.sql at ${sqlPath}`);
  }

  let sqlContent = fs.readFileSync(sqlPath, 'utf8');
  sqlContent = sqlContent
    .replace(/__PROJECT_ID__/g, projectId)
    .replace(/__DATASET_ID__/g, datasetId)
    .replace(/__PARTNER_ID__/g, 'partner_9901');

  // Split into individual CREATE OR REPLACE statements. Views are included as
  // well as tables: final_io_pacing_current is a view, and it backs six charts.
  // Statements run in file order, so a view always follows the table it reads.
  const statements = sqlContent
    .split(/;\s*$/m)
    .map(s => s.trim())
    .filter(s => s.length > 0 && /CREATE OR REPLACE (TABLE|VIEW)/i.test(s));

  console.log(`Found ${statements.length} table/view creation statements in generate_demo_data.sql.\n`);

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    const match = stmt.match(/CREATE OR REPLACE (?:TABLE|VIEW)\s+`?([a-zA-Z0-9_.-]+)`?/i);
    const tableName = match ? match[1].split('.').pop() : `Object ${i + 1}`;
    process.stdout.write(`Seeding [${i + 1}/${statements.length}] ${tableName}... `);

    try {
      const [job] = await bigquery.createQueryJob({ query: stmt, location });
      await job.getQueryResults();
      console.log('✅ OK');
    } catch (err) {
      console.log('❌ FAILED');
      console.error(`Error running statement for ${tableName}:`, err.message);
    }
  }

  const templateId = '8052b105-d00c-4cb8-bc32-864fe4fe827f';
  const demoLookerUrl = `https://lookerstudio.google.com/reporting/create?c.reportId=${templateId}` +
    `&ds.campaign_performance.connector=bigQuery&ds.campaign_performance.projectId=${projectId}&ds.campaign_performance.datasetId=${datasetId}&ds.campaign_performance.type=TABLE&ds.campaign_performance.tableId=final_campaign_performance&ds.campaign_performance.refreshFields=false` +
    `&ds.line_items_performance.connector=bigQuery&ds.line_items_performance.projectId=${projectId}&ds.line_items_performance.datasetId=${datasetId}&ds.line_items_performance.type=TABLE&ds.line_items_performance.tableId=final_line_items_performance&ds.line_items_performance.refreshFields=false` +
    `&ds.io_pacing_current.connector=bigQuery&ds.io_pacing_current.projectId=${projectId}&ds.io_pacing_current.datasetId=${datasetId}&ds.io_pacing_current.type=TABLE&ds.io_pacing_current.tableId=final_io_pacing_current&ds.io_pacing_current.refreshFields=false` +
    `&ds.assets_performance.connector=bigQuery&ds.assets_performance.projectId=${projectId}&ds.assets_performance.datasetId=${datasetId}&ds.assets_performance.type=TABLE&ds.assets_performance.tableId=final_assets_performance&ds.assets_performance.refreshFields=false` +
    `&ds.creative_variety.connector=bigQuery&ds.creative_variety.projectId=${projectId}&ds.creative_variety.datasetId=${datasetId}&ds.creative_variety.type=TABLE&ds.creative_variety.tableId=final_creative_variety&ds.creative_variety.refreshFields=false` +
    `&ds.audiences_performance.connector=bigQuery&ds.audiences_performance.projectId=${projectId}&ds.audiences_performance.datasetId=${datasetId}&ds.audiences_performance.type=TABLE&ds.audiences_performance.tableId=final_audiences_performance&ds.audiences_performance.refreshFields=false` +
    `&ds.floodlight_audit.connector=bigQuery&ds.floodlight_audit.projectId=${projectId}&ds.floodlight_audit.datasetId=${datasetId}&ds.floodlight_audit.type=TABLE&ds.floodlight_audit.tableId=final_floodlight_activities_audit&ds.floodlight_audit.refreshFields=false` +
    `&ds.floodlight_preflight_audit.connector=bigQuery&ds.floodlight_preflight_audit.projectId=${projectId}&ds.floodlight_preflight_audit.datasetId=${datasetId}&ds.floodlight_preflight_audit.type=TABLE&ds.floodlight_preflight_audit.tableId=final_cls_preflight_audit&ds.floodlight_preflight_audit.refreshFields=false`;

  console.log(`\n=================================================================`);
  console.log(`🎉 Demo Data Generation Complete!`);
  console.log(`📊 One-Click Demo Looker Studio Dashboard Connection URL:`);
  console.log(`\n${demoLookerUrl}\n`);
  console.log(`=================================================================`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error seeding demo data:', err);
    process.exit(1);
  });
}

module.exports = { main };
