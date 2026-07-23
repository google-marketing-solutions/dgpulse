CREATE OR REPLACE TABLE `__PROJECT_ID__.__DATASET_ID__.final_line_items_performance` AS
WITH li_stats AS (
  SELECT 
    CAST(Advertiser_Id AS STRING) AS advertiser_id,
    CAST(Partner_Id AS STRING) AS partner_id,
    SUM(Impressions) AS impressions,
    SUM(Clicks) AS clicks,
    SUM(Revenue) AS cost,
    SUM(Total_Conversions) AS conversions
  FROM `__PROJECT_ID__.__DATASET_ID__.dbm_performance`
  GROUP BY 1, 2
)
SELECT 
  li.lineItemId AS line_item_id,
  li.displayName AS line_item_name,
  li.lineItemType AS line_item_type,
  li.entityStatus AS entity_status,
  IF(li.entityStatus = 'ENTITY_STATUS_PAUSED', 'YES', 'NO') AS is_limited_by_budget,
  li.campaignId AS campaign_id,
  c.displayName AS campaign_name,
  li.advertiserId AS advertiser_id,
  li.advertiserId AS account_id,
  li.advertiserId AS account_name,
  COALESCE(s.partner_id, '__PARTNER_ID__') AS partner_id,
  COALESCE(s.impressions, 0) AS impressions,
  COALESCE(s.clicks, 0) AS clicks,
  COALESCE(s.cost, 0) AS cost,
  COALESCE(s.conversions, 0) AS conversions,
  SAFE_DIVIDE(COALESCE(s.clicks, 0), COALESCE(s.impressions, 0)) AS ctr,
  SAFE_DIVIDE(COALESCE(s.cost, 0), COALESCE(s.clicks, 0)) AS cpc,
  SAFE_DIVIDE(COALESCE(s.cost, 0) * 1000, COALESCE(s.impressions, 0)) AS cpm
FROM `__PROJECT_ID__.__DATASET_ID__.line_items` li
LEFT JOIN `__PROJECT_ID__.__DATASET_ID__.campaigns` c
  ON li.campaignId = c.campaignId
LEFT JOIN li_stats s
  ON li.advertiserId = s.advertiser_id;
