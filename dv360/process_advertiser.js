/**
 * @fileoverview Handles the processing of individual DV360 advertisers.
 * Triggered by Pub/Sub messages containing an advertiserId.
 * Fetches all campaigns for that advertiser and inserts them into BigQuery.
 */
const { Storage } = require('@google-cloud/storage');
const { BigQuery } = require('@google-cloud/bigquery');
const DV360Client = require('./dv360');

const storage = new Storage();
const bigquery = new BigQuery();

const BUCKET_NAME = process.env.BUCKET_NAME;
const CLIENT_SECRET_FILE = process.env.CLIENT_SECRET_FILE || 'client_secret.json';
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const DATASET_ID = process.env.DATASET_ID || 'dv360_pulse';
const TABLE_ID = process.env.TABLE_ID || 'campaigns';

let dv360Client = null;

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

exports.processAdvertiser = async (event, context) => {
    const pubsubMessage = event.data;
    const dataStr = Buffer.from(pubsubMessage, 'base64').toString();
    const data = JSON.parse(dataStr);
    const advertiserId = data.advertiserId;

    if (!advertiserId) {
        console.error('No advertiserId found in message.');
        return;
    }

    console.log(`Processing advertiser: ${advertiserId}`);

    try {
        const client = await initializeClient();
        console.log(`Fetching campaigns for advertiser ${advertiserId}...`);
        const campaigns = await client.listAllCampaigns(advertiserId);

        console.log(`Fetched ${campaigns.length} campaigns. Saving to BigQuery...`);

        const rows = campaigns.map(campaign => ({
            campaignId: campaign.campaignId,
            advertiserId: campaign.advertiserId,
            entityStatus: campaign.entityStatus,
            displayName: campaign.displayName
        }));

        if (rows.length > 0) {
            await bigquery
                .dataset(DATASET_ID)
                .table(TABLE_ID)
                .insert(rows);
            console.log(`Successfully inserted ${rows.length} rows into BigQuery.`);
        } else {
            console.log('No campaigns found to insert.');
        }

    } catch (error) {
        console.error(`Error processing advertiser ${advertiserId}:`, error.message);
    }
};
