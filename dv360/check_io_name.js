const { BigQuery } = require('@google-cloud/bigquery');
const DV360Client = require('./dv360');
const fs = require('fs');
const { Storage } = require('@google-cloud/storage');

const bigquery = new BigQuery();
const storage = new Storage();

const DATASET_ID = process.env.DATASET_ID || 'dv360_dgpulse';
const BUCKET_NAME = process.env.BUCKET_NAME;
const CLIENT_SECRET_FILE = process.env.CLIENT_SECRET_FILE || 'client_secret.json';
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;

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
  console.log('=== Checking IO 1026011642 Name ===');

  // 1. BigQuery insertion_orders table
  try {
    const [ioRows] = await bigquery.query({
      query: `SELECT displayName, count(*) as cnt 
              FROM \`${DATASET_ID}.insertion_orders\` 
              WHERE insertionOrderId = '1026011642' 
              GROUP BY 1`
    });
    console.log('1. From BQ insertion_orders table:');
    console.table(ioRows);
  } catch (e) {
    console.warn('Error querying insertion_orders:', e.message);
  }

  // 2. BigQuery dbm_performance table
  try {
    const [dbmRows] = await bigquery.query({
      query: `SELECT Insertion_Order, count(*) as cnt 
              FROM \`${DATASET_ID}.dbm_performance\` 
              WHERE Insertion_Order_Id = 1026011642 
              GROUP BY 1`
    });
    console.log('2. From BQ dbm_performance table:');
    console.table(dbmRows);
  } catch (e) {
    console.warn('Error querying dbm_performance:', e.message);
  }

  // 3. Live DV360 API
  try {
    const client = await initializeClient();
    const res = await client.dv360.advertisers.insertionOrders.get({
      advertiserId: '1079838157',
      insertionOrderId: '1026011642'
    });
    console.log('3. Live from DV360 API:');
    console.log('displayName:', res.data.displayName);
    console.log('entityStatus:', res.data.entityStatus);
    console.log('updateTime:', res.data.updateTime);
  } catch (e) {
    console.warn('Error calling DV360 API:', e.message);
  }
}

run().catch(console.error);
