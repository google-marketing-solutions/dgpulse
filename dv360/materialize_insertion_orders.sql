CREATE OR REPLACE TABLE `__PROJECT_ID__.__DATASET_ID__.final_insertion_orders_performance` AS
WITH deduped_dbm AS (
  SELECT * EXCEPT(row_num) FROM (
    SELECT *, ROW_NUMBER() OVER(
      PARTITION BY Report_Day, Insertion_Order_Id, Creative_Id, Device_Type, Inventory_Source
    ) AS row_num
    FROM `__PROJECT_ID__.__DATASET_ID__.dbm_performance`
    WHERE Insertion_Order_Id IS NOT NULL AND Insertion_Order_Id > 0
  )
  WHERE row_num = 1
),
io_flight_totals AS (
  SELECT 
    CAST(Insertion_Order_Id AS STRING) AS insertion_order_id,
    SUM(Revenue) AS cumulative_spend,
    SUM(COALESCE(NULLIF(Revenue_USD, 0), Revenue)) AS cumulative_spend_usd,
    SUM(Impressions) AS cumulative_impressions
  FROM deduped_dbm
  GROUP BY 1
),
io_stats AS (
  SELECT 
    COALESCE(Report_Day, CURRENT_DATE()) AS date,
    CAST(Insertion_Order_Id AS STRING) AS insertion_order_id,
    MAX(CAST(Advertiser_Id AS STRING)) AS advertiser_id,
    MAX(CAST(Partner_Id AS STRING)) AS partner_id,
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
  GROUP BY 1, 2
),
latest_campaigns AS (
  SELECT 
    campaignId,
    MAX(NULLIF(displayName, '')) AS displayName
  FROM `__PROJECT_ID__.__DATASET_ID__.campaigns`
  GROUP BY campaignId
),
latest_ios AS (
  SELECT 
    insertionOrderId AS insertion_order_id,
    MAX(NULLIF(displayName, '')) AS insertion_order_name,
    MAX(NULLIF(advertiserId, '')) AS advertiser_id,
    MAX(NULLIF(campaignId, '')) AS campaign_id,
    MAX(NULLIF(entityStatus, '')) AS entity_status,
    MAX(NULLIF(pacingType, '')) AS pacing_type,
    MAX(NULLIF(pacingPeriod, '')) AS pacing_period,
    MAX(dailyMaxAmount) AS daily_max_amount,
    MAX(NULLIF(budgetUnit, '')) AS budget_unit,
    MAX(budgetAmount) AS budget_amount,
    MAX(startDate) AS start_date,
    MAX(endDate) AS end_date
  FROM `__PROJECT_ID__.__DATASET_ID__.insertion_orders`
  GROUP BY 1
),
latest_advertisers AS (
  SELECT 
    advertiserId,
    MAX(NULLIF(displayName, '')) AS displayName,
    MAX(NULLIF(currencyCode, '')) AS currency_code
  FROM `__PROJECT_ID__.__DATASET_ID__.advertisers`
  GROUP BY advertiserId
),
latest_settings AS (
  SELECT 
    advertiserId,
    MAX(NULLIF(gtg_status, '')) AS gtg_status,
    MAX(NULLIF(web_tag_type, '')) AS web_tag_type,
    MAX(NULLIF(currency_code, '')) AS currency_code
  FROM `__PROJECT_ID__.__DATASET_ID__.advertiser_settings`
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
)
SELECT 
  COALESCE(s.date, CURRENT_DATE()) AS date,
  io.insertion_order_id,
  io.insertion_order_name,
  io.entity_status,
  io.campaign_id,
  c.displayName AS campaign_name,
  io.advertiser_id,
  io.advertiser_id AS account_id,
  COALESCE(adv.displayName, io.advertiser_id) AS account_name,
  CASE 
    WHEN sett.gtg_status = 'READY' THEN '🟢 READY'
    WHEN sett.gtg_status = 'NEEDS_TAG_UPGRADE' THEN '🔴 NEEDS_TAG_UPGRADE'
    ELSE '⚪ NOT_CONFIGURED'
  END AS gtg_status,
  COALESCE(sett.web_tag_type, 'WEB_TAG_TYPE_NONE') AS web_tag_type,
  COALESCE(s.partner_id, '__PARTNER_ID__') AS partner_id,
  COALESCE(
    s.currency_code, 
    NULLIF(sett.currency_code, ''), 
    NULLIF(adv.currency_code, ''), 
    ac.currency_code
  ) AS currency_code,
  io.pacing_type,
  io.pacing_period,
  io.daily_max_amount,
  io.budget_unit,
  io.budget_amount,
  io.start_date,
  io.end_date,
  COALESCE(ft.cumulative_spend, 0) AS cumulative_spend,
  COALESCE(ft.cumulative_spend_usd, 0) AS cumulative_spend_usd,
  
  -- Flight Calculations
  DATE_DIFF(io.end_date, io.start_date, DAY) AS total_flight_days,
  CASE 
    WHEN CURRENT_DATE() < io.start_date THEN 0
    WHEN CURRENT_DATE() > io.end_date THEN DATE_DIFF(io.end_date, io.start_date, DAY)
    ELSE DATE_DIFF(CURRENT_DATE(), io.start_date, DAY)
  END AS elapsed_flight_days,
  GREATEST(0, DATE_DIFF(io.end_date, CURRENT_DATE(), DAY)) AS remaining_flight_days,
  CASE 
    WHEN CURRENT_DATE() < io.start_date THEN 0.0
    WHEN CURRENT_DATE() > io.end_date THEN 100.0
    ELSE SAFE_DIVIDE(DATE_DIFF(CURRENT_DATE(), io.start_date, DAY), NULLIF(DATE_DIFF(io.end_date, io.start_date, DAY), 0)) * 100
  END AS flight_elapsed_pct,
  SAFE_DIVIDE(COALESCE(ft.cumulative_spend, 0), NULLIF(io.budget_amount, 0)) * 100 AS budget_spent_pct,
  
  -- Pacing Index % = (Budget Spent % / Flight Elapsed %)
  CASE 
    WHEN CURRENT_DATE() < io.start_date THEN 0.0
    WHEN CURRENT_DATE() > io.end_date THEN SAFE_DIVIDE(COALESCE(ft.cumulative_spend, 0), NULLIF(io.budget_amount, 0)) * 100
    ELSE SAFE_DIVIDE(
      SAFE_DIVIDE(COALESCE(ft.cumulative_spend, 0), NULLIF(io.budget_amount, 0)),
      NULLIF(SAFE_DIVIDE(DATE_DIFF(CURRENT_DATE(), io.start_date, DAY), NULLIF(DATE_DIFF(io.end_date, io.start_date, DAY), 0)), 0)
    ) * 100
  END AS pacing_index_pct,
  
  -- Pacing Burn Rate & Delivery Velocity
  SAFE_DIVIDE(io.budget_amount, NULLIF(DATE_DIFF(io.end_date, io.start_date, DAY), 0)) AS target_daily_budget,
  CASE 
    WHEN CURRENT_DATE() < io.start_date THEN 0.0
    ELSE SAFE_DIVIDE(COALESCE(ft.cumulative_spend, 0), NULLIF(GREATEST(1, CASE 
      WHEN CURRENT_DATE() > io.end_date THEN DATE_DIFF(io.end_date, io.start_date, DAY)
      ELSE DATE_DIFF(CURRENT_DATE(), io.start_date, DAY)
    END), 0))
  END AS current_daily_burn_rate,
  CASE 
    WHEN io.entity_status != 'ENTITY_STATUS_ACTIVE' THEN 0.0
    WHEN CURRENT_DATE() > io.end_date THEN 0.0
    WHEN CURRENT_DATE() < io.start_date THEN SAFE_DIVIDE(io.budget_amount, NULLIF(DATE_DIFF(io.end_date, io.start_date, DAY), 0))
    ELSE SAFE_DIVIDE(GREATEST(0, io.budget_amount - COALESCE(ft.cumulative_spend, 0)), NULLIF(GREATEST(1, DATE_DIFF(io.end_date, CURRENT_DATE(), DAY)), 0))
  END AS required_daily_burn_rate,
  
  -- Projected Spend & Budget at Risk (Strictly for LIVE Active Flights currently underpacing)
  COALESCE(ft.cumulative_spend, 0) + (
    SAFE_DIVIDE(COALESCE(ft.cumulative_spend, 0), NULLIF(GREATEST(1, DATE_DIFF(CURRENT_DATE(), io.start_date, DAY)), 0)) * 
    GREATEST(0, DATE_DIFF(io.end_date, CURRENT_DATE(), DAY))
  ) AS projected_flight_spend,
  
  CASE 
    WHEN io.entity_status != 'ENTITY_STATUS_ACTIVE' THEN 0
    WHEN io.budget_unit = 'BUDGET_UNIT_IMPRESSIONS' THEN 0
    WHEN CURRENT_DATE() < io.start_date THEN 0
    WHEN CURRENT_DATE() > io.end_date THEN 0  -- Past completed flights are closed, not at risk
    WHEN SAFE_DIVIDE(
      SAFE_DIVIDE(COALESCE(ft.cumulative_spend, 0), NULLIF(io.budget_amount, 0)),
      NULLIF(SAFE_DIVIDE(DATE_DIFF(CURRENT_DATE(), io.start_date, DAY), NULLIF(DATE_DIFF(io.end_date, io.start_date, DAY), 0)), 0)
    ) < 0.85 THEN GREATEST(0, io.budget_amount - (
      COALESCE(ft.cumulative_spend, 0) + (
        SAFE_DIVIDE(COALESCE(ft.cumulative_spend, 0), NULLIF(GREATEST(1, DATE_DIFF(CURRENT_DATE(), io.start_date, DAY)), 0)) * 
        GREATEST(0, DATE_DIFF(io.end_date, CURRENT_DATE(), DAY))
      )
    ))
    ELSE 0
  END AS budget_at_risk,

  CASE 
    WHEN io.entity_status != 'ENTITY_STATUS_ACTIVE' THEN 0
    WHEN io.budget_unit = 'BUDGET_UNIT_IMPRESSIONS' THEN 0
    WHEN CURRENT_DATE() < io.start_date THEN 0
    WHEN CURRENT_DATE() > io.end_date THEN 0
    WHEN SAFE_DIVIDE(
      SAFE_DIVIDE(COALESCE(ft.cumulative_spend, 0), NULLIF(io.budget_amount, 0)),
      NULLIF(SAFE_DIVIDE(DATE_DIFF(CURRENT_DATE(), io.start_date, DAY), NULLIF(DATE_DIFF(io.end_date, io.start_date, DAY), 0)), 0)
    ) < 0.85 THEN GREATEST(0, io.budget_amount - (
      COALESCE(ft.cumulative_spend, 0) + (
        SAFE_DIVIDE(COALESCE(ft.cumulative_spend, 0), NULLIF(GREATEST(1, DATE_DIFF(CURRENT_DATE(), io.start_date, DAY)), 0)) * 
        GREATEST(0, DATE_DIFF(io.end_date, CURRENT_DATE(), DAY))
      )
    )) * COALESCE(NULLIF(SAFE_DIVIDE(NULLIF(ft.cumulative_spend_usd, 0), NULLIF(ft.cumulative_spend, 0)), 0), NULLIF(ac.fx_rate_to_usd, 0), IF(COALESCE(s.currency_code, sett.currency_code, adv.currency_code) = 'USD', 1.0, NULL))
    ELSE 0
  END AS budget_at_risk_usd,

  -- Pacing Alert Status (with visual indicator markers matching UI legends)
  CASE 
    WHEN io.entity_status != 'ENTITY_STATUS_ACTIVE' THEN '⚪ PAUSED'
    WHEN io.budget_amount IS NULL OR io.budget_amount = 0 THEN '⚪ NO_BUDGET_SET'
    WHEN CURRENT_DATE() < io.start_date THEN '⚪ UPCOMING'
    WHEN CURRENT_DATE() > io.end_date AND COALESCE(ft.cumulative_spend, 0) < io.budget_amount THEN '🟡 UNDERSPENT_FINISHED'
    WHEN CURRENT_DATE() > io.end_date THEN '⚪ COMPLETED'
    WHEN COALESCE(ft.cumulative_spend, 0) >= io.budget_amount THEN '🔴 BUDGET_EXHAUSTED'
    WHEN SAFE_DIVIDE(
      SAFE_DIVIDE(COALESCE(ft.cumulative_spend, 0), NULLIF(io.budget_amount, 0)),
      NULLIF(SAFE_DIVIDE(DATE_DIFF(CURRENT_DATE(), io.start_date, DAY), NULLIF(DATE_DIFF(io.end_date, io.start_date, DAY), 0)), 0)
    ) < 0.85 THEN '🟡 UNDERPACING'
    WHEN SAFE_DIVIDE(
      SAFE_DIVIDE(COALESCE(ft.cumulative_spend, 0), NULLIF(io.budget_amount, 0)),
      NULLIF(SAFE_DIVIDE(DATE_DIFF(CURRENT_DATE(), io.start_date, DAY), NULLIF(DATE_DIFF(io.end_date, io.start_date, DAY), 0)), 0)
    ) > 1.15 THEN '🔴 OVERPACING'
    ELSE '🟢 ON_TRACK'
  END AS pacing_status,

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
FROM latest_ios io
LEFT JOIN io_flight_totals ft
  ON io.insertion_order_id = ft.insertion_order_id
LEFT JOIN io_stats s
  ON io.insertion_order_id = s.insertion_order_id
LEFT JOIN latest_campaigns c
  ON io.campaign_id = c.campaignId
LEFT JOIN latest_advertisers adv
  ON io.advertiser_id = adv.advertiserId
LEFT JOIN latest_settings sett
  ON io.advertiser_id = sett.advertiserId
LEFT JOIN advertiser_currencies ac
  ON io.advertiser_id = ac.advertiser_id;
