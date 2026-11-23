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
 * @fileoverview Opt-in, fail-open Telemetry Hub integration for DGPulse DV360.
 *
 * Dispatches GA4 Measurement Protocol events in the Tadau wire format expected
 * by Telemetry Hub's daily BigQuery ingestion pipeline
 * (`tadau_extract.sql` / `tadau_import.sql`).
 *
 * Transport & upstream contract note:
 * Telemetry Hub's external-tool docs recommend the `tadau` client library
 * (`https://github.com/google-marketing-solutions/tadau`). This module uses
 * Node.js built-in `fetch` directly instead of the `tadau` npm package
 * (`v1.1.0`), because `tadau` npm is ESM-only (incompatible with this CommonJS
 * Cloud Functions package), pulls legacy/unmaintained dependencies
 * (`node-fetch`, `js-yaml@3`, `fs@0.0.1-security`, `tls-test`), throws on
 * missing credentials, and lacks request timeouts and `th_*` allowlist checks.
 * Keep the wire fields below in sync with upstream `tadau/ts/src/tadau.ts`,
 * `tadau_extract.sql`, `tadau_import.sql`, and `demand-gen-pulse-360.gcl`:
 * - Endpoint: `https://www.google-analytics.com/mp/collect`
 * - Top-level payload: `client_id` (UUID), `non_personalized_ads: true`, `events`
 * - Fixed event params: `app` (`app_names[0]`), `is_agent_event: false`,
 *   `non_personalized_ads: false`, `external_event_id` (UUID, no PII)
 * - Account params: allowlisted `th_*` keys (`th_dv360_partner_id`,
 *   `th_dv360_advertiser_id`, `th_opportunity_id`, etc.)
 *
 * Configuration is read from environment variables:
 * - `TELEMETRY_HUB_OPT_IN`: Must be truthy (`true`/`yes`/`y`/`1`) to send.
 *   Defaults to `false`.
 * - `TELEMETRY_HUB_MEASUREMENT_ID`: GA4 Measurement ID (`G-XXXXXXXXXX`).
 * - `TELEMETRY_HUB_API_SECRET`: GA4 Measurement Protocol API secret.
 * - `OPPORTUNITY_ID`: Optional Connect Sales Opportunity ID (8-10 digits).
 * - `ROPPS_URL`: Optional Connect Sales (ROpps) URL; parsed if `OPPORTUNITY_ID`
 *   is not set.
 *
 * All public entry points are fail-open: errors are logged and swallowed so
 * telemetry can never disrupt a DV360 sync.
 */

const crypto = require('crypto');

const GA_COLLECT_URL = 'https://www.google-analytics.com/mp/collect';

// Must match an entry in `app_names` for `demand-gen-pulse-360` in Telemetry
// Hub's solution registry (`demand-gen-pulse-360.gcl`).
const APP_NAME = 'Demand Gen Pulse 360';
const SOLUTION_USAGE_EVENT = 'SOLUTION_USAGE';

const REQUEST_TIMEOUT_MS = 5000;

// Product account parameter keys allowlisted by Telemetry Hub's Tadau extract
// pipeline (`tadau_extract.sql`). At least one must be present on every event.
const ALLOWED_PRODUCT_ACCOUNT_KEYS = new Set([
    'th_google_ads_customer_id',
    'th_google_ads_mcc_id',
    'th_connect_sales_division_id',
    'th_analytics_property_id',
    'th_analytics_account_id',
    'th_merchant_center_account_id',
    'th_merchant_id',
    'th_container_id',
    'th_opportunity_id',
    'th_dv360_advertiser_id',
    'th_dv360_partner_id'
]);

const RESERVED_PARAM_KEYS = new Set([
    'name',
    'client_id',
    'user_id',
    'api_secret',
    'measurement_id',
    'app_instance_id',
    'uuid',
    'timestamp_micros',
    'app',
    'is_agent_event',
    'non_personalized_ads',
    'external_event_id'
]);

const OPT_IN_TRUE_VALUES = new Set(['true', 'y', 'yes', '1']);
const OPPORTUNITY_OPT_OUT_VALUE = 'OPT_OUT';
const OPPORTUNITY_ID_FORMAT_RE = /^\d{8,10}$/;
const OPPORTUNITY_PATH_RE = /(?:^|\/)opportunit(?:ies|y)\/(\d{8,10})(?:[/?#]|$)/i;
const OPPORTUNITY_QUERY_PARAM_KEYS = [
    'opportunity_id',
    'opportunityId',
    'opp_id',
    'oppId'
];
const REPEATED_DIGITS_RE = /^(\d)\1+$/;
const SEQUENTIAL_JUNK_OPPORTUNITY_IDS = new Set([
    '01234567',
    '012345678',
    '0123456789',
    '12345678',
    '123456789',
    '1234567890',
    '87654321',
    '98765432',
    '987654321',
    '9876543210'
]);

/**
 * Returns whether Telemetry Hub reporting is opted in via environment variable.
 *
 * @param {Object<string, string|undefined>} [env=process.env] Environment map.
 * @return {boolean} True only when `TELEMETRY_HUB_OPT_IN` is explicitly truthy.
 */
function isOptIn(env = process.env) {
    const raw = env && env.TELEMETRY_HUB_OPT_IN;
    if (typeof raw !== 'string') {
        return false;
    }
    return OPT_IN_TRUE_VALUES.has(raw.trim().toLowerCase());
}

/**
 * Normalizes a numeric product account identifier (e.g. DV360 Partner or
 * Advertiser ID) to a trimmed digit string.
 *
 * @param {string|number|null|undefined} value Raw identifier value.
 * @return {string|null} Trimmed digit string, or null if invalid.
 */
function normalizeNumericId(value) {
    if (value === null || value === undefined) {
        return null;
    }
    const trimmed = String(value).trim();
    return /^\d+$/.test(trimmed) ? trimmed : null;
}

/**
 * Extracts and validates a Connect Sales Opportunity ID (8-10 digits) from a
 * bare ID or Connect Sales (ROpps) URL, matching Telemetry Hub's canonical
 * `opportunity_picker` rules (query params, `/opportunities/<id>` path, and
 * repeated/sequential placeholder rejection).
 *
 * @param {string|number|null|undefined} rawValue Bare ID or ROpps URL.
 * @return {string|null} The extracted 8-10 digit Opportunity ID, or null.
 */
function parseOpportunityId(rawValue) {
    if (rawValue === null || rawValue === undefined) {
        return null;
    }
    const text = String(rawValue).trim();
    if (!text || text.toUpperCase() === OPPORTUNITY_OPT_OUT_VALUE) {
        return null;
    }

    let candidate = null;
    if (OPPORTUNITY_ID_FORMAT_RE.test(text)) {
        candidate = text;
    } else if (text.includes('://')) {
        try {
            const parsedUrl = new URL(text);
            for (const key of OPPORTUNITY_QUERY_PARAM_KEYS) {
                const rawParam = parsedUrl.searchParams.get(key);
                if (rawParam !== null) {
                    const trimmedParam = rawParam.trim();
                    if (OPPORTUNITY_ID_FORMAT_RE.test(trimmedParam)) {
                        candidate = trimmedParam;
                        break;
                    }
                    const nestedMatch = OPPORTUNITY_PATH_RE.exec(trimmedParam);
                    if (nestedMatch) {
                        candidate = nestedMatch[1];
                        break;
                    }
                }
            }
            if (!candidate) {
                const pathMatch = OPPORTUNITY_PATH_RE.exec(
                    `${parsedUrl.pathname}${parsedUrl.hash}`
                );
                if (pathMatch) {
                    candidate = pathMatch[1];
                }
            }
        } catch (e) {
            // Malformed URL; fall through to relative path match below.
        }
    }

    if (!candidate) {
        const fallbackMatch = OPPORTUNITY_PATH_RE.exec(text);
        if (fallbackMatch) {
            candidate = fallbackMatch[1];
        }
    }

    if (
        !candidate ||
        REPEATED_DIGITS_RE.test(candidate) ||
        SEQUENTIAL_JUNK_OPPORTUNITY_IDS.has(candidate)
    ) {
        return null;
    }
    return candidate;
}

/**
 * Resolves the Connect Sales Opportunity ID from environment variables.
 * `OPPORTUNITY_ID` takes precedence over `ROPPS_URL` (including `OPT_OUT`).
 *
 * @param {Object<string, string|undefined>} [env=process.env] Environment map.
 * @return {string|null} The 8-10 digit Opportunity ID, or null if absent/invalid.
 */
function resolveOpportunityId(env = process.env) {
    if (!env) {
        return null;
    }
    if (
        typeof env.OPPORTUNITY_ID === 'string' &&
        env.OPPORTUNITY_ID.trim().toUpperCase() === OPPORTUNITY_OPT_OUT_VALUE
    ) {
        return null;
    }
    return parseOpportunityId(env.OPPORTUNITY_ID) ||
        parseOpportunityId(env.ROPPS_URL);
}

/**
 * Formats an event name to GA4-safe alphanumeric + underscore characters,
 * matching Tadau's `formatToAlphanumeric`.
 *
 * @param {string} name Raw event name.
 * @return {string} Sanitized event name.
 */
function formatEventName(name) {
    if (typeof name !== 'string') {
        return '';
    }
    return name.replace(/[^a-zA-Z0-9_]/g, '');
}

/**
 * Sends a single event to Telemetry Hub via the GA4 Measurement Protocol
 * (Tadau wire format). Never throws.
 *
 * @param {string} eventName Telemetry Hub Event.Type (e.g. `SOLUTION_USAGE`).
 * @param {Object<string, string|number|boolean|null|undefined>} [eventParams={}]
 *     Event-specific parameters (must include at least one allowlisted `th_*`
 *     product account parameter).
 * @param {Object} [options={}] Optional dependency overrides for testing.
 * @param {Object<string, string|undefined>} [options.env=process.env]
 * @param {Function} [options.fetchImpl=globalThis.fetch]
 * @param {Function} [options.randomUUID=crypto.randomUUID]
 * @param {number} [options.timeoutMs=5000]
 * @return {Promise<boolean>} True if accepted (HTTP 2xx), false otherwise.
 */
async function sendTelemetryEvent(eventName, eventParams = {}, options = {}) {
    try {
        const opts = options || {};
        const env = opts.env || process.env;
        if (!isOptIn(env)) {
            return false;
        }

        const apiSecret = env.TELEMETRY_HUB_API_SECRET &&
            String(env.TELEMETRY_HUB_API_SECRET).trim();
        const measurementId = env.TELEMETRY_HUB_MEASUREMENT_ID &&
            String(env.TELEMETRY_HUB_MEASUREMENT_ID).trim();
        if (!apiSecret || !measurementId) {
            console.warn(
                'Telemetry Hub: TELEMETRY_HUB_API_SECRET and/or ' +
                'TELEMETRY_HUB_MEASUREMENT_ID not set; skipping telemetry.'
            );
            return false;
        }

        const sanitizedName = formatEventName(eventName);
        if (!sanitizedName) {
            console.warn('Telemetry Hub: event name is empty; skipping.');
            return false;
        }

        const fetchImpl = Object.prototype.hasOwnProperty.call(opts, 'fetchImpl')
            ? opts.fetchImpl
            : globalThis.fetch;
        if (typeof fetchImpl !== 'function') {
            console.warn('Telemetry Hub: fetch is unavailable; skipping.');
            return false;
        }

        const randomUUID = opts.randomUUID || (() => crypto.randomUUID());

        // Fixed dimensions required by Telemetry Hub's Tadau ingestion.
        const params = {
            app: APP_NAME,
            is_agent_event: false,
            non_personalized_ads: false,
            external_event_id: randomUUID()
        };

        let hasProductAccount = false;
        let explicitOpportunityOptOut = false;
        if (eventParams && typeof eventParams === 'object') {
            for (const [key, value] of Object.entries(eventParams)) {
                if (RESERVED_PARAM_KEYS.has(key)) {
                    continue;
                }
                if (value === null || value === undefined || value === '') {
                    continue;
                }
                let normalizedValue =
                    typeof value === 'string' ? value.trim() : value;
                if (normalizedValue === '') {
                    continue;
                }
                if (key === 'th_opportunity_id') {
                    if (
                        typeof normalizedValue === 'string' &&
                        normalizedValue.toUpperCase() === OPPORTUNITY_OPT_OUT_VALUE
                    ) {
                        explicitOpportunityOptOut = true;
                        continue;
                    }
                    normalizedValue = parseOpportunityId(normalizedValue);
                    if (!normalizedValue) {
                        continue;
                    }
                }
                params[key] = normalizedValue;
                if (ALLOWED_PRODUCT_ACCOUNT_KEYS.has(key)) {
                    hasProductAccount = true;
                }
            }
        }

        if (!params.th_opportunity_id && !explicitOpportunityOptOut) {
            const opportunityId = resolveOpportunityId(env);
            if (opportunityId) {
                params.th_opportunity_id = opportunityId;
                hasProductAccount = true;
            }
        }

        if (!hasProductAccount) {
            console.warn(
                `Telemetry Hub: skipping ${sanitizedName} without a valid ` +
                'product account identifier (th_*).'
            );
            return false;
        }

        const payload = {
            client_id: randomUUID(),
            non_personalized_ads: true,
            events: [
                {
                    name: sanitizedName,
                    params
                }
            ]
        };

        const url =
            `${GA_COLLECT_URL}?measurement_id=${encodeURIComponent(measurementId)}` +
            `&api_secret=${encodeURIComponent(apiSecret)}`;

        const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
        const fetchOptions = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        };
        if (
            typeof AbortSignal !== 'undefined' &&
            typeof AbortSignal.timeout === 'function' &&
            timeoutMs > 0
        ) {
            fetchOptions.signal = AbortSignal.timeout(timeoutMs);
        }

        const response = await fetchImpl(url, fetchOptions);
        if (!response || !response.ok) {
            const status = response ? response.status : 'unknown';
            console.warn(
                `Telemetry Hub: GA4 returned HTTP ${status} for ${sanitizedName}.`
            );
            return false;
        }
        return true;
    } catch (error) {
        console.warn(
            `Telemetry Hub: failed to send ${eventName || 'event'}:`,
            error && error.message ? error.message : String(error)
        );
        return false;
    }
}

/**
 * Reports a `SOLUTION_USAGE` event for a completed DV360 partner sync.
 *
 * @param {string|number} partnerId DV360 Partner ID.
 * @param {Object} [options={}] Optional dependency overrides for testing.
 * @return {Promise<boolean>} True if sent, false otherwise.
 */
async function sendPartnerSyncUsage(partnerId, options = {}) {
    try {
        const normalizedPartnerId = normalizeNumericId(partnerId);
        if (!normalizedPartnerId) {
            console.warn('Telemetry Hub: invalid DV360 partnerId; skipping.');
            return false;
        }
        return await sendTelemetryEvent(
            SOLUTION_USAGE_EVENT,
            {
                label: 'partner_sync',
                th_dv360_partner_id: normalizedPartnerId
            },
            options
        );
    } catch (error) {
        console.warn(
            'Telemetry Hub: failed to send partner sync usage:',
            error && error.message ? error.message : String(error)
        );
        return false;
    }
}

/**
 * Reports a `SOLUTION_USAGE` event for an advertiser with Demand Gen line items.
 *
 * @param {Object|null|undefined} ids Account identifiers.
 * @param {string|number} [ids.advertiserId] DV360 Advertiser ID.
 * @param {string|number|null|undefined} [ids.partnerId] DV360 Partner ID.
 * @param {Object} [options={}] Optional dependency overrides for testing.
 * @return {Promise<boolean>} True if sent, false otherwise.
 */
async function sendAdvertiserSyncUsage(ids, options = {}) {
    try {
        const { partnerId, advertiserId } = ids || {};
        const normalizedAdvertiserId = normalizeNumericId(advertiserId);
        const normalizedPartnerId = normalizeNumericId(partnerId);
        if (!normalizedAdvertiserId && !normalizedPartnerId) {
            console.warn(
                'Telemetry Hub: invalid DV360 advertiserId and partnerId; skipping.'
            );
            return false;
        }
        const params = {
            label: 'advertiser_dg_sync'
        };
        if (normalizedPartnerId) {
            params.th_dv360_partner_id = normalizedPartnerId;
        }
        if (normalizedAdvertiserId) {
            params.th_dv360_advertiser_id = normalizedAdvertiserId;
        }
        return await sendTelemetryEvent(SOLUTION_USAGE_EVENT, params, options);
    } catch (error) {
        console.warn(
            'Telemetry Hub: failed to send advertiser sync usage:',
            error && error.message ? error.message : String(error)
        );
        return false;
    }
}

module.exports = {
    APP_NAME,
    GA_COLLECT_URL,
    SOLUTION_USAGE_EVENT,
    formatEventName,
    isOptIn,
    normalizeNumericId,
    parseOpportunityId,
    resolveOpportunityId,
    sendAdvertiserSyncUsage,
    sendPartnerSyncUsage,
    sendTelemetryEvent
};
