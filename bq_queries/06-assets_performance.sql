# Copyright 2024 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
/*
 This script will create a dataset for the post processing queries and it will organize 
 data from campaigns and link external account ids to ocid (OperatingCustomerId)
 to generate the deep link URLs.
 
 @param {bq_dataset} to be replaced by the answers.json's respective value (e.g.:dgpulse).
 */

CREATE
OR REPLACE TABLE `{bq_dataset}_bq.assets_performance` AS
WITH
  AssetsPerformance AS (
    SELECT
      AAV.account_id,
      AAV.asset_id,
      A.video_id,
      account_name,
      campaign_id,
      campaign_name,
      date,
      image_url,
      SUBSTR(asset_type_inferred, 
        LENGTH(asset_type_inferred) 
          - STRPOS(REVERSE(asset_type_inferred), '~') + 2)
        AS asset_type_inferred,
      SUM(clicks) AS clicks,
      SUM(conversions) AS conversions,
      SUM(ctr) AS ctr,
      SUM(cost) AS cost,
    FROM `{bq_dataset}.adgroupad_asset_view` AS AAV
    LEFT JOIN `{bq_dataset}.asset` AS A
      USING (asset_id)
    GROUP BY
      AAV.account_id,
      account_name,
      A.video_id,
      campaign_id,
      campaign_name,
      date,
      AAV.asset_id,
      image_url,
      asset_type_inferred
  )
SELECT
  account_id,
  OCID.ocid,
  account_name,
  campaign_id,
  campaign_name,
  date,
  asset_id,
  CASE
    WHEN asset_type_inferred = "YOUTUBE_VIDEO"
      THEN CONCAT("http://i3.ytimg.com/vi/", video_id , "/hqdefault.jpg")
    ELSE image_url
  END AS image_url,
  CASE
    WHEN asset_type_inferred = "SQUARE_MARKETING_IMAGE"
      THEN "SQUARE IMAGE"
    WHEN asset_type_inferred = "PORTRAIT_MARKETING_IMAGE"
      THEN "VERTICAL IMAGE"
    WHEN asset_type_inferred = "MARKETING_IMAGE"
      THEN "HORIZONTAL IMAGE"
    WHEN asset_type_inferred = "BUSINESS_NAME"
      THEN "BUSINESS NAME"
    WHEN asset_type_inferred = "UNKNOWN"
      THEN "CALL TO ACTION"
    ELSE asset_type_inferred
  END AS asset_type_inferred,
  clicks,
  conversions,
  ctr,
  cost / 1e6 AS cost
FROM AssetsPerformance
INNER JOIN `{bq_dataset}.ocid_mapping` AS OCID
  ON OCID.customer_id = account_id;