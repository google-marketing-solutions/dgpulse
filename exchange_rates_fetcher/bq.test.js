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
const test = require("node:test");
const assert = require("node:assert/strict");
const bq = require("./bq");

test("getInsertQueryForExchangeRates builds parameterized SQL and skips non-3-letter tickers", () => {
  const payload = {
    date: "2026-11-09",
    usd: {
      usd: 1,
      eur: 0.9259259,
      gbp: 0.7777778,
      "1inch": 3.45,
      usdt: 1.0001,
    },
  };

  const spec = bq.getInsertQueryForExchangeRates(payload, "demo-dgpulse-proj");

  assert.equal(spec.query.includes("2026-11-09"), false);
  assert.equal(spec.query.includes("0.9259259"), false);
  assert.match(
    spec.query,
    /INSERT INTO `demo-dgpulse-proj\.dgpulse_ads_reference_data\.exchange_rates`/
  );
  assert.match(spec.query, /UNNEST\(@targetCurrencies\)/);
  assert.match(spec.query, /UNNEST\(@rates\)/);
  assert.match(spec.query, /PARSE_DATE\('%F', @rateDate\)/);

  assert.deepEqual(spec.params, {
    baseCurrency: "USD",
    rateDate: "2026-11-09",
    targetCurrencies: ["USD", "EUR", "GBP"],
    rates: [1, 0.9259259, 0.7777778],
  });
  assert.deepEqual(spec.types, {
    baseCurrency: "STRING",
    rateDate: "STRING",
    targetCurrencies: ["STRING"],
    rates: ["FLOAT64"],
  });
});

test("rejects SQL injection payloads in date, currency keys, rates, and projectId", () => {
  assert.throws(
    () =>
      bq.getInsertQueryForExchangeRates(
        {
          date: '2024-01-01"); DROP TABLE `proj.dgpulse_ads_bq.campaign_data`;--',
          usd: { eur: 0.92 },
        },
        "demo-dgpulse-proj"
      ),
    /invalid date/i
  );

  assert.throws(
    () =>
      bq.getInsertQueryForExchangeRates(
        {
          date: "2026-02-31",
          usd: { eur: 0.92 },
        },
        "demo-dgpulse-proj"
      ),
    /invalid date/i
  );

  assert.throws(
    () =>
      bq.getInsertQueryForExchangeRates(
        {
          date: "2026-11-09",
          usd: { 'eu"': 0.92 },
        },
        "demo-dgpulse-proj"
      ),
    /invalid currency key/i
  );

  assert.throws(
    () =>
      bq.getInsertQueryForExchangeRates(
        {
          date: "2026-11-09",
          usd: { eur: "0.92); DROP TABLE x;--" },
        },
        "demo-dgpulse-proj"
      ),
    /Invalid numeric exchange rate/i
  );

  for (const badRate of [0, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () =>
        bq.getInsertQueryForExchangeRates(
          {
            date: "2026-11-09",
            usd: { eur: badRate },
          },
          "demo-dgpulse-proj"
        ),
      /Invalid numeric exchange rate/i
    );
  }

  assert.throws(
    () =>
      bq.getInsertQueryForExchangeRates(
        {
          date: "2026-11-09",
          usd: { usdt: 1.0 },
        },
        "demo-dgpulse-proj"
      ),
    /zero valid 3-letter currency rates/i
  );

  assert.throws(
    () =>
      bq.getInsertQueryForExchangeRates(
        {
          date: "2026-11-09",
          usd: { eur: 0.92 },
        },
        "bad-proj`; DROP TABLE x;--"
      ),
    /Invalid or missing GCP_PROJECT_ID/i
  );
});

test("replaceExchangeRates executes atomic transaction via bigquery.query and never touches BQ on invalid input", async () => {
  const calls = [];
  process.env.GCP_PROJECT_ID = "demo-dgpulse-proj";
  bq.setBigQueryClientForTesting({
    query: async (opts) => {
      calls.push(opts);
      return [[]];
    },
  });

  await assert.rejects(
    () =>
      bq.replaceExchangeRates({
        date: '2026-11-09"); DROP TABLE x;--',
        usd: { eur: 0.92 },
      }),
    /invalid date/i
  );
  assert.equal(calls.length, 0);

  await bq.replaceExchangeRates({
    date: "2026-11-09",
    usd: { usd: 1, eur: 0.92 },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].useLegacySql, false);
  assert.match(calls[0].query, /^BEGIN TRANSACTION;/);
  assert.match(calls[0].query, /COMMIT TRANSACTION;$/);
  assert.deepEqual(calls[0].params.targetCurrencies, ["USD", "EUR"]);
  assert.deepEqual(calls[0].types.rates, ["FLOAT64"]);

  bq.setBigQueryClientForTesting(null);
});
