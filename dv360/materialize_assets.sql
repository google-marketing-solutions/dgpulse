CREATE OR REPLACE TABLE `__PROJECT_ID__.__DATASET_ID__.final_assets_performance` AS
WITH creative_stats AS (
  SELECT 
    CAST(Creative_Id AS STRING) AS creativeId,
    CAST(Advertiser_Id AS STRING) AS advertiserId,
    SUM(Impressions) AS impressions,
    SUM(Clicks) AS clicks,
    SUM(Revenue) AS cost,
    SUM(Total_Conversions) AS conversions
  FROM `__PROJECT_ID__.__DATASET_ID__.dbm_performance`
  WHERE Creative_Id IS NOT NULL AND Creative_Id > 0
  GROUP BY 1, 2
)
SELECT 
  c.creativeId AS asset_id,
  c.displayName AS asset_name,
  c.creativeType AS asset_type,
  c.entityStatus,
  c.advertiserId,
  COALESCE(cs.impressions, 0) AS impressions,
  COALESCE(cs.clicks, 0) AS clicks,
  COALESCE(cs.cost, 0) AS cost,
  COALESCE(cs.conversions, 0) AS conversions
FROM `__PROJECT_ID__.__DATASET_ID__.creatives` c
LEFT JOIN creative_stats cs
  ON c.creativeId = cs.creativeId;
