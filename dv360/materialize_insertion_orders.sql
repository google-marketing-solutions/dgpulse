CREATE OR REPLACE TABLE `__PROJECT_ID__.__DATASET_ID__.final_insertion_orders_performance` AS
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
        Insertion_Order_Id IN (SELECT DISTINCT CAST(insertionOrderId AS INT64) FROM demand_gen_line_items WHERE insertionOrderId IS NOT NULL)
        OR (Line_Item_Id IS NOT NULL AND Line_Item_Id IN (SELECT DISTINCT CAST(lineItemId AS INT64) FROM demand_gen_line_items))
      )
  )
  WHERE row_num = 1
),

-- ---------------------------------------------------------------------------
-- Budget pacing inputs.
--
-- Pacing spend MUST come from dbm_io_spend_daily (the ALL_TIME DBM report) and
-- NOT from dbm_performance. dbm_performance is capped at LAST_90_DAYS, so using
-- it here silently truncates spend on any flight longer than 90 days and makes
-- those insertion orders appear massively underpaced against a budget that
-- covers the whole flight.
-- ---------------------------------------------------------------------------
io_spend_daily AS (
  SELECT
    CAST(Insertion_Order_Id AS STRING) AS insertion_order_id,
    Report_Day,
    MAX(NULLIF(Advertiser_Currency, '')) AS currency_code,
    SUM(Revenue) AS revenue,
    SUM(COALESCE(NULLIF(Revenue_USD, 0), Revenue)) AS revenue_usd,
    SUM(Impressions) AS impressions
  FROM `__PROJECT_ID__.__DATASET_ID__.dbm_io_spend_daily`
  WHERE Insertion_Order_Id IS NOT NULL AND Insertion_Order_Id > 0
    AND Report_Day IS NOT NULL
  GROUP BY 1, 2
),
flight_spend AS (
  SELECT
    insertion_order_id,
    SUM(revenue) AS flight_spend,
    SUM(revenue_usd) AS flight_spend_usd,
    SUM(impressions) AS flight_impressions,
    MAX(currency_code) AS currency_code,
    SAFE_DIVIDE(SUM(revenue_usd), NULLIF(SUM(revenue), 0)) AS fx_rate_to_usd
  FROM io_spend_daily
  GROUP BY 1
),
budget_segments AS (
  SELECT DISTINCT
    insertionOrderId AS insertion_order_id,
    description,
    budget_amount,
    start_date,
    end_date
  FROM `__PROJECT_ID__.__DATASET_ID__.io_budget_segments`
  WHERE start_date IS NOT NULL AND end_date IS NOT NULL
),
-- DV360 paces an insertion order against the budget segment that is currently
-- in flight. Rank segments so that the in-flight one wins; if the flight is
-- over, fall back to the most recently completed segment; if it has not begun,
-- fall back to the one due to start soonest.
ranked_segments AS (
  SELECT
    *,
    ROW_NUMBER() OVER (
      PARTITION BY insertion_order_id
      ORDER BY
        CASE
          WHEN CURRENT_DATE() BETWEEN start_date AND end_date THEN 0
          WHEN end_date < CURRENT_DATE() THEN 1
          ELSE 2
        END ASC,
        CASE
          WHEN CURRENT_DATE() BETWEEN start_date AND end_date THEN 0
          WHEN end_date < CURRENT_DATE() THEN DATE_DIFF(CURRENT_DATE(), end_date, DAY)
          ELSE DATE_DIFF(start_date, CURRENT_DATE(), DAY)
        END ASC,
        start_date DESC
    ) AS seg_rank
  FROM budget_segments
),
active_segment AS (
  SELECT * EXCEPT(seg_rank) FROM ranked_segments WHERE seg_rank = 1
),
segment_spend AS (
  SELECT
    s.insertion_order_id,
    SUM(d.revenue) AS segment_spend,
    SUM(d.revenue_usd) AS segment_spend_usd,
    SUM(d.impressions) AS segment_impressions
  FROM active_segment s
  JOIN io_spend_daily d
    ON d.insertion_order_id = s.insertion_order_id
   AND d.Report_Day BETWEEN s.start_date AND s.end_date
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
    SUM(COALESCE(CM_Post_View_Revenue, 0)) AS post_view_revenue
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
    MIN(startDate) AS start_date,
    MAX(endDate) AS end_date
  FROM `__PROJECT_ID__.__DATASET_ID__.insertion_orders`
  WHERE insertionOrderId IN (SELECT DISTINCT insertionOrderId FROM demand_gen_line_items WHERE insertionOrderId IS NOT NULL)
  GROUP BY 1
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
),

-- Resolves the basis for every pacing calculation below. When budget segments
-- are available the active segment is used; otherwise this degrades gracefully
-- to the lifetime flight, which is still correct now that spend is ALL_TIME.
pacing_basis AS (
  SELECT
    io.insertion_order_id,
    COALESCE(seg.budget_amount, io.budget_amount) AS pacing_budget,
    COALESCE(seg.start_date, io.start_date) AS pacing_start_date,
    COALESCE(seg.end_date, io.end_date) AS pacing_end_date,
    seg.description AS budget_segment_description,
    seg.insertion_order_id IS NOT NULL AS has_budget_segment,
    COALESCE(
      IF(seg.insertion_order_id IS NOT NULL, ss.segment_spend, fs.flight_spend),
      0
    ) AS pacing_spend,
    COALESCE(
      IF(seg.insertion_order_id IS NOT NULL, ss.segment_spend_usd, fs.flight_spend_usd),
      0
    ) AS pacing_spend_usd
  FROM latest_ios io
  LEFT JOIN active_segment seg ON io.insertion_order_id = seg.insertion_order_id
  LEFT JOIN segment_spend ss ON io.insertion_order_id = ss.insertion_order_id
  LEFT JOIN flight_spend fs ON io.insertion_order_id = fs.insertion_order_id
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
  COALESCE(s.partner_id, adv.partnerId, '__PARTNER_ID__') AS partner_id,
  COALESCE(
    s.currency_code, 
    NULLIF(sett.currency_code, ''), 
    NULLIF(adv.currency_code, ''), 
    fs.currency_code,
    ac.currency_code
  ) AS currency_code,
  io.pacing_type,
  io.pacing_period,
  io.daily_max_amount,
  io.budget_unit,

  -- Pacing is evaluated against the budget segment currently in flight, which
  -- is how DV360 itself paces. Every segment_* column below describes that
  -- segment; the whole-flight equivalents are exposed as flight_* beneath them.
  pb.budget_segment_description,
  pb.has_budget_segment,
  pb.pacing_budget AS segment_budget_amount,
  pb.pacing_start_date AS segment_start_date,
  pb.pacing_end_date AS segment_end_date,
  pb.pacing_spend AS segment_cumulative_spend,
  pb.pacing_spend_usd AS segment_cumulative_spend_usd,

  -- Whole-flight totals, retained for reference and reconciliation against the
  -- lifetime budget shown at the bottom of the DV360 budget segment table.
  io.budget_amount AS flight_budget_amount,
  io.start_date AS flight_start_date,
  io.end_date AS flight_end_date,
  COALESCE(fs.flight_spend, 0) AS flight_cumulative_spend,
  COALESCE(fs.flight_spend_usd, 0) AS flight_cumulative_spend_usd,
  SAFE_DIVIDE(COALESCE(fs.flight_spend, 0), NULLIF(io.budget_amount, 0)) * 100 AS flight_budget_spent_pct,

  -- Segment Calculations. These describe the active budget segment, not the
  -- whole flight; the flight_* columns above are the lifetime equivalents.
  -- DATE_DIFF is exclusive of the end day, so +1 counts the segment inclusively
  -- (a Jul 1 - Sep 30 segment is 92 days, not 91).
  DATE_DIFF(pb.pacing_end_date, pb.pacing_start_date, DAY) + 1 AS total_segment_days,
  CASE 
    WHEN CURRENT_DATE() < pb.pacing_start_date THEN 0
    WHEN CURRENT_DATE() > pb.pacing_end_date THEN DATE_DIFF(pb.pacing_end_date, pb.pacing_start_date, DAY) + 1
    ELSE DATE_DIFF(CURRENT_DATE(), pb.pacing_start_date, DAY) + 1
  END AS elapsed_segment_days,
  GREATEST(0, DATE_DIFF(pb.pacing_end_date, CURRENT_DATE(), DAY)) AS remaining_segment_days,
  CASE 
    WHEN CURRENT_DATE() < pb.pacing_start_date THEN 0.0
    WHEN CURRENT_DATE() > pb.pacing_end_date THEN 100.0
    ELSE SAFE_DIVIDE(DATE_DIFF(CURRENT_DATE(), pb.pacing_start_date, DAY) + 1, NULLIF(DATE_DIFF(pb.pacing_end_date, pb.pacing_start_date, DAY) + 1, 0)) * 100
  END AS segment_elapsed_pct,
  SAFE_DIVIDE(pb.pacing_spend, NULLIF(pb.pacing_budget, 0)) * 100 AS segment_budget_spent_pct,
  
  -- Pacing Index % = (Budget Spent % / Segment Elapsed %)
  CASE 
    WHEN CURRENT_DATE() < pb.pacing_start_date THEN 0.0
    WHEN CURRENT_DATE() > pb.pacing_end_date THEN SAFE_DIVIDE(pb.pacing_spend, NULLIF(pb.pacing_budget, 0)) * 100
    ELSE SAFE_DIVIDE(
      SAFE_DIVIDE(pb.pacing_spend, NULLIF(pb.pacing_budget, 0)),
      NULLIF(SAFE_DIVIDE(DATE_DIFF(CURRENT_DATE(), pb.pacing_start_date, DAY) + 1, NULLIF(DATE_DIFF(pb.pacing_end_date, pb.pacing_start_date, DAY) + 1, 0)), 0)
    ) * 100
  END AS pacing_index_pct,
  
  -- Pacing Burn Rate & Delivery Velocity
  SAFE_DIVIDE(pb.pacing_budget, NULLIF(DATE_DIFF(pb.pacing_end_date, pb.pacing_start_date, DAY) + 1, 0)) AS target_daily_budget,
  CASE 
    WHEN CURRENT_DATE() < pb.pacing_start_date THEN 0.0
    ELSE SAFE_DIVIDE(pb.pacing_spend, NULLIF(GREATEST(1, CASE 
      WHEN CURRENT_DATE() > pb.pacing_end_date THEN DATE_DIFF(pb.pacing_end_date, pb.pacing_start_date, DAY) + 1
      ELSE DATE_DIFF(CURRENT_DATE(), pb.pacing_start_date, DAY) + 1
    END), 0))
  END AS current_daily_burn_rate,
  CASE 
    WHEN io.entity_status != 'ENTITY_STATUS_ACTIVE' THEN 0.0
    WHEN CURRENT_DATE() > pb.pacing_end_date THEN 0.0
    WHEN CURRENT_DATE() < pb.pacing_start_date THEN SAFE_DIVIDE(pb.pacing_budget, NULLIF(DATE_DIFF(pb.pacing_end_date, pb.pacing_start_date, DAY) + 1, 0))
    ELSE SAFE_DIVIDE(GREATEST(0, pb.pacing_budget - pb.pacing_spend), NULLIF(GREATEST(1, DATE_DIFF(pb.pacing_end_date, CURRENT_DATE(), DAY)), 0))
  END AS required_daily_burn_rate,
  
  -- Projected Spend & Budget at Risk (strictly for live, active segments currently underpacing)
  pb.pacing_spend + (
    SAFE_DIVIDE(pb.pacing_spend, NULLIF(GREATEST(1, DATE_DIFF(CURRENT_DATE(), pb.pacing_start_date, DAY) + 1), 0)) * 
    GREATEST(0, DATE_DIFF(pb.pacing_end_date, CURRENT_DATE(), DAY))
  ) AS projected_segment_spend,
  
  CASE 
    WHEN io.entity_status != 'ENTITY_STATUS_ACTIVE' THEN 0
    WHEN io.budget_unit = 'BUDGET_UNIT_IMPRESSIONS' THEN 0
    WHEN CURRENT_DATE() < pb.pacing_start_date THEN 0
    WHEN CURRENT_DATE() > pb.pacing_end_date THEN 0  -- Past completed flights are closed, not at risk
    WHEN SAFE_DIVIDE(
      SAFE_DIVIDE(pb.pacing_spend, NULLIF(pb.pacing_budget, 0)),
      NULLIF(SAFE_DIVIDE(DATE_DIFF(CURRENT_DATE(), pb.pacing_start_date, DAY) + 1, NULLIF(DATE_DIFF(pb.pacing_end_date, pb.pacing_start_date, DAY) + 1, 0)), 0)
    ) < 0.85 THEN GREATEST(0, pb.pacing_budget - (
      pb.pacing_spend + (
        SAFE_DIVIDE(pb.pacing_spend, NULLIF(GREATEST(1, DATE_DIFF(CURRENT_DATE(), pb.pacing_start_date, DAY) + 1), 0)) * 
        GREATEST(0, DATE_DIFF(pb.pacing_end_date, CURRENT_DATE(), DAY))
      )
    ))
    ELSE 0
  END AS budget_at_risk,

  CASE 
    WHEN io.entity_status != 'ENTITY_STATUS_ACTIVE' THEN 0
    WHEN io.budget_unit = 'BUDGET_UNIT_IMPRESSIONS' THEN 0
    WHEN CURRENT_DATE() < pb.pacing_start_date THEN 0
    WHEN CURRENT_DATE() > pb.pacing_end_date THEN 0
    WHEN SAFE_DIVIDE(
      SAFE_DIVIDE(pb.pacing_spend, NULLIF(pb.pacing_budget, 0)),
      NULLIF(SAFE_DIVIDE(DATE_DIFF(CURRENT_DATE(), pb.pacing_start_date, DAY) + 1, NULLIF(DATE_DIFF(pb.pacing_end_date, pb.pacing_start_date, DAY) + 1, 0)), 0)
    ) < 0.85 THEN GREATEST(0, pb.pacing_budget - (
      pb.pacing_spend + (
        SAFE_DIVIDE(pb.pacing_spend, NULLIF(GREATEST(1, DATE_DIFF(CURRENT_DATE(), pb.pacing_start_date, DAY) + 1), 0)) * 
        GREATEST(0, DATE_DIFF(pb.pacing_end_date, CURRENT_DATE(), DAY))
      )
    )) * COALESCE(NULLIF(SAFE_DIVIDE(NULLIF(pb.pacing_spend_usd, 0), NULLIF(pb.pacing_spend, 0)), 0), NULLIF(fs.fx_rate_to_usd, 0), NULLIF(ac.fx_rate_to_usd, 0), IF(COALESCE(s.currency_code, sett.currency_code, adv.currency_code) = 'USD', 1.0, NULL))
    ELSE 0
  END AS budget_at_risk_usd,

  -- Pacing Alert Status (with visual indicator markers matching UI legends)
  CASE 
    WHEN io.entity_status != 'ENTITY_STATUS_ACTIVE' THEN '⚪ PAUSED'
    WHEN pb.pacing_budget IS NULL OR pb.pacing_budget = 0 THEN '⚪ NO_BUDGET_SET'
    WHEN CURRENT_DATE() < pb.pacing_start_date THEN '⚪ UPCOMING'
    WHEN CURRENT_DATE() > pb.pacing_end_date AND pb.pacing_spend < pb.pacing_budget THEN '🟡 UNDERSPENT_FINISHED'
    WHEN CURRENT_DATE() > pb.pacing_end_date THEN '⚪ COMPLETED'
    WHEN pb.pacing_spend >= pb.pacing_budget THEN '🔴 BUDGET_EXHAUSTED'
    WHEN SAFE_DIVIDE(
      SAFE_DIVIDE(pb.pacing_spend, NULLIF(pb.pacing_budget, 0)),
      NULLIF(SAFE_DIVIDE(DATE_DIFF(CURRENT_DATE(), pb.pacing_start_date, DAY) + 1, NULLIF(DATE_DIFF(pb.pacing_end_date, pb.pacing_start_date, DAY) + 1, 0)), 0)
    ) < 0.85 THEN '🟡 UNDERPACING'
    WHEN SAFE_DIVIDE(
      SAFE_DIVIDE(pb.pacing_spend, NULLIF(pb.pacing_budget, 0)),
      NULLIF(SAFE_DIVIDE(DATE_DIFF(CURRENT_DATE(), pb.pacing_start_date, DAY) + 1, NULLIF(DATE_DIFF(pb.pacing_end_date, pb.pacing_start_date, DAY) + 1, 0)), 0)
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
  SAFE_DIVIDE(COALESCE(s.post_click_conversions, 0), NULLIF(COALESCE(s.clicks, 0), 0)) AS post_click_conv_rate
FROM latest_ios io
LEFT JOIN pacing_basis pb
  ON io.insertion_order_id = pb.insertion_order_id
LEFT JOIN flight_spend fs
  ON io.insertion_order_id = fs.insertion_order_id
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

-- One row per insertion order, for pacing scorecards and the pacing table.
--
-- final_insertion_orders_performance carries one row per IO *per date*. Every
-- pacing column on it is an IO-level constant (they are all derived from
-- CURRENT_DATE(), not from the row's date), so a SUM in Looker multiplies each
-- IO's value by its number of date rows -- and the multiplier moves whenever
-- the date filter changes. Selecting the newest row per IO is therefore exact,
-- not an approximation, and lets scorecards SUM safely.
--
-- NOTE: the daily delivery columns (impressions, clicks, cost, ...) in this
-- view reflect the latest date only. Use the base table for performance
-- reporting; use this view for pacing.
CREATE OR REPLACE VIEW `__PROJECT_ID__.__DATASET_ID__.final_io_pacing_current` AS
SELECT *
FROM `__PROJECT_ID__.__DATASET_ID__.final_insertion_orders_performance`
QUALIFY ROW_NUMBER() OVER (PARTITION BY insertion_order_id ORDER BY date DESC) = 1;
