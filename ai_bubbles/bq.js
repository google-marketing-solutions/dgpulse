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

// TODO: solutionName should be dynamic.
const solutionName = "dgpulse";
const datasetId = `${solutionName}_ads`;
let projectId = process.env.GCP_PROJECT_ID;

const bigquery = new BigQuery({
  projectId,
});

async function getCampaignData() {
  console.log("Querying BQ: campaign_data");
  const query = `
    SELECT
      campaign_name,
      account_name,
      date,
      MAX(budget_amount) AS budget_amount,
      SUM(cost) AS cost,
      SUM(conversions) AS conversions,
      AVG(tcpa) AS cpa
    FROM
      ${projectId}.${datasetId}_bq.campaign_data
    GROUP BY 1, 2, 3
    ORDER BY date DESC`;
  return await executeQuery(query);
}

function getInsertQueryForInsights(data) {
  let finalUpdateQuery = "";
  for (let i = 0; i < data.length; i++) {
    const record = data[i];
    if (!record.insights || !record.table || !record.headline)
      throw "missing data for insert";

    finalUpdateQuery += `
            INSERT INTO
              \`${projectId}.${datasetId}_bq.insights\`
            (headline, insights, table, date)
            VALUES 
              ("${record.insights
                  .replace(/"/g, '')
                  .trim()}",
              "${record.headline
                .replace(/"/g, '')
                .trim()}",
              "${record.table}",
              CURRENT_DATE());`;
  }
  console.log(finalUpdateQuery);
  return finalUpdateQuery;
}

async function insertIntoInsights(data) {
  const query = getInsertQueryForInsights(data);
  console.log(
    `Inserting into insights: ${data.length} records`
  );
  return await executeQuery(query);
}


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

  console.log(`${rows.length} returned`);
  return rows;
}

module.exports = {
  getCampaignData,
  insertIntoInsights,
  getInsertQueryForInsights
};
