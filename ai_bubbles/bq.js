//  Copyright 2025 Google LLC
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

const lighterQueries = {
  "campaign_data": `
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
    ORDER BY date DESC`,

  "campaigns_assets_count": `
    SELECT
      campaign_name,
      account_name,
      has_product_feed,
      dmaa_descriptions_count AS descriptions,
      aga_headlines_count AS headlines,
      dmaa_square_mkt_imgs_count AS square_images,
      dmaa_mkt_imgs_count AS landscape_images,
      dmaa_logo_imgs_count AS logos,
      dmaa_portrait_mkt_imgs_count AS portrait_images,
      landscape_video_count AS landscape_videos,
      square_video_count AS square_videos,
      portrait_video_count AS portrait_videos,
      has_image_plus_video
    FROM
      ${projectId}.${datasetId}_bq.campaigns_assets_count
  `
}

async function getData(table) {
  console.log("Querying BQ: ", table);
  const query = lighterQueries[table];
  return await executeQuery(query);
}

function escapeSQLString(str) {
  if (typeof str != 'string') {
    return str;
  }
  return str.replace(/[\0\x08\x09\x1a\n\r"'\\\%]/g, function (char) {
    switch (char) {
      case "\0":
        return "\\0";
      case "\x08":
        return "\\b";
      case "\x09":
        return "\\t";
      case "\x1a":
        return "\\z";
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case '"':
      case "'":
      case "\\":
      case "%":
        return "\\" + char; // prepends a backslash to backslash, percent,
                            // and double/single quotes
      default:
        return char;
    }
  });
}


function getInsertQueryForInsights(data) {
  let finalUpdateQuery = "";
  for (let i = 0; i < data.length; i++) {
    const record = data[i];
    if (!record.insights || !record.table || !record.headline)
      throw "missing data for insert";

    const escapedInsights = escapeSQLString(record.insights);
    const escapedHeadline = escapeSQLString(record.headline);

    finalUpdateQuery += `
            INSERT INTO
              \`${projectId}.${datasetId}_bq.insights\`
            (insights, headline, table, date)
            VALUES
              ("${escapedInsights}",
              "${escapedHeadline}",
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
  getData,
  insertIntoInsights,
  getInsertQueryForInsights
};
