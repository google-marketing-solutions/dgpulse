CREATE OR REPLACE TABLE `__PROJECT_ID__.__DATASET_ID__.final_insertion_orders_performance` AS
WITH io_stats AS (
  SELECT 
    CAST(Insertion_Order_Id AS STRING) AS insertion_order_id,
    CAST(Advertiser_Id AS STRING) AS advertiser_id,
    CAST(Partner_Id AS STRING) AS partner_id,
    ANY_VALUE(Advertiser_Currency) AS currency_code,
    SUM(Impressions) AS impressions,
    SUM(Clicks) AS clicks,
    SUM(Revenue) AS cost,
    SUM(Total_Conversions) AS conversions,
    SUM(COALESCE(Active_View_Viewable_Impressions, 0)) AS active_view_viewable_impressions,
    SUM(COALESCE(Active_View_Measurable_Impressions, 0)) AS active_view_measurable_impressions,
    SUM(COALESCE(TrueView_Views, 0)) AS trueview_views
  FROM `__PROJECT_ID__.__DATASET_ID__.dbm_performance`
  WHERE Insertion_Order_Id IS NOT NULL AND Insertion_Order_Id > 0
  GROUP BY 1, 2, 3
),
latest_ios AS (
  SELECT 
    insertionOrderId AS insertion_order_id,
    ANY_VALUE(displayName) AS insertion_order_name,
    ANY_VALUE(advertiserId) AS advertiser_id,
    ANY_VALUE(campaignId) AS campaign_id,
    ANY_VALUE(entityStatus) AS entity_status,
    ANY_VALUE(pacingType) AS pacing_type,
    ANY_VALUE(pacingPeriod) AS pacing_period,
    ANY_VALUE(dailyMaxAmount) AS daily_max_amount,
    ANY_VALUE(budgetUnit) AS budget_unit,
    ANY_VALUE(budgetAmount) AS budget_amount,
    ANY_VALUE(startDate) AS start_date,
    ANY_VALUE(endDate) AS end_date
  FROM `__PROJECT_ID__.__DATASET_ID__.insertion_orders`
  GROUP BY 1
),
latest_advertisers AS (
  SELECT 
    advertiserId,
    ANY_VALUE(displayName) AS displayName
  FROM `__PROJECT_ID__.__DATASET_ID__.advertisers`
  GROUP BY advertiserId
)
SELECT 
  CURRENT_DATE() AS date,
  io.insertion_order_id,
  io.insertion_order_name,
  io.entity_status,
  io.campaign_id,
  c.displayName AS campaign_name,
  io.advertiser_id,
  io.advertiser_id AS account_id,
  COALESCE(adv.displayName, io.advertiser_id) AS account_name,
  COALESCE(s.partner_id, '__PARTNER_ID__') AS partner_id,
  COALESCE(s.currency_code, 'USD') AS currency_code,
  io.pacing_type,
  io.pacing_period,
  io.daily_max_amount,
  io.budget_unit,
  io.budget_amount,
  io.start_date,
  io.end_date,
  COALESCE(s.cost, 0) AS cumulative_spend,
  
  -- Flight Calculations
  DATE_DIFF(io.end_date, io.start_date, DAY) AS total_flight_days,
  DATE_DIFF(CURRENT_DATE(), io.start_date, DAY) AS elapsed_flight_days,
  SAFE_DIVIDE(DATE_DIFF(CURRENT_DATE(), io.start_date, DAY), NULLIF(DATE_DIFF(io.end_date, io.start_date, DAY), 0)) AS flight_elapsed_pct,
  SAFE_DIVIDE(COALESCE(s.cost, 0), NULLIF(io.budget_amount, 0)) AS budget_spent_pct,
  
  -- Pacing Index % = (Budget Spent % / Flight Elapsed %)
  SAFE_DIVIDE(
    SAFE_DIVIDE(COALESCE(s.cost, 0), NULLIF(io.budget_amount, 0)),
    NULLIF(SAFE_DIVIDE(DATE_DIFF(CURRENT_DATE(), io.start_date, DAY), NULLIF(DATE_DIFF(io.end_date, io.start_date, DAY), 0)), 0)
  ) * 100 AS pacing_index_pct,
  
  -- Pacing Alert Status
  CASE 
    WHEN io.entity_status != 'ENTITY_STATUS_ACTIVE' THEN 'PAUSED'
    WHEN io.budget_amount IS NULL OR io.budget_amount = 0 THEN 'NO_BUDGET_SET'
    WHEN CURRENT_DATE() < io.start_date THEN 'UPCOMING'
    WHEN CURRENT_DATE() > io.end_date AND COALESCE(s.cost, 0) < io.budget_amount THEN 'UNDERSPENT_FINISHED'
    WHEN CURRENT_DATE() > io.end_date THEN 'COMPLETED'
    WHEN COALESCE(s.cost, 0) >= io.budget_amount THEN 'BUDGET_EXHAUSTED'
    WHEN SAFE_DIVIDE(
      SAFE_DIVIDE(COALESCE(s.cost, 0), NULLIF(io.budget_amount, 0)),
      NULLIF(SAFE_DIVIDE(DATE_DIFF(CURRENT_DATE(), io.start_date, DAY), NULLIF(DATE_DIFF(io.end_date, io.start_date, DAY), 0)), 0)
    ) < 0.85 THEN 'UNDERPACING'
    WHEN SAFE_DIVIDE(
      SAFE_DIVIDE(COALESCE(s.cost, 0), NULLIF(io.budget_amount, 0)),
      NULLIF(SAFE_DIVIDE(DATE_DIFF(CURRENT_DATE(), io.start_date, DAY), NULLIF(DATE_DIFF(io.end_date, io.start_date, DAY), 0)), 0)
    ) > 1.15 THEN 'OVERPACING'
    ELSE 'ON_TRACK'
  END AS pacing_status,

  -- Performance Metrics
  COALESCE(s.impressions, 0) AS impressions,
  COALESCE(s.clicks, 0) AS clicks,
  COALESCE(s.conversions, 0) AS conversions,
  COALESCE(s.active_view_viewable_impressions, 0) AS active_view_viewable_impressions,
  COALESCE(s.active_view_measurable_impressions, 0) AS active_view_measurable_impressions,
  SAFE_DIVIDE(COALESCE(s.active_view_viewable_impressions, 0), NULLIF(COALESCE(s.active_view_measurable_impressions, 0), 0)) AS viewability_rate,
  COALESCE(s.trueview_views, 0) AS trueview_views,
  SAFE_DIVIDE(COALESCE(s.trueview_views, 0), NULLIF(COALESCE(s.impressions, 0), 0)) AS vtr,
  SAFE_DIVIDE(COALESCE(s.clicks, 0), NULLIF(COALESCE(s.impressions, 0), 0)) AS ctr,
  SAFE_DIVIDE(COALESCE(s.cost, 0), NULLIF(COALESCE(s.clicks, 0), 0)) AS cpc,
  SAFE_DIVIDE(COALESCE(s.cost, 0) * 1000, NULLIF(COALESCE(s.impressions, 0), 0)) AS cpm
FROM latest_ios io
LEFT JOIN `__PROJECT_ID__.__DATASET_ID__.campaigns` c
  ON io.campaign_id = c.campaignId
LEFT JOIN io_stats s
  ON io.insertion_order_id = s.insertion_order_id
LEFT JOIN latest_advertisers adv
  ON io.advertiser_id = adv.advertiserId;
