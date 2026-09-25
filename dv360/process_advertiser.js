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
 * @fileoverview Handles the processing of individual DV360 advertisers.
 * Triggered by Pub/Sub messages containing an advertiserId.
 * Fetches all campaigns for that advertiser and inserts them into BigQuery.
 */
const { Storage } = require('@google-cloud/storage');
const { BigQuery } = require('@google-cloud/bigquery');
const DV360Client = require('./dv360');
const { resolveVideoAspectRatios } = require('./youtube_fetcher');

const storage = new Storage();
const bigquery = new BigQuery();

const BUCKET_NAME = process.env.BUCKET_NAME;
const CLIENT_SECRET_FILE = process.env.CLIENT_SECRET_FILE || 'client_secret.json';
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const PARTNER_ID = process.env.PARTNER_ID;
const DATASET_ID = process.env.DATASET_ID || (PARTNER_ID ? `dv360_dgpulse_${PARTNER_ID}` : 'dv360_dgpulse');
const TABLE_ID = process.env.TABLE_ID || 'campaigns';

let dv360Client = null;
let adGroupAdsTableEnsured = false;

async function ensureAdGroupAdsTable(bq, datasetId) {
    if (adGroupAdsTableEnsured) return;
    try {
        await bq.query({
            query: `CREATE TABLE IF NOT EXISTS \`${datasetId}.ad_group_ads\` (
                adGroupAdId STRING,
                adGroupId STRING,
                lineItemId STRING,
                insertionOrderId STRING,
                campaignId STRING,
                advertiserId STRING,
                displayName STRING,
                entityStatus STRING,
                adType STRING,
                approvalStatus STRING,
                video_id STRING,
                aspect_ratio FLOAT64,
                videos_count INT64,
                horizontal_images_count INT64,
                square_images_count INT64,
                portrait_images_count INT64,
                headlines_count INT64,
                descriptions_count INT64,
                created_at TIMESTAMP
            );`
        });
        const alterQueries = [
            `ALTER TABLE \`${datasetId}.ad_group_ads\` ADD COLUMN IF NOT EXISTS lineItemId STRING, ADD COLUMN IF NOT EXISTS insertionOrderId STRING, ADD COLUMN IF NOT EXISTS campaignId STRING, ADD COLUMN IF NOT EXISTS approvalStatus STRING, ADD COLUMN IF NOT EXISTS video_id STRING, ADD COLUMN IF NOT EXISTS aspect_ratio FLOAT64, ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;`
        ];
        for (const aq of alterQueries) {
            try { await bq.query({ query: aq }); } catch (e) {}
        }
        adGroupAdsTableEnsured = true;
    } catch (e) {
        console.warn('Warning ensuring ad_group_ads table:', e.message);
    }
}

async function initializeClient() {
    if (dv360Client) return dv360Client;

    let targetBucket = BUCKET_NAME;
    let valid = false;
    if (targetBucket) {
        try {
            const [exists] = await storage.bucket(targetBucket).exists();
            if (exists) valid = true;
        } catch (e) {}
    }
    if (!valid) {
        try {
            const [buckets] = await storage.getBuckets();
            const match = buckets.find(b => b.name.includes('dv360') || b.name.includes('dgpulse'));
            if (match) targetBucket = match.name;
        } catch (e) {}
    }

    console.log(`Downloading ${CLIENT_SECRET_FILE} from bucket ${targetBucket}...`);
    const [content] = await storage
        .bucket(targetBucket)
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

function extractImageUrl(cr) {
    if (!cr) return null;
    if (cr.assets && Array.isArray(cr.assets)) {
        for (const a of cr.assets) {
            const content = a.asset && a.asset.content;
            if (content) {
                const ytMatch = content.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
                if (ytMatch && ytMatch[1]) {
                    return `https://i.ytimg.com/vi/${ytMatch[1]}/hqdefault.jpg`;
                }
                if ((content.startsWith('http://') || content.startsWith('https://')) && content.match(/\.(jpeg|jpg|gif|png|webp)($|\?)/i)) {
                    return content;
                }
            }
        }
    }
    return null;
}

exports.processAdvertiser = async (event, context) => {
    const pubsubMessage = event.data;
    const dataStr = Buffer.from(pubsubMessage, 'base64').toString();
    const data = JSON.parse(dataStr);
    const advertiserId = data.advertiserId;
    const partnerId = data.partnerId || PARTNER_ID;
    const targetDatasetId = data.datasetId || process.env.DATASET_ID || (partnerId ? `dv360_dgpulse_${partnerId}` : DATASET_ID);

    if (!advertiserId) {
        console.error('No advertiserId found in message.');
        return;
    }

    console.log(`Processing advertiser: ${advertiserId} (Dataset: ${targetDatasetId}, Partner: ${partnerId || 'unknown'})`);

    try {
        const client = await initializeClient();

        // 1. Campaigns
        console.log(`Fetching campaigns for advertiser ${advertiserId}...`);
        const campaigns = await client.listAllCampaigns(advertiserId);
        const campaignRows = campaigns.map(campaign => ({
            campaignId: campaign.campaignId,
            advertiserId: campaign.advertiserId,
            entityStatus: campaign.entityStatus,
            displayName: campaign.displayName
        }));
        if (campaignRows.length > 0) {
            await bigquery.query({ query: `DELETE FROM \`${targetDatasetId}.campaigns\` WHERE advertiserId = '${advertiserId}'` }).catch(() => {});
            await bigquery.dataset(targetDatasetId).table('campaigns').insert(campaignRows);
            console.log(`Successfully inserted ${campaignRows.length} campaigns into BigQuery.`);
        } else {
            console.log('No campaigns found to insert.');
        }

        // 2. Line Items
        console.log(`Fetching line items for advertiser ${advertiserId}...`);
        const lineItems = await client.listAllLineItems(advertiserId);
        const lineItemRows = lineItems.map(li => ({
            lineItemId: String(li.lineItemId),
            insertionOrderId: String(li.insertionOrderId || ''),
            campaignId: String(li.campaignId || ''),
            advertiserId: String(li.advertiserId || ''),
            entityStatus: li.entityStatus || '',
            displayName: li.displayName || '',
            lineItemType: li.lineItemType || '',
            // Whether this line item has any Floodlight activity attached for
            // conversion counting. Unlike the advertiser-level settings, this
            // genuinely varies per line item, so it is a meaningful check in a
            // line-item-level table. Sourced from LineItem.conversionCounting,
            // a real DV360 v4 field.
            conversion_tracking_enabled: (
                li.conversionCounting &&
                Array.isArray(li.conversionCounting.floodlightActivityConfigs) &&
                li.conversionCounting.floodlightActivityConfigs.length > 0
            ) ? 'YES' : 'NO'
        }));
        if (lineItemRows.length > 0) {
            await bigquery.query({ query: `DELETE FROM \`${targetDatasetId}.line_items\` WHERE advertiserId = '${advertiserId}'` }).catch(() => {});
            await bigquery.dataset(targetDatasetId).table('line_items').insert(lineItemRows);
            console.log(`Successfully inserted ${lineItemRows.length} line items into BigQuery.`);
        } else {
            console.log('No line items found to insert.');
        }

        const youtubeTrackedActivityIds = new Set();
        const allTrackedActivityIds = new Set();
        let hasDdaOrSmartBidding = false;

        for (const li of lineItems) {
            const isYtOrDg = li.lineItemType === 'LINE_ITEM_TYPE_YOUTUBE_AND_VIDEO' ||
                             li.lineItemType === 'LINE_ITEM_TYPE_DEMAND_GEN';
            if (li.conversionCounting && Array.isArray(li.conversionCounting.floodlightActivityConfigs)) {
                for (const flCfg of li.conversionCounting.floodlightActivityConfigs) {
                    if (flCfg && flCfg.floodlightActivityId) {
                        const actIdStr = String(flCfg.floodlightActivityId);
                        allTrackedActivityIds.add(actIdStr);
                        if (isYtOrDg) {
                            youtubeTrackedActivityIds.add(actIdStr);
                        }
                    }
                }
            }
            if (li.bidStrategy) {
                const bs = li.bidStrategy;
                if (bs.performanceGoalBidStrategy || bs.maximizeSpendAlgorithm || bs.customBiddingAlgorithmId) {
                    hasDdaOrSmartBidding = true;
                }
            }
        }

        // 2b. Insertion Orders & Budget Pacing
        console.log(`Fetching insertion orders for advertiser ${advertiserId}...`);
        const insertionOrders = await client.listAllInsertionOrders(advertiserId);
        const segmentRows = [];
        const ioRows = insertionOrders.map(io => {
            let budgetAmount = 0;
            let startDate = null;
            let endDate = null;

            if (io.budget && io.budget.budgetSegments && io.budget.budgetSegments.length > 0) {
                let totalMicros = 0;
                for (const seg of io.budget.budgetSegments) {
                    if (seg.budgetAmountMicros) totalMicros += Number(seg.budgetAmountMicros);
                    const s = seg.dateRange && seg.dateRange.startDate ?
                        `${seg.dateRange.startDate.year}-${String(seg.dateRange.startDate.month).padStart(2, '0')}-${String(seg.dateRange.startDate.day).padStart(2, '0')}` : null;
                    const e = seg.dateRange && seg.dateRange.endDate ?
                        `${seg.dateRange.endDate.year}-${String(seg.dateRange.endDate.month).padStart(2, '0')}-${String(seg.dateRange.endDate.day).padStart(2, '0')}` : null;
                    if (s && (!startDate || s < startDate)) startDate = s;
                    if (e && (!endDate || e > endDate)) endDate = e;

                    // Retain each segment individually. DV360 paces an insertion
                    // order against the segment that is currently in flight, not
                    // against the lifetime roll-up, so the roll-up alone is not
                    // enough to reproduce the pacing shown in the DV360 UI.
                    if (s && e) {
                        segmentRows.push({
                            insertionOrderId: String(io.insertionOrderId),
                            advertiserId: String(io.advertiserId),
                            campaignId: String(io.campaignId),
                            description: seg.description || '',
                            budget_amount: seg.budgetAmountMicros ? Number(seg.budgetAmountMicros) / 1000000 : 0,
                            start_date: s,
                            end_date: e
                        });
                    }
                }
                budgetAmount = totalMicros / 1000000;
            }

            return {
                insertionOrderId: String(io.insertionOrderId),
                advertiserId: String(io.advertiserId),
                campaignId: String(io.campaignId),
                displayName: io.displayName || '',
                entityStatus: io.entityStatus || '',
                pacingType: (io.pacing && io.pacing.pacingType) || '',
                pacingPeriod: (io.pacing && io.pacing.pacingPeriod) || '',
                dailyMaxAmount: (io.pacing && io.pacing.dailyMaxMicros) ? Number(io.pacing.dailyMaxMicros) / 1000000 : null,
                budgetUnit: (io.budget && io.budget.budgetUnit) || '',
                automationType: (io.budget && io.budget.automationType) || '',
                budgetAmount: budgetAmount,
                startDate: startDate,
                endDate: endDate
            };
        });

        if (ioRows.length > 0) {
            await bigquery.query({ query: `DELETE FROM \`${targetDatasetId}.insertion_orders\` WHERE advertiserId = '${advertiserId}'` }).catch(() => {});
            await bigquery.dataset(targetDatasetId).table('insertion_orders').insert(ioRows);
            console.log(`Successfully inserted ${ioRows.length} insertion orders into BigQuery.`);
        } else {
            console.log('No insertion orders found to insert.');
        }

        if (segmentRows.length > 0) {
            await bigquery.query({ query: `DELETE FROM \`${targetDatasetId}.io_budget_segments\` WHERE advertiserId = '${advertiserId}'` }).catch(() => {});
            const segBatchSize = 500;
            for (let i = 0; i < segmentRows.length; i += segBatchSize) {
                await bigquery.dataset(targetDatasetId).table('io_budget_segments').insert(segmentRows.slice(i, i + segBatchSize));
            }
            console.log(`Successfully inserted ${segmentRows.length} IO budget segments into BigQuery.`);
        }

        // 2c. Advertiser Details, Data Manager Audiences & Floodlight Config
        //
        // Deliberately ahead of creatives, Demand Gen ad groups and the
        // YouTube aspect-ratio pass. Those three dominate the execution --
        // 194s of a 197s run were spent there -- and anything sequenced
        // after them is one slow API call away from being cut off by the
        // Cloud Run request timeout, which kills the container without
        // running a catch block. advertiser_settings feeds every signal in
        // the dashboard and costs two API calls, so it goes first. Every
        // value it reads is already resolved by the end of step 2b;
        // hasDdaOrSmartBidding in particular is filled by the line item
        // loop above, so do not move this any earlier.
        console.log(`Fetching advertiser settings & audiences for ${advertiserId}...`);
        let advDetails = null;
        try {
            advDetails = await client.getAdvertiser(advertiserId);
        } catch (e) {
            console.warn(`Could not get advertiser details for ${advertiserId}:`, e.message);
        }

        // Returns booleans, not the audience list: the partner audience pool is
        // far too large to enumerate per advertiser. getAudienceSignals scores
        // each page as it arrives and stops as soon as both flags are known,
        // and logs the counts and whether the scan was complete.
        const audienceSignals = await client.getAudienceSignals(advertiserId);
        const hasCrmAudience = audienceSignals.hasCrmAudience;
        const hasGaAudience = audienceSignals.hasGaAudience;

        let floodlightOptEnabled = false;
        let cmFloodlightConfigId = null;
        if (advDetails && advDetails.adServerConfig && advDetails.adServerConfig.cmHybridConfig) {
            cmFloodlightConfigId = advDetails.adServerConfig.cmHybridConfig.cmFloodlightConfigId;
            floodlightOptEnabled = Boolean(advDetails.adServerConfig.cmHybridConfig.cmFloodlightLinkingAuthorized);
        }

        let webTagType = 'WEB_TAG_TYPE_NONE';
        let gtgStatus = 'NOT_CONFIGURED';

        if (cmFloodlightConfigId) {
            const partnerId = (data && data.partnerId) || (advDetails && advDetails.partnerId);

            // 1. Fetch Floodlight Group to inspect webTagType and lookback window
            let group = null;
            try {
                group = await client.getFloodlightGroup(cmFloodlightConfigId, partnerId);
                if (group && group.webTagType) {
                    webTagType = group.webTagType;
                }
            } catch (grpErr) {
                console.warn(`Warning fetching floodlight group ${cmFloodlightConfigId}:`, grpErr.message);
            }

            // 3. Evaluate Google Tag Gateway (GTG / First-Party Mode) Readiness
            if (webTagType === 'WEB_TAG_TYPE_DYNAMIC') {
                gtgStatus = 'READY';
            } else if (webTagType === 'WEB_TAG_TYPE_IMAGE') {
                gtgStatus = 'NEEDS_TAG_UPGRADE';
            } else {
                gtgStatus = 'NOT_CONFIGURED';
            }
        }

        const settingsRow = {
            advertiserId: String(advertiserId),
            displayName: (advDetails && advDetails.displayName) || String(advertiserId),
            partnerId: (advDetails && advDetails.partnerId) || String(data.partnerId || ''),
            currency_code: (advDetails && advDetails.generalConfig && advDetails.generalConfig.currencyCode) || '',
            has_crm_audience: hasCrmAudience ? 'YES' : 'NO',
            has_ga_audience: hasGaAudience ? 'YES' : 'NO',
            floodlight_optimization_enabled: floodlightOptEnabled ? 'YES' : 'NO',
            // NOTE: auto_tagging_enabled and ec_enabled were removed here.
            // Neither Enhanced Conversions nor auto-tagging is exposed anywhere
            // in the DV360 v4 or CM360 v5 APIs, so the former was a hardcoded
            // 'YES' and the latter read field paths that never resolve. Both
            // reported a constant value for every advertiser. Do not reinstate
            // them without a verified source.
            gtg_status: gtgStatus,
            web_tag_type: webTagType,
            dda_status: hasDdaOrSmartBidding ? 'ACTIVE' : 'NOT_CONFIGURED'
        };

        try {
            await bigquery.query({ query: `DELETE FROM \`${targetDatasetId}.advertiser_settings\` WHERE advertiserId = '${advertiserId}'` }).catch(() => {});
            await bigquery.dataset(targetDatasetId).table('advertiser_settings').insert([settingsRow]);
            console.log(`Successfully inserted advertiser_settings for ${advertiserId} into BigQuery.`);
        } catch (settErr) {
            console.warn(`Warning inserting advertiser_settings into BigQuery for ${advertiserId}:`, settErr.message);
        }

        // 3. Creatives
        console.log(`Fetching creatives for advertiser ${advertiserId}...`);
        const creatives = await client.listAllCreatives(advertiserId);
        const creativeRows = creatives.map(cr => {
            let dims = 'RESPONSIVE/NATIVE';
            if (cr.dimensions && cr.dimensions.widthPixels > 0 && cr.dimensions.heightPixels > 0) {
                dims = `${cr.dimensions.widthPixels}x${cr.dimensions.heightPixels}`;
            } else if (cr.creativeType && cr.creativeType.includes('VIDEO')) {
                dims = 'VIDEO (RESPONSIVE)';
            } else if (cr.creativeType && cr.creativeType.includes('AUDIO')) {
                dims = 'AUDIO (N/A)';
            }
            return {
                creativeId: String(cr.creativeId),
                advertiserId: String(cr.advertiserId),
                entityStatus: cr.entityStatus || '',
                displayName: cr.displayName || '',
                creativeType: cr.creativeType || '',
                hostingSource: cr.hostingSource || '',
                dimensions: dims,
                imageUrl: extractImageUrl(cr) || '',
                approvalStatus: (cr.reviewStatus && cr.reviewStatus.approvalStatus) || ''
            };
        });
        if (creativeRows.length > 0) {
            await bigquery.query({ query: `DELETE FROM \`${targetDatasetId}.creatives\` WHERE advertiserId = '${advertiserId}'` }).catch(() => {});
            for (let i = 0; i < creativeRows.length; i += 500) {
                await bigquery.dataset(targetDatasetId).table('creatives').insert(creativeRows.slice(i, i + 500));
            }
            console.log(`Successfully inserted ${creativeRows.length} creatives into BigQuery.`);
        } else {
            console.log('No creatives found to insert.');
        }

        // 3b. Demand Gen Ad Group Ads
        console.log(`Fetching Demand Gen Ad Groups and Ads for advertiser ${advertiserId}...`);
        const dgLineItems = lineItems.filter(li =>
            li.lineItemType && li.lineItemType.includes('DEMAND_GEN')
        );

        if (dgLineItems.length > 0) {
            const adRows = [];
            const now = new Date().toISOString();
            for (const dgLi of dgLineItems) {
                const liId = String(dgLi.lineItemId);
                const ioId = String(dgLi.insertionOrderId || '');
                const campId = String(dgLi.campaignId || '');

                try {
                    const agRes = await client.dv360.advertisers.adGroups.list({
                        advertiserId: advertiserId,
                        filter: `lineItemId="${liId}"`
                    });
                    const ags = agRes.data.adGroups || [];

                    for (const ag of ags) {
                        const agId = String(ag.adGroupId);
                        const adRes = await client.dv360.advertisers.adGroupAds.list({
                            advertiserId: advertiserId,
                            filter: `adGroupId="${agId}"`
                        });
                        const ads = adRes.data.adGroupAds || [];

                        for (const ad of ads) {
                            const vAd = ad.demandGenVideoAd;
                            const iAd = ad.demandGenImageAd;
                            let adType = 'DEMAND_GEN_OTHER_AD';
                            if (vAd) adType = 'DEMAND_GEN_VIDEO_AD';
                            else if (iAd) adType = 'DEMAND_GEN_IMAGE_AD';
                            else if (ad.demandGenCarouselAd) adType = 'DEMAND_GEN_CAROUSEL_AD';
                            else if (ad.demandGenProductAd) adType = 'DEMAND_GEN_PRODUCT_AD';

                            const approvalStatus = (ad.adPolicy && ad.adPolicy.adPolicyApprovalStatus) || '';
                            const videoId = (vAd && vAd.videos && vAd.videos[0] && (vAd.videos[0].id || vAd.videos[0].videoId)) || null;

                            adRows.push({
                                adGroupAdId: String(ad.adGroupAdId),
                                adGroupId: agId,
                                lineItemId: liId,
                                insertionOrderId: ioId,
                                campaignId: campId,
                                advertiserId: String(advertiserId),
                                displayName: String(ad.displayName || ''),
                                entityStatus: String(ad.entityStatus || ''),
                                adType: adType,
                                video_id: videoId,
                                aspect_ratio: null,
                                videos_count: vAd && vAd.videos ? vAd.videos.length : 0,
                                horizontal_images_count: iAd && iAd.marketingImages ? iAd.marketingImages.length : 0,
                                square_images_count: iAd && iAd.squareMarketingImages ? iAd.squareMarketingImages.length : 0,
                                portrait_images_count: iAd && iAd.portraitMarketingImages ? iAd.portraitMarketingImages.length : 0,
                                headlines_count: (vAd && vAd.headlines ? vAd.headlines.length : 0) + (iAd && iAd.headlines ? iAd.headlines.length : 0),
                                descriptions_count: (vAd && vAd.descriptions ? vAd.descriptions.length : 0) + (iAd && iAd.descriptions ? iAd.descriptions.length : 0),
                                approvalStatus: approvalStatus,
                                created_at: now
                            });
                        }
                    }
                } catch (dgErr) {
                    console.warn(`Warning fetching Ad Group Ads for line item ${liId}:`, dgErr.message);
                }
            }

            if (adRows.length > 0) {
                // Resolve YouTube aspect ratios for all unique video IDs using YouTube Data API
                const videoIds = adRows.map(r => r.video_id).filter(Boolean);
                if (videoIds.length > 0) {
                    console.log(`Resolving aspect ratios for ${videoIds.length} video ads via YouTube Data API...`);
                    try {
                        const ratioMap = await resolveVideoAspectRatios(videoIds, bigquery, targetDatasetId, BUCKET_NAME);
                        for (const r of adRows) {
                            if (r.video_id && ratioMap.has(r.video_id)) {
                                r.aspect_ratio = ratioMap.get(r.video_id);
                            }
                        }
                    } catch (ytErr) {
                        console.warn('Warning resolving YouTube aspect ratios:', ytErr.message);
                    }
                }

                await ensureAdGroupAdsTable(bigquery, targetDatasetId);

                try {
                    await bigquery.query({
                        query: `DELETE FROM \`${targetDatasetId}.ad_group_ads\` WHERE advertiserId = '${advertiserId}'`
                    });
                } catch (delErr) {}

                for (let i = 0; i < adRows.length; i += 500) {
                    await bigquery.dataset(targetDatasetId).table('ad_group_ads').insert(adRows.slice(i, i + 500));
                }
                console.log(`Successfully inserted ${adRows.length} ad group ads into BigQuery.`);
            }
        }

    } catch (error) {
        console.error(`Error processing advertiser ${advertiserId}:`, error.message);
    }
};
