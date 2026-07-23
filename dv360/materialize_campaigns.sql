CREATE OR REPLACE TABLE `__PROJECT_ID__.__DATASET_ID__.final_campaign_performance` AS
WITH aggregated_stats AS (
  SELECT 
    CAST(Partner_Id AS STRING) AS partner_id,
    CAST(Advertiser_Id AS STRING) AS advertiser_id,
    SUM(Impressions) AS impressions,
    SUM(Clicks) AS clicks,
    SUM(Revenue) AS cost,
    SUM(Total_Conversions) AS conversions
  FROM `__PROJECT_ID__.__DATASET_ID__.dbm_performance`
  GROUP BY 1, 2
)
SELECT 
  meta.campaignId AS campaign_id,
  meta.displayName AS campaign_name,
  meta.entityStatus AS entity_status,
  meta.advertiserId AS advertiser_id,
  meta.advertiserId AS account_id,
  meta.advertiserId AS account_name,
  COALESCE(stats.partner_id, '__PARTNER_ID__') AS partner_id,
  COALESCE(stats.impressions, 0) AS impressions,
  COALESCE(stats.clicks, 0) AS clicks,
  COALESCE(stats.cost, 0) AS cost,
  COALESCE(stats.conversions, 0) AS conversions,
  SAFE_DIVIDE(COALESCE(stats.clicks, 0), COALESCE(stats.impressions, 0)) AS ctr,
  SAFE_DIVIDE(COALESCE(stats.cost, 0), COALESCE(stats.clicks, 0)) AS cpc,
  SAFE_DIVIDE(COALESCE(stats.cost, 0) * 1000, COALESCE(stats.impressions, 0)) AS cpm
FROM `__PROJECT_ID__.__DATASET_ID__.campaigns` meta
LEFT JOIN aggregated_stats stats
  ON meta.advertiserId = stats.advertiser_id;
