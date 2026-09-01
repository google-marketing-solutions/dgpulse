/**
 * @fileoverview Entry point for the DV360 data fetch process.
 * Fetches all advertiser IDs for a partner and publishes them to a Pub/Sub topic for parallel processing.
 * Also exposes the 'processAdvertiser' function by re-exporting it.
 */
const { Storage } = require('@google-cloud/storage');
const { BigQuery } = require('@google-cloud/bigquery');
const DV360Client = require('./dv360');
const { PubSub } = require('@google-cloud/pubsub');

const storage = new Storage();
const pubsub = new PubSub();
const bigquery = new BigQuery();

// Configuration from environment variables
const TOPIC_NAME = process.env.TOPIC_NAME || 'dv360-advertiser-topic';
const BUCKET_NAME = process.env.BUCKET_NAME;
const CLIENT_SECRET_FILE = process.env.CLIENT_SECRET_FILE || 'client_secret.json';
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const PARTNER_ID = process.env.PARTNER_ID;
const DATASET_ID = process.env.DATASET_ID || 'dv360_dgpulse';

let dv360Client = null;

/**
 * Downloads the client_secret.json from GCS and initializes the DV360Client.
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

// Pure HTTP function
exports.fetchAdvertisers = async (req, res) => {
    const partnerId = req.query.partnerId || PARTNER_ID;

    if (!partnerId) {
        return res.status(400).send('Missing partnerId query parameter or PARTNER_ID env var.');
    }

    try {
        const client = await initializeClient();
        console.log(`Fetching advertisers for partner ${partnerId}...`);
        const advertisers = await client.listAllAdvertisers(partnerId);

        const advertiserRows = advertisers.map(adv => ({
            advertiserId: adv.advertiserId,
            displayName: adv.displayName || '',
            entityStatus: adv.entityStatus || '',
            partnerId: adv.partnerId || String(partnerId),
            currencyCode: (adv.generalConfig && adv.generalConfig.currencyCode) || '',
            cmFloodlightConfigId: (adv.adServerConfig && adv.adServerConfig.cmHybridConfig && adv.adServerConfig.cmHybridConfig.cmFloodlightConfigId) || '',
            cmFloodlightLinkingAuthorized: Boolean(adv.adServerConfig && adv.adServerConfig.cmHybridConfig && adv.adServerConfig.cmHybridConfig.cmFloodlightLinkingAuthorized)
        }));

        if (advertiserRows.length > 0) {
            try {
                await bigquery.dataset(DATASET_ID).table('advertisers').insert(advertiserRows);
                console.log(`Successfully inserted ${advertiserRows.length} advertisers into BigQuery.`);
            } catch (bqErr) {
                console.warn('Warning inserting advertisers into BigQuery:', bqErr.message);
            }
        }

        console.log(`Publishing ${advertisers.length} advertisers to Pub/Sub topic ${TOPIC_NAME}...`);
        for (const adv of advertisers) {
            const data = JSON.stringify({ advertiserId: adv.advertiserId, partnerId });
            const dataBuffer = Buffer.from(data);
            await pubsub.topic(TOPIC_NAME).publishMessage({ data: dataBuffer });
        }

        // Sync and ingest latest DBM performance and audience reports into BigQuery
        try {
            console.log(`Syncing DBM reports for partner ${partnerId}...`);
            const { syncDbmPerformanceReport, syncDbmAudienceReport } = require('./create_report');
            await Promise.allSettled([
                syncDbmPerformanceReport(partnerId),
                syncDbmAudienceReport(partnerId)
            ]);
        } catch (dbmErr) {
            console.warn('Warning syncing DBM reports:', dbmErr.message);
        }

        res.json({
            success: true,
            partnerId,
            count: advertisers.length,
            message: `Triggered processing for ${advertisers.length} advertisers and synced DBM reports.`
        });
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

exports.processAdvertiser = require('./process_advertiser').processAdvertiser;
exports.setupDbmReport = require('./create_report').setupDbmReport;
exports.syncDbmPerformanceReport = require('./create_report').syncDbmPerformanceReport;
exports.syncDbmAudienceReport = require('./create_report').syncDbmAudienceReport;