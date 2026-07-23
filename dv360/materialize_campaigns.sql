CREATE OR REPLACE TABLE `__PROJECT_ID__.__DATASET_ID__.final_campaign_performance` AS
WITH aggregated_stats AS (
  SELECT 
    CAST(Partner_Id AS STRING) AS partnerId,
    CAST(Advertiser_Id AS STRING) AS advertiserId,
    SUM(Impressions) AS Impressions,
    SUM(Clicks) AS Clicks,
    SUM(Revenue) AS Cost,
    SUM(Total_Conversions) AS Conversions
  FROM `__PROJECT_ID__.__DATASET_ID__.dbm_performance`
  GROUP BY 1, 2
)
SELECT 
  meta.campaignId,
  meta.campaignId AS campaign_id,
  meta.displayName AS campaignName,
  meta.displayName AS campaign_name,
  meta.entityStatus,
  meta.advertiserId,
  meta.advertiserId AS account_id,
  meta.advertiserId AS account_name,
  COALESCE(stats.partnerId, '__PARTNER_ID__') AS partnerId,
  COALESCE(stats.partnerId, '__PARTNER_ID__') AS partner_id,
  COALESCE(stats.Impressions, 0) AS Impressions,
  COALESCE(stats.Impressions, 0) AS impressions,
  COALESCE(stats.Clicks, 0) AS Clicks,
  COALESCE(stats.Clicks, 0) AS clicks,
  COALESCE(stats.Cost, 0) AS Cost,
  COALESCE(stats.Cost, 0) AS cost,
  COALESCE(stats.Conversions, 0) AS Conversions,
  COALESCE(stats.Conversions, 0) AS conversions,
  SAFE_DIVIDE(COALESCE(stats.Clicks, 0), COALESCE(stats.Impressions, 0)) AS ctr,
  SAFE_DIVIDE(COALESCE(stats.Cost, 0), COALESCE(stats.Clicks, 0)) AS cpc,
  SAFE_DIVIDE(COALESCE(stats.Cost, 0) * 1000, COALESCE(stats.Impressions, 0)) AS cpm
FROM `__PROJECT_ID__.__DATASET_ID__.campaigns` meta
LEFT JOIN aggregated_stats stats
  ON meta.advertiserId = stats.advertiserId;
