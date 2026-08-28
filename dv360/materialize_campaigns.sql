CREATE OR REPLACE TABLE `__PROJECT_ID__.__DATASET_ID__.final_campaign_performance` AS
WITH aggregated_stats AS (
  SELECT 
    COALESCE(Report_Day, CURRENT_DATE()) AS date,
    CAST(Partner_Id AS STRING) AS partner_id,
    CAST(Advertiser_Id AS STRING) AS advertiser_id,
    ANY_VALUE(Advertiser_Currency) AS currency_code,
    SUM(Impressions) AS impressions,
    SUM(Clicks) AS clicks,
    SUM(Revenue) AS cost,
    SUM(Total_Conversions) AS conversions,
    SUM(COALESCE(Active_View_Viewable_Impressions, 0)) AS active_view_viewable_impressions,
    SUM(COALESCE(Active_View_Measurable_Impressions, 0)) AS active_view_measurable_impressions,
    SUM(COALESCE(Active_View_Eligible_Impressions, 0)) AS active_view_eligible_impressions,
    SUM(COALESCE(TrueView_Views, 0)) AS trueview_views,
    SUM(COALESCE(Video_Plays, 0)) AS video_plays,
    SUM(COALESCE(Video_First_Quartile_Completes, 0)) AS video_first_quartile_completes,
    SUM(COALESCE(Video_Midpoints, 0)) AS video_midpoints,
    SUM(COALESCE(Video_Third_Quartile_Completes, 0)) AS video_third_quartile_completes,
    SUM(COALESCE(Video_Completions, 0)) AS video_completions,
    SUM(COALESCE(Post_Click_Conversions, 0)) AS post_click_conversions,
    SUM(COALESCE(Post_View_Conversions, 0)) AS post_view_conversions,
    SUM(COALESCE(CM_Post_Click_Revenue, 0)) AS post_click_revenue,
    SUM(COALESCE(CM_Post_View_Revenue, 0)) AS post_view_revenue,
    AVG(Percentage_From_Current_IO_Goal) AS io_goal_pacing_pct,
    AVG(TrueView_Lost_IS_Budget) AS lost_is_budget,
    AVG(TrueView_Lost_IS_Rank) AS lost_is_rank
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
    ANY_VALUE(ec_enabled) AS ec_enabled,
    ANY_VALUE(gtg_status) AS gtg_status,
    ANY_VALUE(web_tag_type) AS web_tag_type
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
  COALESCE(stats.currency_code, 'USD') AS currency_code,
  COALESCE(lic.is_limited_by_budget, 'NO') AS is_limited_by_budget,
  COALESCE(lic.line_item_count, 0) AS line_item_count,
  COALESCE(lic.has_demand_gen_line_item, 'NO') AS has_demand_gen_line_item,
  COALESCE(sett.has_crm_audience, 'NO') AS data_manager_crm_connected,
  COALESCE(sett.has_ga_audience, 'NO') AS data_manager_ga_connected,
  CASE 
    WHEN sett.gtg_status = 'READY' THEN '🟢 READY'
    WHEN sett.gtg_status = 'NEEDS_TAG_UPGRADE' THEN '🔴 NEEDS_TAG_UPGRADE'
    ELSE '⚪ NOT_CONFIGURED'
  END AS gtg_status,
  COALESCE(sett.web_tag_type, 'WEB_TAG_TYPE_NONE') AS web_tag_type,
  CASE 
    WHEN COALESCE(lic.has_demand_gen_line_item, 'NO') = 'NO' THEN 'N/A'
    WHEN COALESCE(sett.has_crm_audience, 'NO') = 'YES' OR COALESCE(sett.has_ga_audience, 'NO') = 'YES' THEN 'PASSED'
    ELSE 'NEEDS_ACTION'
  END AS data_strength_status,
  COALESCE(stats.partner_id, '__PARTNER_ID__') AS partner_id,
  
  -- Delivery & Cost
  COALESCE(stats.impressions, 0) AS impressions,
  COALESCE(stats.clicks, 0) AS clicks,
  COALESCE(stats.cost, 0) AS cost,
  SAFE_DIVIDE(COALESCE(stats.clicks, 0), NULLIF(COALESCE(stats.impressions, 0), 0)) AS ctr,
  SAFE_DIVIDE(COALESCE(stats.cost, 0), NULLIF(COALESCE(stats.clicks, 0), 0)) AS cpc,
  SAFE_DIVIDE(COALESCE(stats.cost, 0) * 1000, NULLIF(COALESCE(stats.impressions, 0), 0)) AS cpm,

  -- Media Quality & Viewability
  COALESCE(stats.active_view_viewable_impressions, 0) AS active_view_viewable_impressions,
  COALESCE(stats.active_view_measurable_impressions, 0) AS active_view_measurable_impressions,
  COALESCE(stats.active_view_eligible_impressions, 0) AS active_view_eligible_impressions,
  SAFE_DIVIDE(COALESCE(stats.active_view_viewable_impressions, 0), NULLIF(COALESCE(stats.active_view_measurable_impressions, 0), 0)) AS viewability_rate,
  SAFE_DIVIDE(COALESCE(stats.active_view_measurable_impressions, 0), NULLIF(COALESCE(stats.active_view_eligible_impressions, 0), 0)) AS measurable_rate,

  -- Video & YouTube Delivery
  COALESCE(stats.trueview_views, 0) AS trueview_views,
  SAFE_DIVIDE(COALESCE(stats.trueview_views, 0), NULLIF(COALESCE(stats.impressions, 0), 0)) AS vtr,
  COALESCE(stats.video_plays, 0) AS video_plays,
  COALESCE(stats.video_first_quartile_completes, 0) AS video_first_quartile_completes,
  COALESCE(stats.video_midpoints, 0) AS video_midpoints,
  COALESCE(stats.video_third_quartile_completes, 0) AS video_third_quartile_completes,
  COALESCE(stats.video_completions, 0) AS video_completions,
  SAFE_DIVIDE(COALESCE(stats.video_completions, 0), NULLIF(COALESCE(stats.video_plays, 0), 0)) AS video_completion_rate,

  -- Attribution Breakdown (Post-Click vs. Post-View)
  COALESCE(stats.conversions, 0) AS conversions,
  COALESCE(stats.post_click_conversions, 0) AS post_click_conversions,
  COALESCE(stats.post_view_conversions, 0) AS post_view_conversions,
  COALESCE(stats.post_click_revenue, 0) AS post_click_revenue,
  COALESCE(stats.post_view_revenue, 0) AS post_view_revenue,
  SAFE_DIVIDE(COALESCE(stats.post_click_conversions, 0), NULLIF(COALESCE(stats.clicks, 0), 0)) AS post_click_conv_rate,

  -- Headroom & Pacing
  stats.io_goal_pacing_pct,
  stats.lost_is_budget,
  stats.lost_is_rank
FROM `__PROJECT_ID__.__DATASET_ID__.campaigns` meta
LEFT JOIN aggregated_stats stats
  ON meta.advertiserId = stats.advertiser_id
LEFT JOIN line_item_counts lic
  ON meta.campaignId = lic.campaignId
LEFT JOIN latest_settings sett
  ON meta.advertiserId = sett.advertiserId
LEFT JOIN latest_advertisers adv
  ON meta.advertiserId = adv.advertiserId;
