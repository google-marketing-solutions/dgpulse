CREATE OR REPLACE TABLE `__PROJECT_ID__.__DATASET_ID__.final_assets_performance` AS
WITH creative_stats AS (
  SELECT 
    COALESCE(Report_Day, CURRENT_DATE()) AS date,
    CAST(Creative_Id AS STRING) AS creative_id,
    CAST(Advertiser_Id AS STRING) AS advertiser_id,
    CAST(Partner_Id AS STRING) AS partner_id,
    ANY_VALUE(Device_Type) AS device_type,
    ANY_VALUE(Inventory_Source) AS inventory_source,
    ANY_VALUE(Advertiser_Currency) AS currency_code,
    SUM(Impressions) AS impressions,
    SUM(Clicks) AS clicks,
    SUM(Revenue) AS cost,
    SUM(COALESCE(Revenue_USD, Revenue)) AS cost_usd,
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
  FROM `__PROJECT_ID__.__DATASET_ID__.dbm_performance`
  WHERE Creative_Id IS NOT NULL AND Creative_Id > 0
  GROUP BY 1, 2, 3, 4
),
latest_creatives AS (
  SELECT 
    creativeId,
    MAX(NULLIF(advertiserId, '')) AS advertiserId,
    MAX(NULLIF(displayName, '')) AS displayName,
    MAX(NULLIF(creativeType, '')) AS creativeType,
    MAX(NULLIF(dimensions, '')) AS dimensions,
    MAX(NULLIF(imageUrl, '')) AS imageUrl,
    MAX(NULLIF(hostingSource, '')) AS hostingSource,
    MAX(NULLIF(entityStatus, '')) AS entityStatus
  FROM `__PROJECT_ID__.__DATASET_ID__.creatives`
  GROUP BY creativeId
),
latest_advertisers AS (
  SELECT 
    advertiserId,
    MAX(NULLIF(displayName, '')) AS displayName,
    MAX(NULLIF(currencyCode, '')) AS currency_code
  FROM `__PROJECT_ID__.__DATASET_ID__.advertisers`
  GROUP BY advertiserId
),
advertiser_currencies AS (
  SELECT 
    CAST(Advertiser_Id AS STRING) AS advertiser_id,
    MAX(NULLIF(Advertiser_Currency, '')) AS currency_code,
    SAFE_DIVIDE(SUM(COALESCE(Revenue_USD, Revenue)), NULLIF(SUM(Revenue), 0)) AS fx_rate_to_usd
  FROM `__PROJECT_ID__.__DATASET_ID__.dbm_performance`
  WHERE Advertiser_Currency IS NOT NULL
  GROUP BY 1
)
SELECT 
  COALESCE(cs.date, CURRENT_DATE()) AS date,
  c.creativeId AS asset_id,
  c.displayName AS asset_name,
  c.creativeType AS asset_type,
  COALESCE(c.dimensions, 'RESPONSIVE/NATIVE') AS creative_dimensions,
  CASE 
    WHEN c.imageUrl IS NOT NULL AND c.imageUrl != '' THEN c.imageUrl
    WHEN c.creativeType LIKE '%VIDEO%' THEN 'https://www.gstatic.com/images/branding/product/1x/youtube_64dp.png'
    WHEN c.creativeType LIKE '%AUDIO%' THEN 'https://www.gstatic.com/images/branding/product/1x/google_podcasts_64dp.png'
    WHEN c.creativeType = 'CREATIVE_TYPE_STANDARD' THEN 'https://www.gstatic.com/images/branding/product/1x/google_display_network_64dp.png'
    ELSE 'https://www.gstatic.com/images/branding/product/1x/generic_ad_64dp.png'
  END AS image_url,
  c.hostingSource AS hosting_source,
  c.entityStatus AS entity_status,
  cs.device_type,
  cs.inventory_source,
  c.advertiserId AS advertiser_id,
  c.advertiserId AS account_id,
  COALESCE(adv.displayName, c.advertiserId) AS account_name,
  COALESCE(
    cs.currency_code, 
    NULLIF(adv.currency_code, ''), 
    ac.currency_code
  ) AS currency_code,
  COALESCE(cs.partner_id, '__PARTNER_ID__') AS partner_id,

  -- Delivery & Cost
  COALESCE(cs.impressions, 0) AS impressions,
  COALESCE(cs.clicks, 0) AS clicks,
  COALESCE(cs.cost, 0) AS cost,
  COALESCE(cs.cost_usd, 0) AS cost_usd,
  SAFE_DIVIDE(COALESCE(cs.clicks, 0), NULLIF(COALESCE(cs.impressions, 0), 0)) AS ctr,
  SAFE_DIVIDE(COALESCE(cs.cost, 0), NULLIF(COALESCE(cs.clicks, 0), 0)) AS cpc,
  SAFE_DIVIDE(COALESCE(cs.cost_usd, 0), NULLIF(COALESCE(cs.clicks, 0), 0)) AS cpc_usd,
  SAFE_DIVIDE(COALESCE(cs.cost, 0) * 1000, NULLIF(COALESCE(cs.impressions, 0), 0)) AS cpm,
  SAFE_DIVIDE(COALESCE(cs.cost_usd, 0) * 1000, NULLIF(COALESCE(cs.impressions, 0), 0)) AS cpm_usd,

  -- Media Quality & Viewability
  COALESCE(cs.active_view_viewable_impressions, 0) AS active_view_viewable_impressions,
  COALESCE(cs.active_view_measurable_impressions, 0) AS active_view_measurable_impressions,
  COALESCE(cs.active_view_eligible_impressions, 0) AS active_view_eligible_impressions,
  SAFE_DIVIDE(COALESCE(cs.active_view_viewable_impressions, 0), NULLIF(COALESCE(cs.active_view_measurable_impressions, 0), 0)) AS viewability_rate,
  SAFE_DIVIDE(COALESCE(cs.active_view_measurable_impressions, 0), NULLIF(COALESCE(cs.active_view_eligible_impressions, 0), 0)) AS measurable_rate,

  -- Video & YouTube Delivery
  COALESCE(cs.trueview_views, 0) AS trueview_views,
  SAFE_DIVIDE(COALESCE(cs.trueview_views, 0), NULLIF(COALESCE(cs.impressions, 0), 0)) AS vtr,
  COALESCE(cs.video_plays, 0) AS video_plays,
  COALESCE(cs.video_first_quartile_completes, 0) AS video_first_quartile_completes,
  COALESCE(cs.video_midpoints, 0) AS video_midpoints,
  COALESCE(cs.video_third_quartile_completes, 0) AS video_third_quartile_completes,
  COALESCE(cs.video_completions, 0) AS video_completions,
  SAFE_DIVIDE(COALESCE(cs.video_completions, 0), NULLIF(COALESCE(cs.video_plays, 0), 0)) AS video_completion_rate,

  -- Attribution Breakdown
  COALESCE(cs.conversions, 0) AS conversions,
  COALESCE(cs.post_click_conversions, 0) AS post_click_conversions,
  COALESCE(cs.post_view_conversions, 0) AS post_view_conversions,
  COALESCE(cs.post_click_revenue, 0) AS post_click_revenue,
  COALESCE(cs.post_view_revenue, 0) AS post_view_revenue,
  SAFE_DIVIDE(COALESCE(cs.post_click_conversions, 0), NULLIF(COALESCE(cs.clicks, 0), 0)) AS post_click_conv_rate
FROM latest_creatives c
LEFT JOIN creative_stats cs
  ON c.creativeId = cs.creative_id
LEFT JOIN latest_advertisers adv
  ON c.advertiserId = adv.advertiserId
LEFT JOIN advertiser_currencies ac
  ON c.advertiserId = ac.advertiser_id;
