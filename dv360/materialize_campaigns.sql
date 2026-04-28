CREATE OR REPLACE TABLE `__PROJECT_ID__.__DATASET_ID__.final_campaign_performance` AS
SELECT 
  meta.campaignId,
  meta.displayName AS campaignName,
  meta.entityStatus,
  stats.Impressions,
  stats.Clicks,
  stats.Cost,
  stats.Conversions
FROM `__PROJECT_ID__.__DATASET_ID__.campaigns` meta
LEFT JOIN `__PROJECT_ID__.__DATASET_ID__.p_Campaign___PARTNER_ID__` stats
  ON meta.campaignId = stats.Campaign_Id
WHERE stats._PARTITIONDATE = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
