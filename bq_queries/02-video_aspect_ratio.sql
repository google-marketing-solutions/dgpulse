-- Copyright 2025 Google LLC
--
-- Licensed under the Apache License, Version 2.0 (the "License");
-- you may not use this file except in compliance with the License.
-- You may obtain a copy of the License at
--
--     https://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing, software
-- distributed under the License is distributed on an "AS IS" BASIS,
-- WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
-- See the License for the specific language governing permissions and
-- limitations under the License.



CREATE
OR REPLACE TABLE `{bq_dataset}_bq.video_aspect_ratio` AS
WITH
  AGA AS (
    SELECT DISTINCT
      account_id,
      campaign_id,
      ARRAY_TO_STRING(
        ARRAY(
            SELECT
              ARRAY_REVERSE(SPLIT(item, "/"))[SAFE_OFFSET(0)] AS test
            FROM UNNEST(dvra_videos) as item
        ),
        '|'
    ) AS dvra_videos,
    FROM
      `{bq_dataset}.ad_group_ad`
    WHERE
      ARRAY_LENGTH(dvra_videos) > 0
  ),
  AGA_VID_SPLIT AS (
    SELECT
      account_id,
      campaign_id,
      SPLIT(dvra_videos, "|") AS dvra_videos
    FROM
      AGA
  )
SELECT
  AGA_VID_SPLIT.account_id,
  campaign_id,
  dvra_videos AS asset_id,
  video_id,
  -- The following field is post calculated using the YouTube Data API.
  -- Reason: Videos' aspect_ratio is not exposed in the Google Ads API.
  0.00 AS aspect_ratio
FROM
  AGA_VID_SPLIT
CROSS JOIN UNNEST(AGA_VID_SPLIT.dvra_videos) AS dvra_videos
LEFT JOIN
  `{bq_dataset}.asset` AS A
  ON dvra_videos = cast(A.asset_id AS string);
