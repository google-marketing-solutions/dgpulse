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
OR REPLACE TABLE `{bq_dataset}_bq.campaign_data` AS WITH targets_raw AS (
  SELECT
    account_id,
    campaign_id,
    CASE
      WHEN campaign_mcv_troas > 0 THEN campaign_mcv_troas
      WHEN campaign_troas > 0 THEN campaign_troas
      WHEN bidding_strategy_mcv_troas > 0 THEN bidding_strategy_mcv_troas
      WHEN bidding_strategy_troas > 0 THEN bidding_strategy_troas
      ELSE 0
    END AS troas,
    CASE
      WHEN campaign_mc_tcpa > 0 THEN campaign_mc_tcpa
      WHEN campaign_tcpa > 0 THEN campaign_tcpa
      WHEN bidding_strategy_mc_tcpa > 0 THEN bidding_strategy_mc_tcpa
      WHEN bidding_strategy_tcpa > 0 THEN bidding_strategy_tcpa
      ELSE 0
    END AS tcpa
  FROM
    `{bq_dataset}.campaign_settings`
),
campaigns_with_lookalikes AS (
  SELECT
    DISTINCT am.campaign_id
  FROM
    `{bq_dataset}.audience_metrics` AS am
  WHERE
    EXISTS (
      SELECT
        1
      FROM
        `{bq_dataset}.ad_group_criterion` AS agc
      WHERE
        am.criterion_id = agc.criterion_id
    )
),
targets AS (
  SELECT
    account_id,
    campaign_id,
    ANY_VALUE(troas) AS troas,
    ANY_VALUE(tcpa) AS tcpa
  FROM
    targets_raw
  GROUP BY
    1,
    2
)
SELECT
  C.date,
  C.account_id,
  C.account_name,
  C.campaign_id,
  C.campaign_name,
  C.bidding_strategy,
  C.shopping_disable_product_feed,
  C.shopping_merchant_id,
  ((C.budget_amount / 1e6) / ER.rate) AS budget_amount,
  T.troas,
  (T.tcpa / 1e6) AS tcpa,
  ((C.cost / 1e6) / ER.rate) AS cost,
  C.conversions,
  OCID.ocid,
  CASE
    WHEN CWL.campaign_id IS NOT NULL THEN 'YES'
    ELSE 'NO'
  END AS has_lookalike_audience
FROM
  `{bq_dataset}.campaign_settings` AS C
  LEFT JOIN targets AS T ON C.account_id = T.account_id
  AND C.campaign_id = T.campaign_id
  LEFT JOIN `{bq_dataset}.ocid_mapping` AS OCID ON OCID.customer_id = C.account_id
  LEFT JOIN `{bq_dataset}.customer` AS CUST ON CUST.account_id = C.account_id
  LEFT JOIN `{bq_dataset}_reference_data.exchange_rates` AS ER ON CUST.currency_code = ER.target_currency
  LEFT JOIN campaigns_with_lookalikes AS CWL ON C.campaign_id = CWL.campaign_id;
