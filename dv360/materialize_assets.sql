CREATE OR REPLACE TABLE `__PROJECT_ID__.__DATASET_ID__.final_assets_performance` AS
WITH creative_stats AS (
  SELECT 
    CAST(Creative_Id AS STRING) AS creative_id,
    CAST(Advertiser_Id AS STRING) AS advertiser_id,
    CAST(Partner_Id AS STRING) AS partner_id,
    SUM(Impressions) AS impressions,
    SUM(Clicks) AS clicks,
    SUM(Revenue) AS cost,
    SUM(Total_Conversions) AS conversions
  FROM `__PROJECT_ID__.__DATASET_ID__.dbm_performance`
  WHERE Creative_Id IS NOT NULL AND Creative_Id > 0
  GROUP BY 1, 2, 3
)
SELECT 
  c.creativeId AS asset_id,
  c.displayName AS asset_name,
  c.creativeType AS asset_type,
  c.hostingSource AS hosting_source,
  c.entityStatus AS entity_status,
  c.advertiserId AS advertiser_id,
  c.advertiserId AS account_id,
  c.advertiserId AS account_name,
  COALESCE(cs.partner_id, '__PARTNER_ID__') AS partner_id,
  COALESCE(cs.impressions, 0) AS impressions,
  COALESCE(cs.clicks, 0) AS clicks,
  COALESCE(cs.cost, 0) AS cost,
  COALESCE(cs.conversions, 0) AS conversions,
  SAFE_DIVIDE(COALESCE(cs.clicks, 0), COALESCE(cs.impressions, 0)) AS ctr,
  SAFE_DIVIDE(COALESCE(cs.cost, 0), COALESCE(cs.clicks, 0)) AS cpc,
  SAFE_DIVIDE(COALESCE(cs.cost, 0) * 1000, COALESCE(cs.impressions, 0)) AS cpm
FROM `__PROJECT_ID__.__DATASET_ID__.creatives` c
LEFT JOIN creative_stats cs
  ON c.creativeId = cs.creative_id;
