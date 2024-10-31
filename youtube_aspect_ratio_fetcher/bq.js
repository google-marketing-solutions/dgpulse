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

async function getCampaignsAssetsCount() {
  console.log("Querying BQ: campaigns_assets_count");
  const query = `
        SELECT 
            campaign_id,
            account_id,
            dmaa_square_mkt_imgs_count,
            dmaa_mkt_imgs_count,
            dmaa_logo_imgs_count,
            dmaa_portrait_mkt_imgs_count,
            landscape_video_count,
            square_video_count,
            portrait_video_count
        FROM ${projectId}.${datasetId}_bq.campaigns_assets_count`;
  return await executeQuery(query);
}

async function getVideoAssets() {
  console.log("Querying BQ: asset");
  const query = `
        SELECT *
        FROM ${projectId}.${datasetId}.asset
        WHERE video_id IS NOT NULL`;
  return await executeQuery(query);
}

async function getAdGroupAds() {
  console.log("Querying BQ: ad_group_ad");
  const query = `
        SELECT 
            account_id,
            campaign_id,
            dvra_videos
        FROM ${projectId}.${datasetId}.ad_group_ad
        WHERE array_length(dvra_videos) > 0`;
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

function getUpdateQueryForCampaignsAssetsCount(campaignsAssetsCounts) {
  let finalUpdateQuery = "";
  for (let i = 0; i < campaignsAssetsCounts.length; i++) {
    const cac = campaignsAssetsCounts[i];
    finalUpdateQuery += `
            UPDATE
                \`${projectId}.${datasetId}_bq.campaigns_assets_count\`
            SET 
                square_video_count = ${cac.square_video_count},
                portrait_video_count = ${cac.portrait_video_count},
                landscape_video_count = ${cac.landscape_video_count},
                has_image_plus_video = "${cac.has_image_plus_video}"
            WHERE campaign_id = ${cac.campaign_id}
                AND account_id = ${cac.account_id};`;
  }
  return finalUpdateQuery;
}

async function updateCampaignsAssetsCounts(campaignsAssetsFinalCount) {
  const query = getUpdateQueryForCampaignsAssetsCount(
    campaignsAssetsFinalCount
  );
  console.log(
    `Updating BQ: campaigns_assets_count: ${campaignsAssetsFinalCount.length} records`
  );
  return await executeQuery(query);
}


function getUpdateQueryForAssetAspectRatio(assetFromAdGroupAdsWithVideoRatio) {
  let finalUpdateQuery = "";
  for (let i = 0; i < assetFromAdGroupAdsWithVideoRatio.length; i++) {
    const assetWithRatio = assetFromAdGroupAdsWithVideoRatio[i];
    const assetTypeInferred
      = assetWithRatio.videoAspectRatio == 1
        ? "SQUARE VIDEO"
        : assetWithRatio.videoAspectRatio > 1
          ? "LANDSCAPE VIDEO"
          : "PORTRAIT VIDEO";
    finalUpdateQuery += `
            UPDATE
                \`${projectId}.${datasetId}_bq.assets_performance\`
            SET 
                asset_type_inferred = "${assetTypeInferred}"
            WHERE asset_id = ${assetWithRatio.assetId};`;
  }
  return finalUpdateQuery;
}

async function updateAssetsAspectRatio(campaignsAssetsFinalCount) {
  const query = getUpdateQueryForAssetAspectRatio(
    campaignsAssetsFinalCount
  );
  console.log(
    `Updating BQ: assets_performance: ${campaignsAssetsFinalCount.length} records`
  );
  return await executeQuery(query);
}

module.exports = {
  getVideoAssets,
  updateAssetsAspectRatio,
  getAdGroupAds,
  getCampaignsAssetsCount,
  updateCampaignsAssetsCounts,
  getUpdateQueryForCampaignsAssetsCount,
  getUpdateQueryForAssetAspectRatio
};
