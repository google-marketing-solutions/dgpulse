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
            await bigquery.dataset(DATASET_ID).table('campaigns').insert(campaignRows);
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
            lineItemType: li.lineItemType || ''
        }));
        if (lineItemRows.length > 0) {
            await bigquery.dataset(DATASET_ID).table('line_items').insert(lineItemRows);
            console.log(`Successfully inserted ${lineItemRows.length} line items into BigQuery.`);
        } else {
            console.log('No line items found to insert.');
        }

        // 2b. Insertion Orders & Budget Pacing
        console.log(`Fetching insertion orders for advertiser ${advertiserId}...`);
        const insertionOrders = await client.listAllInsertionOrders(advertiserId);
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
            await bigquery.dataset(DATASET_ID).table('insertion_orders').insert(ioRows);
            console.log(`Successfully inserted ${ioRows.length} insertion orders into BigQuery.`);
        } else {
            console.log('No insertion orders found to insert.');
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
                creativeId: cr.creativeId,
                advertiserId: cr.advertiserId,
                entityStatus: cr.entityStatus,
                displayName: cr.displayName,
                creativeType: cr.creativeType,
                hostingSource: cr.hostingSource,
                dimensions: dims,
                imageUrl: extractImageUrl(cr) || ''
            };
        });
        if (creativeRows.length > 0) {
            await bigquery.dataset(DATASET_ID).table('creatives').insert(creativeRows);
            console.log(`Successfully inserted ${creativeRows.length} creatives into BigQuery.`);
        } else {
            console.log('No creatives found to insert.');
        }

        // 4. Advertiser Details, Data Manager Audiences & Floodlight Configuration
        console.log(`Fetching advertiser settings & audiences for ${advertiserId}...`);
        let advDetails = null;
        try {
            advDetails = await client.getAdvertiser(advertiserId);
        } catch (e) {
            console.warn(`Could not get advertiser details for ${advertiserId}:`, e.message);
        }

        const audiences = await client.getFirstAndThirdPartyAudiences(advertiserId);
        const hasCrmAudience = audiences.some(aud => 
            aud.audienceType === 'CUSTOMER_MATCH_CONTACT_INFO' ||
            aud.audienceType === 'CUSTOMER_MATCH_DEVICE_ID' ||
            aud.audienceType === 'CUSTOMER_MATCH_USER_ID' ||
            aud.audienceSource === 'AUDIENCE_SOURCE_CUSTOMER_MATCH' ||
            aud.audienceSource === 'AUDIENCE_SOURCE_THIRD_PARTY'
        );
        const hasGaAudience = audiences.some(aud => 
            aud.audienceSource === 'AUDIENCE_SOURCE_GOOGLE_ANALYTICS' ||
            (aud.displayName && aud.displayName.toLowerCase().includes('google analytics')) ||
            (aud.displayName && aud.displayName.toLowerCase().includes('ga4'))
        );

        let floodlightOptEnabled = false;
        let cmFloodlightConfigId = null;
        if (advDetails && advDetails.adServerConfig && advDetails.adServerConfig.cmHybridConfig) {
            cmFloodlightConfigId = advDetails.adServerConfig.cmHybridConfig.cmFloodlightConfigId;
            floodlightOptEnabled = Boolean(advDetails.adServerConfig.cmHybridConfig.cmFloodlightLinkingAuthorized);
        }

        let ecEnabled = false;
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

            const clickDays = (group && group.lookbackWindow && group.lookbackWindow.clickDays != null) ? Number(group.lookbackWindow.clickDays) : 30;
            const impressionDays = (group && group.lookbackWindow && group.lookbackWindow.impressionDays != null) ? Number(group.lookbackWindow.impressionDays) : 30;

            // 2. Fetch Floodlight Activities to check for Enhanced Conversions & Audit
            const activities = await client.getFloodlightActivities(cmFloodlightConfigId, partnerId);
            ecEnabled = activities.some(act => 
                act.servingStatus === 'ENTITY_STATUS_ACTIVE' || 
                act.servingStatus === 'ENABLED' ||
                (act.floodlightActivityConfig && act.floodlightActivityConfig.enhancedConversionsEnabled)
            );

            // 3. Evaluate Google Tag Gateway (GTG / First-Party Mode) Readiness
            if (webTagType === 'WEB_TAG_TYPE_DYNAMIC') {
                gtgStatus = 'READY';
            } else if (webTagType === 'WEB_TAG_TYPE_IMAGE') {
                gtgStatus = 'NEEDS_TAG_UPGRADE';
            } else {
                gtgStatus = 'NOT_CONFIGURED';
            }

            // 4. Stream Floodlight Activities for Audit Scan Table
            const todayStr = new Date().toISOString().split('T')[0];
            const activityRows = activities.map(act => {
                const isLegacy = webTagType === 'WEB_TAG_TYPE_IMAGE';
                const tagModStatus = webTagType === 'WEB_TAG_TYPE_DYNAMIC' ? 'MODERN_GOOGLE_TAG' : (isLegacy ? 'LEGACY_IMAGE_TAG' : 'UNKNOWN');
                
                let attrStatus = 'STANDARD_WINDOW';
                if (clickDays === 0 || impressionDays === 0) {
                    attrStatus = 'ZERO_DAY_WINDOW_WARNING';
                } else if (clickDays > 30 || impressionDays > 30) {
                    attrStatus = 'EXTENDED_LOOKBACK';
                }

                const sslCompliant = act.sslRequired !== false;
                const remarketingActive = act.remarketingConfigs ? act.remarketingConfigs.some(r => r.remarketingEnabled) : false;

                return {
                    floodlightActivityId: String(act.floodlightActivityId),
                    advertiserId: String(advertiserId),
                    partnerId: String(partnerId || ''),
                    floodlightGroupId: String(cmFloodlightConfigId),
                    activityName: act.displayName || String(act.floodlightActivityId),
                    servingStatus: act.servingStatus || 'UNKNOWN',
                    webTagType: webTagType,
                    tagModernizationStatus: tagModStatus,
                    clickLookbackDays: clickDays,
                    impressionLookbackDays: impressionDays,
                    attributionLookbackStatus: attrStatus,
                    sslRequired: act.sslRequired ? 'YES' : 'NO',
                    sslComplianceStatus: sslCompliant ? 'SSL_COMPLIANT' : 'NON_SSL_COMPLIANT_WARNING',
                    remarketingEnabled: remarketingActive ? 'YES' : 'NO',
                    auditDate: todayStr
                };
            });

            if (activityRows.length > 0) {
                try {
                    await bigquery.dataset(DATASET_ID).table('floodlight_activities').insert(activityRows);
                    console.log(`Successfully inserted ${activityRows.length} floodlight activities for ${advertiserId} into BigQuery.`);
                } catch (actErr) {
                    console.warn(`Warning inserting floodlight_activities into BigQuery for ${advertiserId}:`, actErr.message);
                }
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
            auto_tagging_enabled: 'YES',
            ec_enabled: ecEnabled ? 'YES' : 'NO',
            gtg_status: gtgStatus,
            web_tag_type: webTagType
        };

        try {
            await bigquery.dataset(DATASET_ID).table('advertiser_settings').insert([settingsRow]);
            console.log(`Successfully inserted advertiser_settings for ${advertiserId} into BigQuery.`);
        } catch (settErr) {
            console.warn(`Warning inserting advertiser_settings into BigQuery for ${advertiserId}:`, settErr.message);
        }

    } catch (error) {
        console.error(`Error processing advertiser ${advertiserId}:`, error.message);
    }
};
