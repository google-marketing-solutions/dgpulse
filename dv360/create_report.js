/**
 * @fileoverview Automation script to create the DBM performance report query during deployment.
 * Connects via DV360Client and sets up a daily DBM report query for the partner.
 */
const { Storage } = require('@google-cloud/storage');
const DV360Client = require('./dv360');

const storage = new Storage();

const BUCKET_NAME = process.env.BUCKET_NAME;
const CLIENT_SECRET_FILE = process.env.CLIENT_SECRET_FILE || 'client_secret.json';
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const PARTNER_ID = process.env.PARTNER_ID;

let dv360Client = null;

/**
 * Downloads client_secret.json from GCS and initializes DV360Client.
 */
async function initializeClient() {
  if (dv360Client) return dv360Client;

  if (!BUCKET_NAME || !REFRESH_TOKEN) {
    throw new Error('Missing BUCKET_NAME or REFRESH_TOKEN environment variables.');
  }

  console.log(`Downloading ${CLIENT_SECRET_FILE} from bucket ${BUCKET_NAME}...`);
  const [content] = await storage
    .bucket(BUCKET_NAME)
    .file(CLIENT_SECRET_FILE)
    .download();

  const keys = JSON.parse(content.toString());
  const credentials = keys.installed || keys.web || keys;

  dv360Client = new DV360Client(
    credentials,
    null,
    REFRESH_TOKEN
  );

  return dv360Client;
}

/**
 * Ensures the daily DBM performance report query exists and triggers an initial run if new.
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

// CLI / Execution helper if invoked directly
if (require.main === module) {
  const partnerIdArg = process.argv[2] || process.env.PARTNER_ID;
  setupDbmReport(partnerIdArg)
    .then(result => {
      console.log('DBM Report setup complete:', JSON.stringify(result));
      process.exit(0);
    })
    .catch(err => {
      console.error('Error setting up DBM report:', err);
      process.exit(1);
    });
}

module.exports = { setupDbmReport };
