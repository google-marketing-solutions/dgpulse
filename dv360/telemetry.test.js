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

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    formatEventName,
    isOptIn,
    normalizeNumericId,
    parseOpportunityId,
    resolveOpportunityId,
    sendAdvertiserSyncUsage,
    sendPartnerSyncUsage,
    sendTelemetryEvent,
} = require('./telemetry');

const BASE_ENV = Object.freeze({
    TELEMETRY_HUB_OPT_IN: 'true',
    TELEMETRY_HUB_MEASUREMENT_ID: 'G-TEST12345',
    TELEMETRY_HUB_API_SECRET: 'test-secret',
});

function createStubFetch(response = { ok: true, status: 204 }) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init, payload: JSON.parse(init.body) });
        return response;
    };
    return { calls, fetchImpl };
}

describe('isOptIn', () => {
    for (const value of ['true', 'TRUE', ' yes ', 'Y', '1']) {
        it(`returns true for truthy value ${JSON.stringify(value)}`, () => {
            assert.equal(isOptIn({ TELEMETRY_HUB_OPT_IN: value }), true);
        });
    }

    for (const value of [undefined, '', 'false', 'n', 'no', '0', 'maybe']) {
        it(`returns false for value ${JSON.stringify(value)}`, () => {
            assert.equal(isOptIn({ TELEMETRY_HUB_OPT_IN: value }), false);
        });
    }

    it('defaults to false when env var is omitted', () => {
        assert.equal(isOptIn({}), false);
    });

    it('defaults to false when env is null', () => {
        assert.equal(isOptIn(null), false);
    });
});

describe('normalizeNumericId', () => {
    it('accepts trimmed numeric strings', () => {
        assert.equal(normalizeNumericId(' 12345678 '), '12345678');
    });

    it('accepts numeric values', () => {
        assert.equal(normalizeNumericId(987654), '987654');
    });

    for (const value of [
        null, undefined, '', '   ', 'abc', '123-456', 'unknown',
    ]) {
        it(`rejects invalid value ${JSON.stringify(value)}`, () => {
            assert.equal(normalizeNumericId(value), null);
        });
    }
});

describe('Opportunity ID parsing', () => {
    for (const [label, input, expected] of [
        ['bare 8-digit ID', '93382720', '93382720'],
        ['bare 10-digit ID', '1029384756', '1029384756'],
        [
            'Connect Sales /opportunities/ URL with unrelated query ID',
            'https://sales.connect.corp.google.com/opportunities/93382720?divisionId=999888777',
            '93382720',
        ],
        [
            'Connect Sales hash route /#/opportunities/<id>/details',
            'https://sales.connect.corp.google.com/#/opportunities/1029384756/details',
            '1029384756',
        ],
        [
            'singular /opportunity/<id> path',
            'https://connect.example.com/opportunity/555666777',
            '555666777',
        ],
        [
            'opportunity_id query parameter',
            'https://sales.connect.corp.google.com/home?opportunity_id=847291034',
            '847291034',
        ],
        [
            'oppId query parameter',
            'https://sales.connect.corp.google.com/home?oppId=847291034',
            '847291034',
        ],
        [
            'nested /opportunities/<id> path inside query parameter',
            'https://sales.connect.corp.google.com/redirect?opportunity_id=%2Fopportunities%2F93382720',
            '93382720',
        ],
        [
            'malformed URL containing :// falling back to path match',
            'https://[invalid-host/opportunities/93382720',
            '93382720',
        ],
        [
            'relative /opportunities/<id> path',
            '/opportunities/93382720',
            '93382720',
        ],
    ]) {
        it(`extracts ID from ${label}`, () => {
            assert.equal(parseOpportunityId(input), expected);
        });
    }

    for (const value of [
        null,
        undefined,
        '',
        'OPT_OUT',
        'opt_out',
        'foo 93382720 bar',
        'https://sales.connect.corp.google.com/opportunities/1234567',
        '10293847561',
        '00000000',
        '111111111',
        '12345678',
        '123456789',
        '987654321',
    ]) {
        it(`rejects ${JSON.stringify(value)}`, () => {
            assert.equal(parseOpportunityId(value), null);
        });
    }

    it('prefers OPPORTUNITY_ID over ROPPS_URL', () => {
        assert.equal(
            resolveOpportunityId({
                OPPORTUNITY_ID: '847291034',
                ROPPS_URL: 'https://sales.connect.corp.google.com/opportunities/93382720',
            }),
            '847291034'
        );
    });

    it('falls back to ROPPS_URL when OPPORTUNITY_ID is unset', () => {
        assert.equal(
            resolveOpportunityId({
                ROPPS_URL: 'https://sales.connect.corp.google.com/opportunities/93382720',
            }),
            '93382720'
        );
    });

    it('treats OPPORTUNITY_ID=OPT_OUT as authoritative over ROPPS_URL', () => {
        assert.equal(
            resolveOpportunityId({
                OPPORTUNITY_ID: 'OPT_OUT',
                ROPPS_URL: 'https://sales.connect.corp.google.com/opportunities/93382720',
            }),
            null
        );
    });
});

describe('formatEventName', () => {
    for (const [label, input, expected] of [
        [
            'preserves alphanumeric and underscore characters',
            'SOLUTION_USAGE',
            'SOLUTION_USAGE',
        ],
        [
            'strips punctuation and whitespace',
            'bad-event! name',
            'badeventname',
        ],
        ['returns empty string for non-string input', null, ''],
    ]) {
        it(label, () => {
            assert.equal(formatEventName(input), expected);
        });
    }
});

describe('sendTelemetryEvent', () => {
    it('does nothing when opted out', async () => {
        const { calls, fetchImpl } = createStubFetch();
        const sent = await sendTelemetryEvent(
            'SOLUTION_USAGE',
            { th_dv360_partner_id: '12345' },
            { env: { ...BASE_ENV, TELEMETRY_HUB_OPT_IN: 'false' }, fetchImpl }
        );
        assert.equal(sent, false);
        assert.equal(calls.length, 0);
    });

    for (const [label, envOverride] of [
        ['both credentials missing', { TELEMETRY_HUB_OPT_IN: 'true' }],
        [
            'only API secret missing',
            {
                TELEMETRY_HUB_OPT_IN: 'true',
                TELEMETRY_HUB_MEASUREMENT_ID: 'G-TEST12345',
            },
        ],
        [
            'only measurement ID missing',
            {
                TELEMETRY_HUB_OPT_IN: 'true',
                TELEMETRY_HUB_API_SECRET: 'test-secret',
            },
        ],
    ]) {
        it(`does nothing when ${label}`, async () => {
            const { calls, fetchImpl } = createStubFetch();
            const sent = await sendTelemetryEvent(
                'SOLUTION_USAGE',
                { th_dv360_partner_id: '12345' },
                { env: envOverride, fetchImpl }
            );
            assert.equal(sent, false);
            assert.equal(calls.length, 0);
        });
    }

    it('skips sending when sanitized event name is empty', async () => {
        const { calls, fetchImpl } = createStubFetch();
        const sent = await sendTelemetryEvent(
            '---!!!',
            { th_dv360_partner_id: '12345' },
            { env: BASE_ENV, fetchImpl }
        );
        assert.equal(sent, false);
        assert.equal(calls.length, 0);
    });

    it('skips sending when fetchImpl is unavailable', async () => {
        const sent = await sendTelemetryEvent(
            'SOLUTION_USAGE',
            { th_dv360_partner_id: '12345' },
            { env: BASE_ENV, fetchImpl: null }
        );
        assert.equal(sent, false);
    });

    it('skips sending without an allowlisted th_* account ID', async () => {
        const { calls, fetchImpl } = createStubFetch();
        const sent = await sendTelemetryEvent(
            'SOLUTION_USAGE',
            { label: 'partner_sync' },
            { env: BASE_ENV, fetchImpl }
        );
        assert.equal(sent, false);
        assert.equal(calls.length, 0);
    });

    it('ignores whitespace-only th_* account values', async () => {
        const { calls, fetchImpl } = createStubFetch();
        const sent = await sendTelemetryEvent(
            'SOLUTION_USAGE',
            { label: 'partner_sync', th_dv360_partner_id: '   ' },
            { env: BASE_ENV, fetchImpl }
        );
        assert.equal(sent, false);
        assert.equal(calls.length, 0);
    });

    it('strips reserved keys and fixed dimensions', async () => {
        const { calls, fetchImpl } = createStubFetch();
        const sent = await sendTelemetryEvent(
            'SOLUTION_USAGE',
            {
                name: 'OVERRIDE',
                client_id: 'evil-client',
                user_id: 'evil-user',
                api_secret: 'leaked',
                measurement_id: 'G-EVIL',
                app_instance_id: 'evil-instance',
                uuid: 'evil-uuid',
                timestamp_micros: 123,
                app: 'Wrong App',
                is_agent_event: true,
                non_personalized_ads: true,
                external_event_id: 'forged-event-id',
                th_dv360_partner_id: '998877',
            },
            { env: BASE_ENV, fetchImpl, randomUUID: () => 'fixed-uuid' }
        );

        assert.equal(sent, true);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].payload.events[0].params, {
            app: 'Demand Gen Pulse 360',
            is_agent_event: false,
            non_personalized_ads: false,
            external_event_id: 'fixed-uuid',
            th_dv360_partner_id: '998877',
        });
    });

    it('trims string values and omits empty optional eventParams', async () => {
        const { calls, fetchImpl } = createStubFetch();
        const sent = await sendTelemetryEvent(
            'SOLUTION_USAGE',
            {
                th_dv360_partner_id: ' 998877 ',
                label: ' partner_sync ',
                empty_str: '',
                blank_str: '   ',
                null_val: null,
                undef_val: undefined,
            },
            { env: BASE_ENV, fetchImpl, randomUUID: () => 'fixed-uuid' }
        );

        assert.equal(sent, true);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].payload.events[0].params, {
            app: 'Demand Gen Pulse 360',
            is_agent_event: false,
            non_personalized_ads: false,
            external_event_id: 'fixed-uuid',
            th_dv360_partner_id: '998877',
            label: 'partner_sync',
        });
    });

    it('sets JSON Content-Type and URL-encodes credentials', async () => {
        const { calls, fetchImpl } = createStubFetch();
        const sent = await sendTelemetryEvent(
            'SOLUTION_USAGE',
            { th_dv360_partner_id: '12345' },
            {
                env: {
                    TELEMETRY_HUB_OPT_IN: 'true',
                    TELEMETRY_HUB_MEASUREMENT_ID: 'G-TEST&1',
                    TELEMETRY_HUB_API_SECRET: 'sec+ret/=',
                },
                fetchImpl,
            }
        );

        assert.equal(sent, true);
        assert.equal(calls.length, 1);
        assert.equal(
            calls[0].url,
            'https://www.google-analytics.com/mp/collect?measurement_id=G-TEST%261&api_secret=sec%2Bret%2F%3D'
        );
        assert.deepEqual(calls[0].init.headers, {
            'Content-Type': 'application/json',
        });
    });

    it('normalizes a Connect Sales URL in th_opportunity_id', async () => {
        const { calls, fetchImpl } = createStubFetch();
        const sent = await sendTelemetryEvent(
            'SOLUTION_USAGE',
            {
                th_opportunity_id:
                    'https://sales.connect.corp.google.com/opportunities/93382720',
            },
            { env: BASE_ENV, fetchImpl, randomUUID: () => 'fixed-uuid' }
        );
        assert.equal(sent, true);
        assert.equal(calls.length, 1);
        assert.equal(
            calls[0].payload.events[0].params.th_opportunity_id,
            '93382720'
        );
    });

    it('omits th_opportunity_id on OPT_OUT despite env value', async () => {
        const { calls, fetchImpl } = createStubFetch();
        const sent = await sendTelemetryEvent(
            'SOLUTION_USAGE',
            { th_dv360_partner_id: '111222', th_opportunity_id: 'OPT_OUT' },
            {
                env: { ...BASE_ENV, OPPORTUNITY_ID: '555666777' },
                fetchImpl,
                randomUUID: () => 'fixed-uuid',
            }
        );
        assert.equal(sent, true);
        assert.equal(calls.length, 1);
        assert.equal(
            'th_opportunity_id' in calls[0].payload.events[0].params,
            false
        );
    });

    it('skips sending when the only account ID is OPT_OUT', async () => {
        const { calls, fetchImpl } = createStubFetch();
        const sent = await sendTelemetryEvent(
            'SOLUTION_USAGE',
            { th_opportunity_id: 'OPT_OUT' },
            { env: BASE_ENV, fetchImpl }
        );
        assert.equal(sent, false);
        assert.equal(calls.length, 0);
    });

    it('accepts env OPPORTUNITY_ID as the only account ID', async () => {
        const { calls, fetchImpl } = createStubFetch();
        const sent = await sendTelemetryEvent(
            'SOLUTION_USAGE',
            { label: 'opp_only' },
            {
                env: { ...BASE_ENV, OPPORTUNITY_ID: '555666777' },
                fetchImpl,
                randomUUID: () => 'fixed-uuid',
            }
        );

        assert.equal(sent, true);
        assert.equal(calls.length, 1);
        assert.equal(
            calls[0].payload.events[0].params.th_opportunity_id,
            '555666777'
        );
    });

    it('prefers eventParams opportunity ID over env value', async () => {
        const { calls, fetchImpl } = createStubFetch();
        const sent = await sendTelemetryEvent(
            'SOLUTION_USAGE',
            { th_dv360_partner_id: '111222', th_opportunity_id: '847291034' },
            {
                env: { ...BASE_ENV, OPPORTUNITY_ID: '555666777' },
                fetchImpl,
                randomUUID: () => 'fixed-uuid',
            }
        );

        assert.equal(sent, true);
        assert.equal(calls.length, 1);
        assert.equal(
            calls[0].payload.events[0].params.th_opportunity_id,
            '847291034'
        );
    });

    it('attaches an AbortSignal timeout by default', async () => {
        const { calls, fetchImpl } = createStubFetch();
        const sent = await sendTelemetryEvent(
            'SOLUTION_USAGE',
            { th_dv360_partner_id: '12345' },
            { env: BASE_ENV, fetchImpl }
        );
        assert.equal(sent, true);
        assert.equal(calls.length, 1);
        assert.ok(calls[0].init.signal instanceof AbortSignal);
    });

    it('omits AbortSignal timeout when timeoutMs is 0', async () => {
        const { calls, fetchImpl } = createStubFetch();
        const sent = await sendTelemetryEvent(
            'SOLUTION_USAGE',
            { th_dv360_partner_id: '12345' },
            { env: BASE_ENV, fetchImpl, timeoutMs: 0 }
        );
        assert.equal(sent, true);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].init.signal, undefined);
    });

    it('fails open on non-2xx HTTP responses', async () => {
        const { calls, fetchImpl } = createStubFetch({
            ok: false,
            status: 500,
        });
        const sent = await sendTelemetryEvent(
            'SOLUTION_USAGE',
            { th_dv360_partner_id: '12345' },
            { env: BASE_ENV, fetchImpl }
        );
        assert.equal(sent, false);
        assert.equal(calls.length, 1);
    });

    it('fails open on network exceptions', async () => {
        const sent = await sendTelemetryEvent(
            'SOLUTION_USAGE',
            { th_dv360_partner_id: '12345' },
            {
                env: BASE_ENV,
                fetchImpl: async () => {
                    throw new Error('network down');
                },
            }
        );
        assert.equal(sent, false);
    });
});

describe('sendPartnerSyncUsage', () => {
    it('sends a partner sync event in Tadau wire format', async () => {
        const { calls, fetchImpl } = createStubFetch();
        const uuids = ['event-uuid-1', 'client-uuid-1'];
        let idx = 0;

        const sent = await sendPartnerSyncUsage(998877, {
            env: BASE_ENV,
            fetchImpl,
            randomUUID: () => uuids[idx++],
        });

        assert.equal(sent, true);
        assert.equal(calls.length, 1);
        assert.equal(
            calls[0].url,
            'https://www.google-analytics.com/mp/collect?measurement_id=G-TEST12345&api_secret=test-secret'
        );
        assert.equal(calls[0].init.method, 'POST');
        assert.deepEqual(calls[0].payload, {
            client_id: 'client-uuid-1',
            non_personalized_ads: true,
            events: [
                {
                    name: 'SOLUTION_USAGE',
                    params: {
                        app: 'Demand Gen Pulse 360',
                        is_agent_event: false,
                        non_personalized_ads: false,
                        external_event_id: 'event-uuid-1',
                        label: 'partner_sync',
                        th_dv360_partner_id: '998877',
                    },
                },
            ],
        });
    });

    for (const invalidId of ['', 'not-a-number', null, undefined]) {
        it(`skips when partnerId is ${JSON.stringify(invalidId)}`, async () => {
            const { calls, fetchImpl } = createStubFetch();
            const sent = await sendPartnerSyncUsage(invalidId, {
                env: BASE_ENV,
                fetchImpl,
            });
            assert.equal(sent, false);
            assert.equal(calls.length, 0);
        });
    }
});

describe('sendAdvertiserSyncUsage', () => {
    it('sends partner, advertiser and opportunity IDs', async () => {
        const { calls, fetchImpl } = createStubFetch();
        const uuids = ['event-uuid-2', 'client-uuid-2'];
        let idx = 0;

        const sent = await sendAdvertiserSyncUsage(
            { partnerId: '111222', advertiserId: '333444' },
            {
                env: {
                    ...BASE_ENV,
                    ROPPS_URL: 'https://sales.connect.corp.google.com/opportunities/555666777',
                },
                fetchImpl,
                randomUUID: () => uuids[idx++],
            }
        );

        assert.equal(sent, true);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].payload, {
            client_id: 'client-uuid-2',
            non_personalized_ads: true,
            events: [
                {
                    name: 'SOLUTION_USAGE',
                    params: {
                        app: 'Demand Gen Pulse 360',
                        is_agent_event: false,
                        non_personalized_ads: false,
                        external_event_id: 'event-uuid-2',
                        label: 'advertiser_dg_sync',
                        th_dv360_partner_id: '111222',
                        th_dv360_advertiser_id: '333444',
                        th_opportunity_id: '555666777',
                    },
                },
            ],
        });
    });

    it('sends advertiserId only when partnerId is absent', async () => {
        const { calls, fetchImpl } = createStubFetch();
        const sent = await sendAdvertiserSyncUsage(
            { advertiserId: '333444' },
            { env: BASE_ENV, fetchImpl, randomUUID: () => 'fixed-uuid' }
        );

        assert.equal(sent, true);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].payload.events[0].params, {
            app: 'Demand Gen Pulse 360',
            is_agent_event: false,
            non_personalized_ads: false,
            external_event_id: 'fixed-uuid',
            label: 'advertiser_dg_sync',
            th_dv360_advertiser_id: '333444',
        });
    });

    it('sends partnerId only when advertiserId is invalid', async () => {
        const { calls, fetchImpl } = createStubFetch();
        const sent = await sendAdvertiserSyncUsage(
            { partnerId: '111222', advertiserId: 'not-a-number' },
            { env: BASE_ENV, fetchImpl, randomUUID: () => 'fixed-uuid' }
        );

        assert.equal(sent, true);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].payload.events[0].params, {
            app: 'Demand Gen Pulse 360',
            is_agent_event: false,
            non_personalized_ads: false,
            external_event_id: 'fixed-uuid',
            label: 'advertiser_dg_sync',
            th_dv360_partner_id: '111222',
        });
    });

    it('omits th_opportunity_id when OPPORTUNITY_ID is OPT_OUT', async () => {
        const { calls, fetchImpl } = createStubFetch();
        const sent = await sendAdvertiserSyncUsage(
            { partnerId: '111222', advertiserId: '333444' },
            {
                env: {
                    ...BASE_ENV,
                    OPPORTUNITY_ID: 'OPT_OUT',
                    ROPPS_URL: 'https://sales.connect.corp.google.com/opportunities/555666777',
                },
                fetchImpl,
                randomUUID: () => 'fixed-uuid',
            }
        );
        assert.equal(sent, true);
        assert.equal(calls.length, 1);
        assert.equal(
            'th_opportunity_id' in calls[0].payload.events[0].params,
            false
        );
    });

    it('skips when advertiserId and partnerId are both invalid', async () => {
        const { calls, fetchImpl } = createStubFetch();
        const sent = await sendAdvertiserSyncUsage(
            { partnerId: '', advertiserId: 'not-a-number' },
            { env: BASE_ENV, fetchImpl }
        );
        assert.equal(sent, false);
        assert.equal(calls.length, 0);
    });

    for (const emptyIds of [null, undefined]) {
        it(`fails open when called with ${String(emptyIds)}`, async () => {
            const { calls, fetchImpl } = createStubFetch();
            const sent = await sendAdvertiserSyncUsage(emptyIds, {
                env: BASE_ENV,
                fetchImpl,
            });
            assert.equal(sent, false);
            assert.equal(calls.length, 0);
        });
    }
});
