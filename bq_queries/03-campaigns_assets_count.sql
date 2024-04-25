/*
Copyright 2024 Google LLC

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

https://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

/*
This script will combine data from campaigns, ocid (OperatingCustomerId which contains the
id to generate deep links) and video aspect ratios counts into a single BQ Table.

@param {bq_dataset} to be replaced by the answers.json's respective value (e.g.:dgpulse).
*/

CREATE OR REPLACE TABLE `{bq_dataset}_bq.campaigns_assets_count`
AS (
  WITH
    AdGroupAd AS (
      SELECT
        campaign_id,
        campaign_name,
        account_id,
        SUM(ARRAY_LENGTH(SPLIT(dmaa_descriptions, '|'))) AS dmaa_descriptions_count,
        SUM(ARRAY_LENGTH(SPLIT(aga_headlines, '|'))) AS aga_headlines_count,
        SUM(ARRAY_LENGTH(SPLIT(dmaa_square_mkt_imgs, '|'))) AS dmaa_square_mkt_imgs_count,
        SUM(ARRAY_LENGTH(SPLIT(dmaa_mkt_imgs, '|'))) AS dmaa_mkt_imgs_count,
        SUM(ARRAY_LENGTH(SPLIT(dmaa_logo_imgs, '|'))) AS dmaa_logo_imgs_count,
        SUM(ARRAY_LENGTH(SPLIT(dmaa_portrait_mkt_imgs, '|'))) AS dmaa_portrait_mkt_imgs_count
      FROM
        `{bq_dataset}.ad_group_ad`
      GROUP BY
        campaign_id,
        campaign_name,
        account_id
    ),
    OperatingCustomerId AS (
      SELECT DISTINCT
        account_id,
        ocid
      FROM
        `{bq_dataset}.ocid_mapping`
    ),
    CampaignData AS (
      SELECT DISTINCT
        account_id,
        campaign_id,
        account_name,
        IF(shopping_disable_product_feed = false
          AND shopping_merchant_id = 0, 'NO', 'YES') AS has_product_feed
      FROM
        `{bq_dataset}_bq.campaign_data`
    ),
    VideoAspectRatio AS (
      SELECT
        campaign_id,
        IF(aspect_ratio > 1, 1, 0) AS landscape_video_count,
        IF(aspect_ratio = 1, 1, 0) AS square_video_count,
        IF(aspect_ratio < 1, 1, 0) AS portrait_video_count
      FROM
        `{bq_dataset}_bq.video_aspect_ratio`
    ),
    VideoAspectRatioCount AS (
      SELECT
        campaign_id,
        SUM(landscape_video_count) AS landscape_video_count,
        SUM(square_video_count) AS square_video_count,
        SUM(portrait_video_count) AS portrait_video_count,
      FROM
        VideoAspectRatio
      GROUP BY
        campaign_id
    )
  SELECT
    AdGroupAd.campaign_id,
    AdGroupAd.campaign_name,
    CampaignData.account_name,
    CampaignData.has_product_feed,
    AdGroupAd.account_id AS account_id,
    OperatingCustomerId.ocid,
    IFNULL(AdGroupAd.dmaa_descriptions_count, 0) AS dmaa_descriptions_count,
    IFNULL(AdGroupAd.aga_headlines_count, 0) AS aga_headlines_count,
    IFNULL(AdGroupAd.dmaa_square_mkt_imgs_count, 0) AS dmaa_square_mkt_imgs_count,
    IFNULL(AdGroupAd.dmaa_mkt_imgs_count, 0) AS dmaa_mkt_imgs_count,
    IFNULL(AdGroupAd.dmaa_logo_imgs_count, 0) AS dmaa_logo_imgs_count,
    IFNULL(AdGroupAd.dmaa_portrait_mkt_imgs_count, 0) AS dmaa_portrait_mkt_imgs_count,
    IFNULL(VideoAspectRatioCount.landscape_video_count, 0) AS landscape_video_count,
    IFNULL(VideoAspectRatioCount.square_video_count, 0) AS square_video_count,
    IFNULL(VideoAspectRatioCount.portrait_video_count, 0) AS portrait_video_count,
    IF(
        (
          (dmaa_square_mkt_imgs_count > 0
            OR dmaa_logo_imgs_count > 0
            OR dmaa_portrait_mkt_imgs_count > 0)
          AND
          (landscape_video_count > 0
            OR portrait_video_count > 0
            OR square_video_count > 0)
        ),
      'YES', 'NO'
    ) AS has_image_plus_video
  FROM
    AdGroupAd
  INNER JOIN OperatingCustomerId
    ON OperatingCustomerId.account_id = AdGroupAd.account_id
  INNER JOIN CampaignData
    ON CampaignData.campaign_id = AdGroupAd.campaign_id
  LEFT JOIN VideoAspectRatioCount
    ON VideoAspectRatioCount.campaign_id = AdGroupAd.campaign_id
);