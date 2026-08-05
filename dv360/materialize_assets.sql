CREATE OR REPLACE TABLE `__PROJECT_ID__.__DATASET_ID__.final_assets_performance` AS
WITH creative_stats AS (
  SELECT 
    COALESCE(Report_Day, CURRENT_DATE()) AS date,
    CAST(Creative_Id AS STRING) AS creative_id,
    CAST(Advertiser_Id AS STRING) AS advertiser_id,
    CAST(Partner_Id AS STRING) AS partner_id,
    ANY_VALUE(Device_Type) AS device_type,
    ANY_VALUE(Inventory_Source) AS inventory_source,
    SUM(Impressions) AS impressions,
    SUM(Clicks) AS clicks,
    SUM(Revenue) AS cost,
    SUM(Total_Conversions) AS conversions,
    SUM(COALESCE(Active_View_Viewable_Impressions, 0)) AS active_view_viewable_impressions,
    SUM(COALESCE(Active_View_Measurable_Impressions, 0)) AS active_view_measurable_impressions,
    SUM(COALESCE(TrueView_Views, 0)) AS trueview_views
  FROM `__PROJECT_ID__.__DATASET_ID__.dbm_performance`
  WHERE Creative_Id IS NOT NULL AND Creative_Id > 0
  GROUP BY 1, 2, 3, 4
)
SELECT 
  COALESCE(cs.date, CURRENT_DATE()) AS date,
  c.creativeId AS asset_id,
  c.displayName AS asset_name,
  c.creativeType AS asset_type,
  c.hostingSource AS hosting_source,
  c.entityStatus AS entity_status,
  cs.device_type,
  cs.inventory_source,
  c.advertiserId AS advertiser_id,
  c.advertiserId AS account_id,
  c.advertiserId AS account_name,
  COALESCE(cs.partner_id, '__PARTNER_ID__') AS partner_id,
  COALESCE(cs.impressions, 0) AS impressions,
  COALESCE(cs.clicks, 0) AS clicks,
  COALESCE(cs.cost, 0) AS cost,
  COALESCE(cs.conversions, 0) AS conversions,
  COALESCE(cs.active_view_viewable_impressions, 0) AS active_view_viewable_impressions,
  COALESCE(cs.active_view_measurable_impressions, 0) AS active_view_measurable_impressions,
  SAFE_DIVIDE(COALESCE(cs.active_view_viewable_impressions, 0), COALESCE(cs.active_view_measurable_impressions, 0)) AS viewability_rate,
  COALESCE(cs.trueview_views, 0) AS trueview_views,
  SAFE_DIVIDE(COALESCE(cs.trueview_views, 0), COALESCE(cs.impressions, 0)) AS vtr,
  SAFE_DIVIDE(COALESCE(cs.clicks, 0), COALESCE(cs.impressions, 0)) AS ctr,
  SAFE_DIVIDE(COALESCE(cs.cost, 0), COALESCE(cs.clicks, 0)) AS cpc,
  SAFE_DIVIDE(COALESCE(cs.cost, 0) * 1000, COALESCE(cs.impressions, 0)) AS cpm
FROM `__PROJECT_ID__.__DATASET_ID__.creatives` c
LEFT JOIN creative_stats cs
  ON c.creativeId = cs.creative_id;
