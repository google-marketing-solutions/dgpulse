CREATE OR REPLACE TABLE `__PROJECT_ID__.__DATASET_ID__.final_campaign_performance` AS
WITH aggregated_stats AS (
  SELECT 
    COALESCE(Report_Day, CURRENT_DATE()) AS date,
    CAST(Partner_Id AS STRING) AS partner_id,
    CAST(Advertiser_Id AS STRING) AS advertiser_id,
    SUM(Impressions) AS impressions,
    SUM(Clicks) AS clicks,
    SUM(Revenue) AS cost,
    SUM(Total_Conversions) AS conversions,
    SUM(COALESCE(Active_View_Viewable_Impressions, 0)) AS active_view_viewable_impressions,
    SUM(COALESCE(Active_View_Measurable_Impressions, 0)) AS active_view_measurable_impressions,
    SUM(COALESCE(TrueView_Views, 0)) AS trueview_views
  FROM `__PROJECT_ID__.__DATASET_ID__.dbm_performance`
  GROUP BY 1, 2, 3
),
line_item_counts AS (
  SELECT 
    campaignId,
    COUNT(lineItemId) AS line_item_count,
    IF(LOGICAL_OR(entityStatus = 'ENTITY_STATUS_PAUSED'), 'YES', 'NO') AS is_limited_by_budget,
    IF(LOGICAL_OR(lineItemType LIKE '%DEMAND_GEN%'), 'YES', 'NO') AS has_demand_gen_line_item
  FROM `__PROJECT_ID__.__DATASET_ID__.line_items`
  GROUP BY campaignId
),
latest_settings AS (
  SELECT 
    advertiserId,
    ANY_VALUE(displayName) AS advertiser_name,
    ANY_VALUE(has_crm_audience) AS has_crm_audience,
    ANY_VALUE(has_ga_audience) AS has_ga_audience,
    ANY_VALUE(floodlight_optimization_enabled) AS floodlight_optimization_enabled,
    ANY_VALUE(auto_tagging_enabled) AS auto_tagging_enabled,
    ANY_VALUE(ec_enabled) AS ec_enabled
  FROM `__PROJECT_ID__.__DATASET_ID__.advertiser_settings`
  GROUP BY advertiserId
),
latest_advertisers AS (
  SELECT 
    advertiserId,
    ANY_VALUE(displayName) AS displayName
  FROM `__PROJECT_ID__.__DATASET_ID__.advertisers`
  GROUP BY advertiserId
)
SELECT 
  COALESCE(stats.date, CURRENT_DATE()) AS date,
  meta.campaignId AS campaign_id,
  meta.displayName AS campaign_name,
  meta.entityStatus AS entity_status,
  meta.advertiserId AS advertiser_id,
  meta.advertiserId AS account_id,
  COALESCE(sett.advertiser_name, adv.displayName, meta.advertiserId) AS account_name,
  COALESCE(lic.is_limited_by_budget, 'NO') AS is_limited_by_budget,
  COALESCE(lic.line_item_count, 0) AS line_item_count,
  COALESCE(lic.has_demand_gen_line_item, 'NO') AS has_demand_gen_line_item,
  COALESCE(sett.has_crm_audience, 'NO') AS data_manager_crm_connected,
  COALESCE(sett.has_ga_audience, 'NO') AS data_manager_ga_connected,
  CASE 
    WHEN COALESCE(lic.has_demand_gen_line_item, 'NO') = 'NO' THEN 'N/A'
    WHEN COALESCE(sett.has_crm_audience, 'NO') = 'YES' OR COALESCE(sett.has_ga_audience, 'NO') = 'YES' THEN 'PASSED'
    ELSE 'NEEDS_ACTION'
  END AS data_strength_status,
  COALESCE(stats.partner_id, '__PARTNER_ID__') AS partner_id,
  COALESCE(stats.impressions, 0) AS impressions,
  COALESCE(stats.clicks, 0) AS clicks,
  COALESCE(stats.cost, 0) AS cost,
  COALESCE(stats.conversions, 0) AS conversions,
  COALESCE(stats.active_view_viewable_impressions, 0) AS active_view_viewable_impressions,
  COALESCE(stats.active_view_measurable_impressions, 0) AS active_view_measurable_impressions,
  SAFE_DIVIDE(COALESCE(stats.active_view_viewable_impressions, 0), COALESCE(stats.active_view_measurable_impressions, 0)) AS viewability_rate,
  COALESCE(stats.trueview_views, 0) AS trueview_views,
  SAFE_DIVIDE(COALESCE(stats.trueview_views, 0), COALESCE(stats.impressions, 0)) AS vtr,
  SAFE_DIVIDE(COALESCE(stats.clicks, 0), COALESCE(stats.impressions, 0)) AS ctr,
  SAFE_DIVIDE(COALESCE(stats.cost, 0), COALESCE(stats.clicks, 0)) AS cpc,
  SAFE_DIVIDE(COALESCE(stats.cost, 0) * 1000, COALESCE(stats.impressions, 0)) AS cpm
FROM `__PROJECT_ID__.__DATASET_ID__.campaigns` meta
LEFT JOIN aggregated_stats stats
  ON meta.advertiserId = stats.advertiser_id
LEFT JOIN line_item_counts lic
  ON meta.campaignId = lic.campaignId
LEFT JOIN latest_settings sett
  ON meta.advertiserId = sett.advertiserId
LEFT JOIN latest_advertisers adv
  ON meta.advertiserId = adv.advertiserId;
