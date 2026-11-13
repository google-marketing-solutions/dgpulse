/*
 * Copyright 2025 Google LLC
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
const { BigQuery } = require("@google-cloud/bigquery");

// TODO: make solutionName dynamic based on user input.
const solutionName = "dgpulse_ads";
const datasetId = `${solutionName}_reference_data`;
let projectId = process.env.GCP_PROJECT_ID;
// TODO: make baseCurrency a parameter during installation
const baseCurrency = "usd";

const bigquery = new BigQuery({
  projectId,
});

// UPDATED: Now supports passing parameters to BigQuery safely
async function executeQuery(query, params = null) {
  const options = {
    query: query,
    useLegacySql: false,
  };

  if (params) {
    options.params = params;
  }

  // Use bigquery.query() which natively supports parameterization
  const [rows] = await bigquery.query(options);
  return rows;
}

function getInsertQueryForExchangeRates(exchangeRates) {
  const { date } = exchangeRates;

  // STRICT VALIDATION 1: Validate date format strictly (YYYY-MM-DD)
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Security Exception: Invalid date format received: ${date}`);
  }

  let valuesClauses = [];
  let params = {
    baseCurrency: baseCurrency.toUpperCase(),
    date: date
  };

  let paramIndex = 0;

  for (let targetCurrency in exchangeRates[baseCurrency]) {
    // STRICT VALIDATION 2: Currency keys must strictly be 3 alphabetical characters
    if (!/^[A-Za-z]{3}$/.test(targetCurrency)) continue;

    const rate = exchangeRates[baseCurrency][targetCurrency];

    // STRICT VALIDATION 3: Rate must be a number
    if (typeof rate !== 'number' || isNaN(rate)) {
      console.warn(`Skipping invalid rate for ${targetCurrency}: ${rate}`);
      continue;
    }

    // Prepare parameterized placeholders to prevent SQL injection
    valuesClauses.push(`(@baseCurrency, @targetCurrency${paramIndex}, @rate${paramIndex}, @date)`);
    params[`targetCurrency${paramIndex}`] = targetCurrency.toUpperCase();
    params[`rate${paramIndex}`] = rate;
    
    paramIndex++;
  }

  if (valuesClauses.length === 0) {
    throw new Error("Security Exception: No valid exchange rates found to insert after validation.");
  }

  // Use parameterized values securely instead of raw string concatenation
  const query = `INSERT INTO \`${projectId}.${datasetId}.exchange_rates\` (base_currency, target_currency, rate, date) VALUES ${valuesClauses.join(', ')}`;

  return { query, params };
}

async function deleteExchangeRates() {
  const query = `DELETE \`${projectId}.${datasetId}.exchange_rates\` WHERE target_currency IS NOT NULL`;
  console.log(`Deleting from BQ: exchange_rates`);
  return await executeQuery(query);
}

async function insertExchangeRates(exchangeRates) {
  const { query, params } = getInsertQueryForExchangeRates(exchangeRates);
  console.log(`Inserting into BQ: exchange_rates for date ${exchangeRates.date}`);
  return await executeQuery(query, params);
}

module.exports = {
  insertExchangeRates,
  getInsertQueryForExchangeRates,
  deleteExchangeRates,
};

