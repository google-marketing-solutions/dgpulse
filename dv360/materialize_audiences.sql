-- Copyright 2026 Google LLC
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

-- Audience performance, sourced from a YOUTUBE-type Bid Manager report.
--
-- The source table changed shape substantially. The Display audience-list
-- dimensions (Audience_List, Audience_List_Id, Audience_List_Type) return no
-- data at all for Demand Gen inventory, because they belong to the Audience
-- Performance report, which is not available for YouTube & partners line
-- items. The report now uses FILTER_TRUEVIEW_AUDIENCE_SEGMENT instead. See
-- createOrGetAudienceReportQuery in dv360.js.
--
-- Consequences visible in this file:
--   * No line item. Accepted by the API but omitted, as it multiplied rows
--     without feeding the dashboard.
--   * No audience ID. The YouTube report emits a taxonomy path
--     ("/Business Services/Business Financial Services") and no numeric key,
--     so the segment name is the grain.
--   * No conversions, VTC, CPA or ROAS. No conversion metric of any kind can
--     accompany the audience segment dimension -- each candidate was rejected
--     by queries.create individually. CTR, CPC and CPM are provided instead so
--     the page still has efficiency measures.
CREATE OR REPLACE TABLE `__PROJECT_ID__.__DATASET_ID__.final_audiences_performance` AS
WITH demand_gen_ios AS (
  SELECT DISTINCT insertionOrderId
  FROM `__PROJECT_ID__.__DATASET_ID__.line_items`
  WHERE lineItemType LIKE '%DEMAND_GEN%'
    AND insertionOrderId IS NOT NULL
),
-- The report is already scoped to the Demand Gen insertion orders by its own
-- filters, so this normally removes nothing. It is kept because that scoping
-- degrades to partner-wide when the entity sync has not yet populated
-- line_items on a fresh install, and in that window the report would otherwise
-- carry Display and other YouTube inventory into a Demand Gen dashboard.
-- Unlike every other table in DGPulse, these rows have no lineItemType of
-- their own to filter on.
deduped_dbm AS (
  SELECT * EXCEPT(row_num) FROM (
    SELECT *, ROW_NUMBER() OVER(
      PARTITION BY Report_Day, Insertion_Order_Id, Audience_Segment, Audience_Segment_Type
    ) AS row_num
    FROM `__PROJECT_ID__.__DATASET_ID__.dbm_audiences_performance`
    WHERE Insertion_Order_Id IS NOT NULL AND Insertion_Order_Id > 0
      AND CAST(Insertion_Order_Id AS STRING) IN (SELECT insertionOrderId FROM demand_gen_ios)
  )
  WHERE row_num = 1
),
audience_stats AS (
  SELECT
    COALESCE(Report_Day, CURRENT_DATE()) AS date,
    CAST(Advertiser_Id AS STRING) AS advertiser_id,
    CAST(Insertion_Order_Id AS STRING) AS insertion_order_id,
    COALESCE(NULLIF(Audience_Segment, ''), 'Unassigned / Optimized Targeting') AS audience_segment,
    COALESCE(NULLIF(Audience_Segment_Type, ''), 'OTHER') AS raw_audience_type,
    MAX(NULLIF(Advertiser_Currency, '')) AS currency_code,
    SUM(Impressions) AS impressions,
    SUM(Clicks) AS clicks,
    SUM(Revenue) AS cost,
    SUM(COALESCE(NULLIF(Revenue_USD, 0), Revenue)) AS cost_usd
  FROM deduped_dbm
  GROUP BY 1, 2, 3, 4, 5
),
-- Campaign is not available from the audience report -- FILTER_MEDIA_PLAN is
-- rejected in this combination -- so resolve it from the insertion order.
io_campaigns AS (
  SELECT
    insertionOrderId,
    MAX(NULLIF(campaignId, '')) AS campaignId
  FROM `__PROJECT_ID__.__DATASET_ID__.insertion_orders`
  GROUP BY insertionOrderId
),
latest_campaigns AS (
  SELECT
    campaignId,
    MAX(NULLIF(displayName, '')) AS displayName
  FROM `__PROJECT_ID__.__DATASET_ID__.campaigns`
  GROUP BY campaignId
),
latest_ios AS (
  SELECT
    insertionOrderId,
    MAX(NULLIF(displayName, '')) AS displayName
  FROM `__PROJECT_ID__.__DATASET_ID__.insertion_orders`
  GROUP BY insertionOrderId
),
latest_advertisers AS (
  SELECT
    advertiserId,
    MAX(NULLIF(displayName, '')) AS displayName,
    MAX(NULLIF(currencyCode, '')) AS currency_code,
    MAX(NULLIF(partnerId, '')) AS partnerId
  FROM `__PROJECT_ID__.__DATASET_ID__.advertisers`
  GROUP BY advertiserId
),
latest_settings AS (
  SELECT
    advertiserId,
    MAX(NULLIF(displayName, '')) AS advertiser_name,
    MAX(NULLIF(currency_code, '')) AS currency_code
  FROM `__PROJECT_ID__.__DATASET_ID__.advertiser_settings`
  GROUP BY advertiserId
)
SELECT
  s.date,
  -- Partner is no longer a column on the report: it is filtered to a single
  -- partner, so the dimension would have been constant. Resolved from the
  -- advertiser, with the deployment's own partner as the final fallback.
  COALESCE(adv.partnerId, '__PARTNER_ID__') AS partner_id,
  s.advertiser_id,
  s.advertiser_id AS account_id,
  COALESCE(sett.advertiser_name, adv.displayName, s.advertiser_id) AS account_name,
  ioc.campaignId AS campaign_id,
  COALESCE(c.displayName, ioc.campaignId) AS campaign_name,
  s.insertion_order_id,
  COALESCE(io.displayName, s.insertion_order_id) AS insertion_order_name,
  s.audience_segment,

  -- The YouTube report's segment types read as human labels rather than enums
  -- ("In-market segment", "Affinity segment", "Remarketing list"), so these
  -- patterns match words, not enum fragments. Anything unrecognised passes
  -- through unchanged rather than collapsing to OTHER, so a new segment type
  -- shows up on the dashboard as itself instead of silently merging into a
  -- bucket.
  CASE
    WHEN UPPER(s.raw_audience_type) LIKE '%REMARKETING%'
      OR UPPER(s.raw_audience_type) LIKE '%YOUR DATA%'
      OR UPPER(s.raw_audience_type) LIKE '%CUSTOMER MATCH%'
      OR UPPER(s.raw_audience_type) LIKE '%FIRST%PARTY%' THEN 'USER_LIST (1PD)'
    WHEN UPPER(s.raw_audience_type) LIKE '%SIMILAR%'
      OR UPPER(s.raw_audience_type) LIKE '%LOOKALIKE%' THEN 'LOOKALIKE'
    WHEN UPPER(s.raw_audience_type) LIKE '%CUSTOM%' THEN 'CUSTOM_AUDIENCE'
    WHEN UPPER(s.raw_audience_type) LIKE '%IN-MARKET%'
      OR UPPER(s.raw_audience_type) LIKE '%IN MARKET%'
      OR UPPER(s.raw_audience_type) LIKE '%AFFINITY%'
      OR UPPER(s.raw_audience_type) LIKE '%INTEREST%'
      OR UPPER(s.raw_audience_type) LIKE '%LIFE EVENT%'
      OR UPPER(s.raw_audience_type) LIKE '%DEMOGRAPHIC%' THEN 'USER_INTEREST (Google Audience)'
    WHEN UPPER(s.raw_audience_type) LIKE '%THIRD%PARTY%' THEN 'THIRD_PARTY'
    ELSE s.raw_audience_type
  END AS audience_type,

  -- Kept as the raw label so the dashboard can show exactly what DV360 called
  -- it, independent of the bucketing above.
  s.raw_audience_type AS audience_type_raw,

  CASE
    WHEN UPPER(s.raw_audience_type) LIKE '%REMARKETING%'
      OR UPPER(s.raw_audience_type) LIKE '%YOUR DATA%'
      OR UPPER(s.raw_audience_type) LIKE '%CUSTOMER MATCH%'
      OR UPPER(s.raw_audience_type) LIKE '%FIRST%PARTY%' THEN 'YES'
    ELSE 'NO'
  END AS is_first_party,

  COALESCE(s.currency_code, NULLIF(adv.currency_code, ''), NULLIF(sett.currency_code, '')) AS currency_code,

  -- Performance metrics.
  --
  -- There is deliberately no conversions, vtc, cpa or roas column: no
  -- conversion metric can be requested alongside the audience segment
  -- dimension. CTR, CPC and CPM are the efficiency measures available from
  -- impressions, clicks and cost alone.
  COALESCE(s.impressions, 0) AS impressions,
  COALESCE(s.clicks, 0) AS clicks,
  COALESCE(s.cost, 0) AS cost,
  COALESCE(s.cost_usd, 0) AS cost_usd,
  SAFE_DIVIDE(COALESCE(s.clicks, 0), NULLIF(COALESCE(s.impressions, 0), 0)) AS ctr,
  SAFE_DIVIDE(COALESCE(s.cost, 0), NULLIF(COALESCE(s.clicks, 0), 0)) AS avg_cpc,
  SAFE_DIVIDE(COALESCE(s.cost_usd, 0), NULLIF(COALESCE(s.clicks, 0), 0)) AS avg_cpc_usd,
  SAFE_DIVIDE(COALESCE(s.cost, 0) * 1000, NULLIF(COALESCE(s.impressions, 0), 0)) AS cpm,
  SAFE_DIVIDE(COALESCE(s.cost_usd, 0) * 1000, NULLIF(COALESCE(s.impressions, 0), 0)) AS cpm_usd
FROM audience_stats s
LEFT JOIN io_campaigns ioc ON s.insertion_order_id = ioc.insertionOrderId
LEFT JOIN latest_campaigns c ON ioc.campaignId = c.campaignId
LEFT JOIN latest_ios io ON s.insertion_order_id = io.insertionOrderId
LEFT JOIN latest_advertisers adv ON s.advertiser_id = adv.advertiserId
LEFT JOIN latest_settings sett ON s.advertiser_id = sett.advertiserId;
