//  Copyright 2024 Google LLC
//
//  Licensed under the Apache License, Version 2.0 (the "License");
//  you may not use this file except in compliance with the License.
//  You may obtain a copy of the License at
//
//    https://www.apache.org/licenses/LICENSE-2.0
//
//  Unless required by applicable law or agreed to in writing, software
//  distributed under the License is distributed on an "AS IS" BASIS,
//  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//  See the License for the specific language governing permissions and
//  limitations under the License.

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

async function executeQuery(query) {
  const options = {
    configuration: {
      query: {
        query,
        useLegacySql: false,
      },
    },
  };

  // Run the query as a job
  const response = await bigquery.createJob(options);
  const job = response[0];
  const [rows] = await job.getQueryResults(job);

  return rows;
}

function getInsertQueryForExchangeRates(exchangeRates) {
  const { date } = exchangeRates;
  let finalUpdateQuery = `INSERT INTO
      \`${projectId}.${datasetId}.exchange_rates\`
      (base_currency, target_currency, rate, date)
    VALUES`;

  for (let targetCurrency in exchangeRates[baseCurrency]) {
    // skips non ISO three-letter currency codes:
    if (targetCurrency.length > 3) continue;
    const rate = exchangeRates[baseCurrency][targetCurrency];
    finalUpdateQuery += `
      (
        "${baseCurrency.toUpperCase()}",
        "${targetCurrency.toUpperCase()}",
        ${rate},
        "${date}"
      ),`;
  }
  return finalUpdateQuery.substring(0, finalUpdateQuery.length - 1);
}

async function insertExchangeRates(exchangeRates) {
  const query = getInsertQueryForExchangeRates(exchangeRates);
  console.log(
    `Inserting into BQ: exchange_rates: ${JSON.stringify(
      exchangeRates[baseCurrency]
    )}`
  );
  return await executeQuery(query);
}

module.exports = {
  insertExchangeRates,
  getInsertQueryForExchangeRates,
};
