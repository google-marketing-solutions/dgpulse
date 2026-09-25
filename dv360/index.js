/*
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
const PARTNER_ID = process.env.PARTNER_ID;
const TOPIC_NAME = process.env.TOPIC_NAME || (PARTNER_ID ? `dv360-dgpulse-topic-${PARTNER_ID}` : 'dv360-advertiser-topic');
const BUCKET_NAME = process.env.BUCKET_NAME;
const CLIENT_SECRET_FILE = process.env.CLIENT_SECRET_FILE || 'client_secret.json';
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const DATASET_ID = process.env.DATASET_ID || (PARTNER_ID ? `dv360_dgpulse_${PARTNER_ID}` : 'dv360_dgpulse');

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
    const datasetId = req.query.datasetId || process.env.DATASET_ID || (partnerId ? `dv360_dgpulse_${partnerId}` : DATASET_ID);
    const topicName = req.query.topicName || process.env.TOPIC_NAME || (partnerId ? `dv360-dgpulse-topic-${partnerId}` : TOPIC_NAME);

    if (!partnerId) {
        return res.status(400).send('Missing partnerId query parameter or PARTNER_ID env var.');
    }

    try {
        const client = await initializeClient();
        console.log(`Fetching advertisers for partner ${partnerId} (Dataset: ${datasetId})...`);
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
                await bigquery.dataset(datasetId).table('advertisers').insert(advertiserRows);
                console.log(`Successfully inserted ${advertiserRows.length} advertisers into BigQuery dataset ${datasetId}.`);
            } catch (bqErr) {
                console.warn(`Warning inserting advertisers into BigQuery dataset ${datasetId}:`, bqErr.message);
            }
        }

        // Coverage of the PREVIOUS run, reported before this one fans out.
        //
        // The per-advertiser workers are asynchronous, so a run cannot verify
        // its own fan-out -- by the time this function returns, most workers
        // have not finished. Reporting the last run's result is the only check
        // available from here, and it is worth having: a shortfall was
        // previously invisible. One partner ran with 12 of 46 advertisers
        // covered and reported nothing wrong, while every readiness column for
        // the missing 34 quietly read NO / NEEDS_ACTION.
        try {
            const [coverageRows] = await bigquery.query({
                query:
                    'SELECT COUNT(DISTINCT CAST(advertiserId AS STRING)) AS covered ' +
                    `FROM \`${datasetId}.advertiser_settings\``
            });
            const covered = (coverageRows[0] && Number(coverageRows[0].covered)) || 0;
            if (covered < advertisers.length) {
                console.warn(
                    'ADVERTISER COVERAGE SHORTFALL: the previous run wrote settings for ' +
                    `${covered} of ${advertisers.length} advertisers. advertiser_settings ` +
                    'come from the per-advertiser workers, so ' +
                    'the missing accounts render as NO / NEEDS_ACTION / NOT_CONFIGURED ' +
                    'rather than as blanks. Check the worker logs for "no available ' +
                    'instance" aborts.');
            } else {
                console.log(`Advertiser coverage from the previous run: ${covered}/${advertisers.length}.`);
            }
        } catch (coverageErr) {
            // Expected on the very first run, when the table does not exist yet.
            console.warn(`Could not read advertiser coverage: ${coverageErr.message}`);
        }

        // Published in small batches with a pause between them, not in a tight
        // loop.
        //
        // The worker runs at maxInstanceRequestConcurrency 1, so every message
        // in flight needs its own Cloud Run instance. Publishing every
        // advertiser at once asked Cloud Run for 46 simultaneous cold starts on
        // a large partner; it refused most of them with "The request was
        // aborted because there was no available instance", and because the
        // trigger had no retry policy, 34 of 46 advertisers were dropped
        // silently. Their advertiser_settings rows
        // simply never appeared, and every readiness column downstream
        // COALESCEd to NO / NEEDS_ACTION as though the data had been checked.
        //
        // Two things now prevent that. This batching stops the herd forming,
        // and --retry on the trigger (install.sh) makes anything still rejected
        // redeliverable instead of lost. The batching is the optimisation; the
        // retry is the guarantee.
        const PUBLISH_BATCH_SIZE = 5;
        const PUBLISH_BATCH_PAUSE_MS = 2000;
        // Spreading is bounded because this runs inside the 540s function
        // timeout and still has the DBM report syncs to do afterwards. On a
        // partner large enough to exhaust the budget the pause shrinks and more
        // deliveries get rejected -- which is precisely the case --retry
        // covers.
        const PUBLISH_BUDGET_MS = 120000;
        const batchCount = Math.ceil(advertisers.length / PUBLISH_BATCH_SIZE);
        const pauseMs = batchCount > 1
            ? Math.min(PUBLISH_BATCH_PAUSE_MS, Math.floor(PUBLISH_BUDGET_MS / (batchCount - 1)))
            : 0;

        console.log(
            `Publishing ${advertisers.length} advertisers to Pub/Sub topic ${topicName} ` +
            `in ${batchCount} batch(es) of ${PUBLISH_BATCH_SIZE}, ${pauseMs}ms apart...`);
        for (let i = 0; i < advertisers.length; i += PUBLISH_BATCH_SIZE) {
            const batch = advertisers.slice(i, i + PUBLISH_BATCH_SIZE);
            await Promise.all(batch.map(adv => {
                const data = JSON.stringify({ advertiserId: adv.advertiserId, partnerId, datasetId });
                return pubsub.topic(topicName).publishMessage({ data: Buffer.from(data) });
            }));
            if (i + PUBLISH_BATCH_SIZE < advertisers.length && pauseMs > 0) {
                await new Promise(resolve => setTimeout(resolve, pauseMs));
            }
        }

        // Sync and ingest the latest DBM reports into BigQuery.
        // The IO pacing report must be included here: its DV360 query is
        // deliberately unscheduled (ALL_TIME ranges are not allowed on a
        // scheduled query), so this daily run is the only thing that refreshes
        // dbm_io_spend_daily. Omitting it leaves budget pacing frozen at
        // whatever the install populated, with no visible error.
        try {
            console.log(`Syncing DBM reports for partner ${partnerId} into dataset ${datasetId}...`);
            const {
                syncDbmPerformanceReport,
                syncDbmAudienceReport,
                syncDbmIoPacingReport
            } = require('./create_report');
            const syncJobs = [
                { name: 'performance', run: () => syncDbmPerformanceReport(partnerId, datasetId) },
                // waitForReport: false -- the audience report sits in a DV360
                // queue whose latency has been measured between 91s and 756s
                // for the same query, which does not fit inside this function's
                // 540s timeout. The query is on a DAILY schedule, so this picks
                // up the file DV360 built overnight rather than triggering and
                // blocking on a fresh run.
                { name: 'audience', run: () => syncDbmAudienceReport(partnerId, datasetId, { waitForReport: false }) },
                { name: 'IO pacing', run: () => syncDbmIoPacingReport(partnerId, datasetId) }
            ];
            const results = await Promise.allSettled(syncJobs.map(job => job.run()));
            results.forEach((result, i) => {
                const name = syncJobs[i].name;
                if (result.status === 'fulfilled') {
                    const value = result.value || {};
                    console.log(`DBM ${name} report synced (${value.count} rows).`);
                    return;
                }
                const err = result.reason || {};
                const apiMessage =
                    (err.response && err.response.data && err.response.data.error && err.response.data.error.message) ||
                    err.message ||
                    String(err);
                console.error(`DBM ${name} report FAILED: ${apiMessage}`);
            });
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
exports.syncDbmIoPacingReport = require('./create_report').syncDbmIoPacingReport;
