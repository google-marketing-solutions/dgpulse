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
OR REPLACE TABLE `{bq_dataset}_bq.account_conversion_action` AS
WITH
  UNIQUE_CONVERSION_ACTION_NAMES AS (
    SELECT DISTINCT
      account_id,
      conversion_action_category,
      conversion_action_name,
      REGEXP_EXTRACT(conversion_action, r'/([^/]+)/?$') AS conversion_action_id,
      RANK() OVER(PARTITION BY account_id
        ORDER BY CAST(date AS DATE) DESC) AS rank
    FROM `{bq_dataset}.campaign_conversion_action_category` AS CC
    WHERE conversion_action_category != 'DEFAULT'
  ),
  CONVERSION_ACTION_CATEGORY_COUNTS AS (
    SELECT
      CC.account_id,
      COUNT(DISTINCT(UCAN.conversion_action_name)) AS ca_name_count,
      string_agg(DISTINCT(UCAN.conversion_action_category),', ') AS ca_category_list,
    FROM UNIQUE_CONVERSION_ACTION_NAMES AS UCAN
    INNER JOIN `{bq_dataset}.campaign_settings` AS CC
      USING (account_id)
    WHERE UCAN.rank = 1
    GROUP BY account_id
  ),
  ACCOUNT_DDA AS (
    SELECT
      ADDA.account_id,
      COUNT(ADDA.dda_conversion_action) AS dda_conversion_action_count
    FROM UNIQUE_CONVERSION_ACTION_NAMES AS UCAN
    INNER JOIN `{bq_dataset}.account_dda` AS ADDA
      ON CAST(ADDA.conversion_action_id AS STRING) = UCAN.conversion_action_id
    WHERE UCAN.rank = 1
    GROUP BY ADDA.account_id
  )
SELECT DISTINCT
  ADDA.account_id,
  CC.account_name,
  OCID.ocid,
  IFNULL(CAST(CACC.ca_name_count AS STRING), '0') AS ca_name_count,
  IFNULL(CACC.ca_category_list, '--') AS ca_category_list,
  IF(C.ecl_enabled = true,
    'ENABLED', 'DISABLED') AS ecl_status,
  IF(ADDA.dda_conversion_action_count > 0,
    'ENABLED', 'DISABLED') AS dda_conversion_action_status
FROM `{bq_dataset}.ocid_mapping` AS OCID
INNER JOIN `{bq_dataset}.campaign_settings` AS CC
  ON CC.account_id = OCID.customer_id
LEFT JOIN CONVERSION_ACTION_CATEGORY_COUNTS AS CACC
  USING (account_id)
LEFT JOIN ACCOUNT_DDA AS ADDA
  USING (account_id)
LEFT JOIN `{bq_dataset}.customer` AS C
  USING (account_id);
