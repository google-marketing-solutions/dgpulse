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

const functions = require("@google-cloud/functions-framework");
const bq = require("./bq");
const helpers = require("./helpers");

functions.http("ytarfGET", async (req, res) => {
  const agGroupAds = await bq.getAdGroupAds();
  let assetFromAdGroupAds = helpers.getAssetsFromAdGroupAds(agGroupAds);

  console.log("Getting and organizing relevant data from Assets");
  const videoAssets = await bq.getVideoAssets();

  console.log("Adding video data to assets");
  const assetFromAdGroupAdsWithVideoRatio =
    await helpers.getAssetFromAdGroupAdsWithVideoRatio(
      assetFromAdGroupAds,
      videoAssets,
    );

  console.log("Getting counts by video aspect ratio");
  const countsByAccountCampaign = helpers.getVideoAspectRatioCounts(
    assetFromAdGroupAdsWithVideoRatio,
  );

  console.log("Setting video information to final campaign assets count");
  const bqCampaignsAssetsCount = await bq.getCampaignsAssetsCount();
  const campaignsAssetsFinalCount = helpers.setVideoAspectRatioCounts(
    bqCampaignsAssetsCount,
    countsByAccountCampaign,
  );

  console.log("Sending updated video information to BQ");
  bq.updateCampaignsAssetsCounts(campaignsAssetsFinalCount);

  res.send(
    "BigQuery UPDATEs queued for execution and should complete in a few minutes.",
  );
});
