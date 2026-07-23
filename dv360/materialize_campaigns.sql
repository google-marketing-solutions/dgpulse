CREATE OR REPLACE TABLE `__PROJECT_ID__.__DATASET_ID__.final_campaign_performance` AS
WITH aggregated_stats AS (
  SELECT 
    CAST(Advertiser_Id AS STRING) AS advertiserId,
    CAST(Insertion_Order_Id AS STRING) AS insertionOrderId,
    SUM(Impressions) AS Impressions,
    SUM(Clicks) AS Clicks,
    SUM(Revenue) AS Cost,
    SUM(Total_Conversions) AS Conversions
  FROM `__PROJECT_ID__.__DATASET_ID__.dbm_performance`
  GROUP BY 1, 2
)
SELECT 
  meta.campaignId,
  meta.displayName AS campaignName,
  meta.entityStatus,
  meta.advertiserId,
  COALESCE(stats.Impressions, 0) AS Impressions,
  COALESCE(stats.Clicks, 0) AS Clicks,
  COALESCE(stats.Cost, 0) AS Cost,
  COALESCE(stats.Conversions, 0) AS Conversions
FROM `__PROJECT_ID__.__DATASET_ID__.campaigns` meta
LEFT JOIN aggregated_stats stats
  ON meta.advertiserId = stats.advertiserId;
