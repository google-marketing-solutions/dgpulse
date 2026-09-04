CREATE OR REPLACE TABLE `__PROJECT_ID__.__DATASET_ID__.final_line_items_performance` AS
WITH demand_gen_line_items AS (
  SELECT DISTINCT campaignId, insertionOrderId, lineItemId
  FROM `__PROJECT_ID__.__DATASET_ID__.line_items`
  WHERE lineItemType LIKE '%DEMAND_GEN%'
),
deduped_dbm AS (
  SELECT * EXCEPT(row_num) FROM (
    SELECT *, ROW_NUMBER() OVER(
      PARTITION BY Report_Day, Insertion_Order_Id, COALESCE(Line_Item_Id, 0), Creative_Id, Device_Type, Inventory_Source
    ) AS row_num
    FROM `__PROJECT_ID__.__DATASET_ID__.dbm_performance`
    WHERE Insertion_Order_Id IS NOT NULL AND Insertion_Order_Id > 0
      AND (
        (Line_Item_Id IS NOT NULL AND Line_Item_Id IN (SELECT DISTINCT CAST(lineItemId AS INT64) FROM demand_gen_line_items))
        OR (Insertion_Order_Id IN (SELECT DISTINCT CAST(insertionOrderId AS INT64) FROM demand_gen_line_items WHERE insertionOrderId IS NOT NULL))
      )
  )
  WHERE row_num = 1
),
li_stats AS (
  SELECT 
    COALESCE(Report_Day, CURRENT_DATE()) AS date,
    CAST(Line_Item_Id AS STRING) AS line_item_id,
    MAX(CAST(Advertiser_Id AS STRING)) AS advertiser_id,
    MAX(CAST(Partner_Id AS STRING)) AS partner_id,
    MAX(NULLIF(Insertion_Order, '')) AS insertion_order_name,
    MAX(CAST(Insertion_Order_Id AS STRING)) AS insertion_order_id,
    MAX(NULLIF(Device_Type, '')) AS device_type,
    MAX(NULLIF(Inventory_Source, '')) AS inventory_source,
    MAX(NULLIF(Advertiser_Currency, '')) AS currency_code,
    SUM(Impressions) AS impressions,
    SUM(Clicks) AS clicks,
    SUM(Revenue) AS cost,
    SUM(COALESCE(NULLIF(Revenue_USD, 0), Revenue)) AS cost_usd,
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
  FROM deduped_dbm
  WHERE Line_Item_Id IS NOT NULL AND Line_Item_Id > 0
  GROUP BY 1, 2
),
latest_settings AS (
  SELECT 
    advertiserId,
    MAX(NULLIF(displayName, '')) AS advertiser_name,
    MAX(NULLIF(has_crm_audience, '')) AS has_crm_audience,
    MAX(NULLIF(has_ga_audience, '')) AS has_ga_audience,
    MAX(NULLIF(floodlight_optimization_enabled, '')) AS floodlight_optimization_enabled,
    MAX(NULLIF(auto_tagging_enabled, '')) AS auto_tagging_enabled,
    MAX(NULLIF(ec_enabled, '')) AS ec_enabled,
    MAX(NULLIF(gtg_status, '')) AS gtg_status,
    MAX(NULLIF(web_tag_type, '')) AS web_tag_type,
    MAX(NULLIF(currency_code, '')) AS currency_code
  FROM `__PROJECT_ID__.__DATASET_ID__.advertiser_settings`
  GROUP BY advertiserId
),
latest_advertisers AS (
  SELECT 
    advertiserId,
    MAX(NULLIF(displayName, '')) AS displayName,
    MAX(NULLIF(currencyCode, '')) AS currency_code,
    MAX(NULLIF(partnerId, '')) AS partnerId
  FROM `__PROJECT_ID__.__DATASET_ID__.advertisers`
  GROUP BY advertiserId
),
advertiser_currencies AS (
  SELECT 
    CAST(Advertiser_Id AS STRING) AS advertiser_id,
    MAX(NULLIF(Advertiser_Currency, '')) AS currency_code,
    SAFE_DIVIDE(SUM(NULLIF(Revenue_USD, 0)), NULLIF(SUM(Revenue), 0)) AS fx_rate_to_usd
  FROM deduped_dbm
  WHERE Advertiser_Currency IS NOT NULL
  GROUP BY 1
),
latest_ios AS (
  SELECT 
    insertionOrderId AS insertion_order_id,
    MAX(NULLIF(displayName, '')) AS insertion_order_name,
    MAX(NULLIF(pacingType, '')) AS pacing_type,
    MAX(NULLIF(pacingPeriod, '')) AS pacing_period,
    MAX(budgetAmount) AS budget_amount,
    MAX(startDate) AS start_date,
    MAX(endDate) AS end_date
  FROM `__PROJECT_ID__.__DATASET_ID__.insertion_orders`
  GROUP BY 1
),
latest_line_items AS (
  SELECT 
    lineItemId,
    MAX(NULLIF(insertionOrderId, '')) AS insertionOrderId,
    MAX(NULLIF(displayName, '')) AS displayName,
    MAX(NULLIF(lineItemType, '')) AS lineItemType,
    MAX(NULLIF(entityStatus, '')) AS entityStatus,
    MAX(NULLIF(campaignId, '')) AS campaignId,
    MAX(NULLIF(advertiserId, '')) AS advertiserId
  FROM `__PROJECT_ID__.__DATASET_ID__.line_items`
  WHERE lineItemType LIKE '%DEMAND_GEN%'
  GROUP BY lineItemId
),
latest_campaigns AS (
  SELECT 
    campaignId,
    MAX(NULLIF(displayName, '')) AS displayName
  FROM `__PROJECT_ID__.__DATASET_ID__.campaigns`
  GROUP BY campaignId
)
SELECT 
  COALESCE(s.date, CURRENT_DATE()) AS date,
  li.lineItemId AS line_item_id,
  li.displayName AS line_item_name,
  li.lineItemType AS line_item_type,
  COALESCE(sett.has_crm_audience, 'NO') AS data_manager_crm_connected,
  COALESCE(sett.has_ga_audience, 'NO') AS data_manager_ga_connected,
  CASE 
    WHEN COALESCE(sett.has_crm_audience, 'NO') = 'YES' OR COALESCE(sett.has_ga_audience, 'NO') = 'YES' THEN 'PASSED'
    ELSE 'NEEDS_ACTION'
  END AS data_strength_status,
  COALESCE(sett.ec_enabled, 'NO') AS ec_enabled,
  COALESCE(sett.floodlight_optimization_enabled, 'NO') AS floodlight_optimization_enabled,
  COALESCE(sett.auto_tagging_enabled, 'NO') AS auto_tagging_enabled,
  CASE 
    WHEN sett.gtg_status = 'READY' THEN '🟢 READY'
    WHEN sett.gtg_status = 'NEEDS_TAG_UPGRADE' THEN '🔴 NEEDS_TAG_UPGRADE'
    ELSE '⚪ NOT_CONFIGURED'
  END AS gtg_status,
  COALESCE(sett.web_tag_type, 'WEB_TAG_TYPE_NONE') AS web_tag_type,
  CASE 
    WHEN COALESCE(sett.ec_enabled, 'NO') = 'YES' AND COALESCE(sett.floodlight_optimization_enabled, 'NO') = 'YES' THEN 'PASSED'
    ELSE 'NEEDS_ACTION'
  END AS activation_data_strength_status,
  li.entityStatus AS entity_status,
  IF(li.entityStatus = 'ENTITY_STATUS_PAUSED', 'YES', 'NO') AS is_limited_by_budget,
  COALESCE(li.insertionOrderId, s.insertion_order_id, io.insertion_order_id) AS insertion_order_id,
  COALESCE(io.insertion_order_name, s.insertion_order_name) AS insertion_order_name,
  io.pacing_type AS io_pacing_type,
  io.pacing_period AS io_pacing_period,
  io.budget_amount AS io_budget_amount,
  s.device_type,
  s.inventory_source,
  li.campaignId AS campaign_id,
  c.displayName AS campaign_name,
  li.advertiserId AS advertiser_id,
  li.advertiserId AS account_id,
  COALESCE(sett.advertiser_name, adv.displayName, li.advertiserId) AS account_name,
  COALESCE(
    s.currency_code, 
    NULLIF(adv.currency_code, ''), 
    ac.currency_code
  ) AS currency_code,
  COALESCE(s.partner_id, adv.partnerId, '__PARTNER_ID__') AS partner_id,

  -- Delivery & Cost
  COALESCE(s.impressions, 0) AS impressions,
  COALESCE(s.clicks, 0) AS clicks,
  COALESCE(s.cost, 0) AS cost,
  COALESCE(s.cost_usd, 0) AS cost_usd,
  SAFE_DIVIDE(COALESCE(s.clicks, 0), NULLIF(COALESCE(s.impressions, 0), 0)) AS ctr,
  SAFE_DIVIDE(COALESCE(s.cost, 0), NULLIF(COALESCE(s.clicks, 0), 0)) AS cpc,
  SAFE_DIVIDE(COALESCE(s.cost_usd, 0), NULLIF(COALESCE(s.clicks, 0), 0)) AS cpc_usd,
  SAFE_DIVIDE(COALESCE(s.cost, 0) * 1000, NULLIF(COALESCE(s.impressions, 0), 0)) AS cpm,
  SAFE_DIVIDE(COALESCE(s.cost_usd, 0) * 1000, NULLIF(COALESCE(s.impressions, 0), 0)) AS cpm_usd,

  -- Media Quality & Viewability
  COALESCE(s.active_view_viewable_impressions, 0) AS active_view_viewable_impressions,
  COALESCE(s.active_view_measurable_impressions, 0) AS active_view_measurable_impressions,
  COALESCE(s.active_view_eligible_impressions, 0) AS active_view_eligible_impressions,
  SAFE_DIVIDE(COALESCE(s.active_view_viewable_impressions, 0), NULLIF(COALESCE(s.active_view_measurable_impressions, 0), 0)) AS viewability_rate,
  SAFE_DIVIDE(COALESCE(s.active_view_measurable_impressions, 0), NULLIF(COALESCE(s.active_view_eligible_impressions, 0), 0)) AS measurable_rate,

  -- Video & YouTube Delivery
  COALESCE(s.trueview_views, 0) AS trueview_views,
  SAFE_DIVIDE(COALESCE(s.trueview_views, 0), NULLIF(COALESCE(s.impressions, 0), 0)) AS vtr,
  COALESCE(s.video_plays, 0) AS video_plays,
  COALESCE(s.video_first_quartile_completes, 0) AS video_first_quartile_completes,
  COALESCE(s.video_midpoints, 0) AS video_midpoints,
  COALESCE(s.video_third_quartile_completes, 0) AS video_third_quartile_completes,
  COALESCE(s.video_completions, 0) AS video_completions,
  SAFE_DIVIDE(COALESCE(s.video_completions, 0), NULLIF(COALESCE(s.video_plays, 0), 0)) AS video_completion_rate,

  -- Attribution Breakdown (Post-Click vs. Post-View)
  COALESCE(s.conversions, 0) AS conversions,
  COALESCE(s.post_click_conversions, 0) AS post_click_conversions,
  COALESCE(s.post_view_conversions, 0) AS post_view_conversions,
  COALESCE(s.post_click_revenue, 0) AS post_click_revenue,
  COALESCE(s.post_view_revenue, 0) AS post_view_revenue,
  SAFE_DIVIDE(COALESCE(s.post_click_conversions, 0), NULLIF(COALESCE(s.clicks, 0), 0)) AS post_click_conv_rate,

  -- Headroom & Pacing
  s.io_goal_pacing_pct,
  s.lost_is_budget,
  s.lost_is_rank
FROM latest_line_items li
LEFT JOIN latest_campaigns c
  ON li.campaignId = c.campaignId
LEFT JOIN li_stats s
  ON li.lineItemId = s.line_item_id
LEFT JOIN latest_settings sett
  ON li.advertiserId = sett.advertiserId
LEFT JOIN latest_advertisers adv
  ON li.advertiserId = adv.advertiserId
LEFT JOIN latest_ios io
  ON COALESCE(li.insertionOrderId, s.insertion_order_id) = io.insertion_order_id
LEFT JOIN advertiser_currencies ac
  ON li.advertiserId = ac.advertiser_id;
