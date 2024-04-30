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
This script will combine data from audience performance with
the respective account and campaigns into a single BQ Table.

@param {bq_dataset} to be replaced by the answers.json's respective value (e.g.:dgpulse).
*/

CREATE OR REPLACE TABLE `{bq_dataset}_bq.audience_performance`
AS (
  WITH
    AudPerf AS (
      SELECT DISTINCT
        CS.account_name AS account_name,
        CS.account_id,
        CS.campaign_id AS campaign_id,
        CS.campaign_name AS campaign_name,
        AM.date,
        AM.clicks,
        (AM.cost / 1e6) AS cost,
        AM.conversions,
        AM.vt_conversions,
        AM.roas,
        AM.audience_name,
        AM.audience_type,
        OCID.ocid
      FROM
        `{bq_dataset}.audience_metrics` AS AM
        LEFT JOIN `{bq_dataset}.ad_group_ad` AS AGA
          ON AM.ag_id = AGA.ag_id
        LEFT JOIN `{bq_dataset}.campaign_settings` AS CS
          ON CS.account_id = AGA.account_id
          AND CS.campaign_id = AGA.campaign_id
        INNER JOIN `{bq_dataset}.ocid_mapping` AS OCID
          ON OCID.customer_id = AGA.account_id
  )
  SELECT
    account_name,
    account_id,
    campaign_id,
    campaign_name,
    date,
    audience_name,
    audience_type,
    ocid,
    SUM(clicks) AS clicks,
    SUM(cost) AS cost,
    SUM(conversions) AS conversions,
    SUM(vt_conversions) AS vt_conversions,
    SUM(roas) AS roas
  FROM AudPerf
  GROUP BY
    account_name,
    account_id,
    campaign_id,
    campaign_name,
    date,
    audience_name,
    audience_type,
    ocid
);