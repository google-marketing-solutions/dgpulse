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

const yt = require("./yt");

// Minimizes the risk of YT API and Cloud Run functions kicking us out for making
// too many parallel calls in a short period of time. Since the limit is 700/sec,
// in this case, we're setting it as less than 100/sec:
const OUTBOUND_CALLS_THROUGHPUT_LIMIT_INTERVAL = 10;

function awaitTimeout(delay) {
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function getVideoAspectRatioCounts(assetFromAdGroupAds) {
  let countsByAccountCampaign = {};

  for (let i = 0; i < assetFromAdGroupAds.length; i++) {
    const asset = assetFromAdGroupAds[i];
    const key = `${asset.accountId}_${asset.campaignId}`;
    if (!countsByAccountCampaign[key])
      countsByAccountCampaign[key] = {
        landscape_video_count: 0,
        square_video_count: 0,
        portrait_video_count: 0,
      };

    if (asset.videoAspectRatio > 1)
      countsByAccountCampaign[key].landscape_video_count++;
    if (asset.videoAspectRatio == 1)
      countsByAccountCampaign[key].square_video_count++;
    if (asset.videoAspectRatio < 1)
      countsByAccountCampaign[key].portrait_video_count++;
  }

  return countsByAccountCampaign;
}

function getAssetsFromAdGroupAds(agas) {
  let assetFromAdGroupAds = [];
  for (let i = 0; i < agas.length; i++) {
    agas[i].dvra_videos.forEach((v) => {
      assetFromAdGroupAds.push({
        campaignId: agas[i].campaign_id,
        accountId: agas[i].account_id,
        assetId: getAssetIdFromResource(v),
      });
    });
  }
  return assetFromAdGroupAds;
}

function setVideoAspectRatioCounts(
  bqCampaignsAssetsCount,
  countsByAccountCampaign,
) {
  for (let i = 0; i < bqCampaignsAssetsCount.length; i++) {
    const cac = bqCampaignsAssetsCount[i];
    const key = `${cac.account_id}_${cac.campaign_id}`;
    if (!countsByAccountCampaign[key]) {
      console.log(
        `Info: no videos found in account + campaign ${key} combination`,
      );
    } else {
      bqCampaignsAssetsCount[i] = setVideoCountstoCampaign(
        bqCampaignsAssetsCount,
        i,
        countsByAccountCampaign,
        key,
      );
    }

    bqCampaignsAssetsCount[i].has_image_plus_video = campaignHasImageAndVideo(
      bqCampaignsAssetsCount,
      i,
    );
  }

  return bqCampaignsAssetsCount;
}

function setVideoCountstoCampaign(
  bqCampaignsAssetsCount,
  i,
  countsByAccountCampaign,
  key,
) {
  return {
    ...bqCampaignsAssetsCount[i],
    landscape_video_count: countsByAccountCampaign[key].landscape_video_count,
    square_video_count: countsByAccountCampaign[key].square_video_count,
    portrait_video_count: countsByAccountCampaign[key].portrait_video_count,
  };
}

function campaignHasImageAndVideo(bqCampaignsAssetsCount, i) {
  return (
    (bqCampaignsAssetsCount[i].dmaa_square_mkt_imgs_count > 0 ||
      bqCampaignsAssetsCount[i].dmaa_logo_imgs_count > 0 ||
      bqCampaignsAssetsCount[i].dmaa_portrait_mkt_imgs_count > 0) &&
    (bqCampaignsAssetsCount[i].landscape_video_count > 0 ||
      bqCampaignsAssetsCount[i].portrait_video_count > 0 ||
      bqCampaignsAssetsCount[i].square_video_count > 0)
  );
}

function getAssetIdFromResource(resourceName) {
  return resourceName.split("/").reverse()[0];
}

async function getAssetFromAdGroupAdsWithVideoRatio(
  assetFromAdGroupAds,
  videoAssets,
) {
  let uniqueIds = {};
  let assetFromAdGroupAdsWithVideoRatio = [];
  for (let i = 0; i < assetFromAdGroupAds.length; i++) {
    const a = assetFromAdGroupAds[i];
    const relevantVideoAsset = videoAssets.find(
      (v) => v["asset_id"] == a.assetId,
    );
    const videoId = relevantVideoAsset?.video_id;
    await awaitTimeout(OUTBOUND_CALLS_THROUGHPUT_LIMIT_INTERVAL);

    let videoAspectRatio;
    if (videoId && !uniqueIds[videoId])
      uniqueIds[videoId] = await yt.getSingleVideoAspectRatio(videoId);
    videoAspectRatio = uniqueIds[videoId];

    assetFromAdGroupAdsWithVideoRatio.push({
      videoId,
      videoAspectRatio,
      ...a,
    });
  }
  return assetFromAdGroupAdsWithVideoRatio;
}

module.exports = {
  getAssetIdFromResource,
  setVideoAspectRatioCounts,
  getAssetsFromAdGroupAds,
  getVideoAspectRatioCounts,
  getAssetFromAdGroupAdsWithVideoRatio,
  awaitTimeout,
};
