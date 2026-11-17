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
// TODO: make solutionName dynamic based on user input.
const solutionName = "dgpulse_ads";
const datasetId = `${solutionName}_reference_data`;
// TODO: make baseCurrency a parameter during installation
const baseCurrency = "usd";

const GCP_PROJECT_ID_REGEX = /^(?:[a-z0-9-]+:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const BQ_IDENTIFIER_REGEX = /^[A-Za-z0-9_]{1,1024}$/;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_CODE_REGEX = /^[A-Za-z]{3}$/;
const SAFE_TICKER_KEY_REGEX = /^[A-Za-z0-9]{1,20}$/;

let bigqueryClientOverride = null;
let cachedBigQueryClient = null;

function validateProjectId(rawProjectId = process.env.GCP_PROJECT_ID) {
  if (
    typeof rawProjectId !== "string" ||
    !GCP_PROJECT_ID_REGEX.test(rawProjectId)
  ) {
    throw new Error("Invalid or missing GCP_PROJECT_ID environment variable.");
  }
  return rawProjectId;
}

function getValidatedTableFqn(rawProjectId = process.env.GCP_PROJECT_ID) {
  const validProjectId = validateProjectId(rawProjectId);
  if (!BQ_IDENTIFIER_REGEX.test(datasetId)) {
    throw new Error("Invalid BigQuery dataset identifier.");
  }
  return `${validProjectId}.${datasetId}.exchange_rates`;
}

function isValidCalendarDate(dateStr) {
  if (typeof dateStr !== "string" || !ISO_DATE_REGEX.test(dateStr)) {
    return false;
  }
  const parsed = new Date(`${dateStr}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === dateStr
  );
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function validateAndNormalizeExchangeRates(
  exchangeRates,
  expectedBaseCurrency = baseCurrency
) {
  if (!isPlainObject(exchangeRates)) {
    throw new Error("Exchange-rate payload must be a non-null JSON object.");
  }
  if (!CURRENCY_CODE_REGEX.test(expectedBaseCurrency)) {
    throw new Error("Base currency must be a 3-letter ISO currency code.");
  }
  const { date } = exchangeRates;
  if (!isValidCalendarDate(date)) {
    throw new Error(
      "Exchange-rate payload has an invalid date; expected YYYY-MM-DD."
    );
  }

  const baseKey = expectedBaseCurrency.toLowerCase();
  const ratesMap = exchangeRates[baseKey];
  if (!isPlainObject(ratesMap)) {
    throw new Error(
      `Exchange-rate payload missing currency map for '${baseKey}'.`
    );
  }

  const targetCurrencies = [];
  const rates = [];

  for (const [rawCurrency, rate] of Object.entries(ratesMap)) {
    if (!SAFE_TICKER_KEY_REGEX.test(rawCurrency)) {
      throw new Error("Exchange-rate payload contains an invalid currency key.");
    }
    // Skip non-ISO 3-letter tickers (e.g. alphanumeric crypto tickers in JSON feeds).
    if (!CURRENCY_CODE_REGEX.test(rawCurrency)) {
      continue;
    }
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
      throw new Error(
        `Invalid numeric exchange rate for currency '${rawCurrency.toUpperCase()}'.`
      );
    }
    targetCurrencies.push(rawCurrency.toUpperCase());
    rates.push(rate);
  }

  if (targetCurrencies.length === 0) {
    throw new Error(
      "Exchange-rate payload contained zero valid 3-letter currency rates."
    );
  }

  return {
    baseCurrency: expectedBaseCurrency.toUpperCase(),
    date,
    targetCurrencies,
    rates,
  };
}

function getBigQueryClient() {
  if (bigqueryClientOverride) {
    return bigqueryClientOverride;
  }
  if (!cachedBigQueryClient) {
    const { BigQuery } = require("@google-cloud/bigquery");
    cachedBigQueryClient = new BigQuery({
      projectId: validateProjectId(),
    });
  }
  return cachedBigQueryClient;
}

function setBigQueryClientForTesting(client) {
  bigqueryClientOverride = client;
}

async function executeQuery(queryOptions) {
  const options =
    typeof queryOptions === "string"
      ? { query: queryOptions, useLegacySql: false }
      : { ...queryOptions, useLegacySql: false };
  const [rows] = await getBigQueryClient().query(options);
  return rows;
}

function getInsertQueryForExchangeRates(
  exchangeRates,
  rawProjectId = process.env.GCP_PROJECT_ID
) {
  const tableFqn = getValidatedTableFqn(rawProjectId);
  const normalized = validateAndNormalizeExchangeRates(exchangeRates);

  const query = `INSERT INTO \`${tableFqn}\`
  (base_currency, target_currency, rate, date)
SELECT
  @baseCurrency,
  target_currency,
  rate,
  PARSE_DATE('%F', @rateDate)
FROM
  UNNEST(@targetCurrencies) AS target_currency WITH OFFSET AS idx
INNER JOIN
  UNNEST(@rates) AS rate WITH OFFSET AS r_idx
  ON idx = r_idx`;

  return {
    query,
    params: {
      baseCurrency: normalized.baseCurrency,
      rateDate: normalized.date,
      targetCurrencies: normalized.targetCurrencies,
      rates: normalized.rates,
    },
    types: {
      baseCurrency: "STRING",
      rateDate: "STRING",
      targetCurrencies: ["STRING"],
      rates: ["FLOAT64"],
    },
  };
}

function getAtomicReplaceQueryForExchangeRates(
  exchangeRates,
  rawProjectId = process.env.GCP_PROJECT_ID
) {
  const tableFqn = getValidatedTableFqn(rawProjectId);
  const insertSpec = getInsertQueryForExchangeRates(
    exchangeRates,
    rawProjectId
  );

  return {
    query: `BEGIN TRANSACTION;
DELETE FROM \`${tableFqn}\`
WHERE target_currency IS NOT NULL;
${insertSpec.query};
COMMIT TRANSACTION;`,
    params: insertSpec.params,
    types: insertSpec.types,
  };
}

async function deleteExchangeRates() {
  const tableFqn = getValidatedTableFqn();
  const query = `DELETE FROM \`${tableFqn}\`
WHERE target_currency IS NOT NULL`;
  console.log("Deleting from BQ: exchange_rates");
  return await executeQuery({ query });
}

async function insertExchangeRates(exchangeRates) {
  const querySpec = getInsertQueryForExchangeRates(exchangeRates);
  console.log(
    `Inserting into BQ: exchange_rates (${querySpec.params.targetCurrencies.length} currencies for ${querySpec.params.rateDate})`
  );
  return await executeQuery(querySpec);
}

async function replaceExchangeRates(exchangeRates) {
  const querySpec = getAtomicReplaceQueryForExchangeRates(exchangeRates);
  console.log(
    `Atomically replacing BQ exchange_rates (${querySpec.params.targetCurrencies.length} currencies for ${querySpec.params.rateDate})`
  );
  return await executeQuery(querySpec);
}

module.exports = {
  insertExchangeRates,
  getInsertQueryForExchangeRates,
  getAtomicReplaceQueryForExchangeRates,
  validateAndNormalizeExchangeRates,
  deleteExchangeRates,
  replaceExchangeRates,
  setBigQueryClientForTesting,
};
