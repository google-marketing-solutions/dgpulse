CREATE OR REPLACE TABLE `__PROJECT_ID__.__DATASET_ID__.final_assets_performance` AS
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
        OR (Insertion_Order LIKE '%DEMANDGEN%' OR Insertion_Order LIKE '%DGEN%')
      )
  )
  WHERE row_num = 1
),
creative_stats AS (
  SELECT 
    COALESCE(Report_Day, CURRENT_DATE()) AS date,
    CAST(Creative_Id AS STRING) AS creative_id,
    CAST(Media_Plan_Id AS STRING) AS campaign_id,
    CAST(Advertiser_Id AS STRING) AS advertiser_id,
    CAST(Partner_Id AS STRING) AS partner_id,
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
    SUM(COALESCE(CM_Post_View_Revenue, 0)) AS post_view_revenue
  FROM deduped_dbm
  WHERE Creative_Id IS NOT NULL AND Creative_Id > 0
  GROUP BY 1, 2, 3, 4, 5
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
latest_campaigns AS (
  SELECT 
    campaignId,
    MAX(NULLIF(displayName, '')) AS displayName
  FROM `__PROJECT_ID__.__DATASET_ID__.campaigns`
  GROUP BY campaignId
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
    MAX(NULLIF(displayName, '')) AS advertiser_name
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
  COALESCE(cs.date, CURRENT_DATE()) AS date,
  c.creativeId AS asset_id,
  c.displayName AS asset_name,
  
  -- Formatted Asset Type matching Google Ads (SQUARE IMAGE, HORIZONTAL IMAGE, VERTICAL IMAGE, VERTICAL VIDEO, HORIZONTAL VIDEO, SQUARE VIDEO)
  CASE 
    WHEN UPPER(c.creativeType) LIKE '%VIDEO%' OR UPPER(c.displayName) LIKE '%VIDEO%' OR UPPER(c.dimensions) LIKE '%VIDEO%' THEN
      CASE 
        WHEN (SAFE_CAST(SPLIT(c.dimensions, 'x')[SAFE_OFFSET(1)] AS INT64) > SAFE_CAST(SPLIT(c.dimensions, 'x')[SAFE_OFFSET(0)] AS INT64) * 1.15)
          OR c.dimensions LIKE '%1080x1920%' OR c.dimensions LIKE '%720x1280%' OR c.dimensions LIKE '%9:16%' OR UPPER(c.displayName) LIKE '%VERTICAL%' OR UPPER(c.displayName) LIKE '%SHORTS%' THEN 'VERTICAL VIDEO'
        WHEN (SAFE_CAST(SPLIT(c.dimensions, 'x')[SAFE_OFFSET(0)] AS INT64) = SAFE_CAST(SPLIT(c.dimensions, 'x')[SAFE_OFFSET(1)] AS INT64) AND SAFE_CAST(SPLIT(c.dimensions, 'x')[SAFE_OFFSET(0)] AS INT64) > 0)
          OR c.dimensions LIKE '%1080x1080%' OR c.dimensions LIKE '%1:1%' OR UPPER(c.displayName) LIKE '%SQUARE%' THEN 'SQUARE VIDEO'
        ELSE 'HORIZONTAL VIDEO'
      END
    ELSE
      CASE 
        WHEN (SAFE_CAST(SPLIT(c.dimensions, 'x')[SAFE_OFFSET(1)] AS INT64) > SAFE_CAST(SPLIT(c.dimensions, 'x')[SAFE_OFFSET(0)] AS INT64) * 1.15)
          OR c.dimensions LIKE '%1080x1920%' OR c.dimensions LIKE '%1200x1500%' OR c.dimensions LIKE '%4:5%' OR c.dimensions LIKE '%9:16%' OR c.dimensions LIKE '%300x600%' OR c.dimensions LIKE '%160x600%' THEN 'VERTICAL IMAGE'
        WHEN (SAFE_CAST(SPLIT(c.dimensions, 'x')[SAFE_OFFSET(0)] AS INT64) = SAFE_CAST(SPLIT(c.dimensions, 'x')[SAFE_OFFSET(1)] AS INT64) AND SAFE_CAST(SPLIT(c.dimensions, 'x')[SAFE_OFFSET(0)] AS INT64) > 0)
          OR c.dimensions LIKE '%1080x1080%' OR c.dimensions LIKE '%300x300%' OR c.dimensions LIKE '%1:1%' OR UPPER(c.displayName) LIKE '%SQUARE%' THEN 'SQUARE IMAGE'
        ELSE 'HORIZONTAL IMAGE'
      END
  END AS asset_type,

  COALESCE(c.dimensions, 'RESPONSIVE/NATIVE') AS creative_dimensions,
  CASE 
    WHEN c.imageUrl IS NOT NULL AND c.imageUrl != '' AND c.imageUrl NOT LIKE '%google_display_network%' THEN c.imageUrl
    WHEN UPPER(c.creativeType) LIKE '%VIDEO%' OR UPPER(c.displayName) LIKE '%VIDEO%' THEN 'https://www.gstatic.com/images/branding/product/2x/youtube_64dp.png'
    ELSE 'https://www.gstatic.com/images/branding/googleg/1x/googleg_standard_color_128dp.png'
  END AS image_url,
  c.hostingSource AS hosting_source,
  c.entityStatus AS entity_status,
  cs.device_type,
  cs.inventory_source,
  c.advertiserId AS advertiser_id,
  c.advertiserId AS account_id,
  COALESCE(sett.advertiser_name, adv.displayName, c.advertiserId) AS account_name,
  COALESCE(cs.campaign_id, 'N/A') AS campaign_id,
  COALESCE(cmp.displayName, cs.campaign_id, 'N/A') AS campaign_name,
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
FROM creative_stats cs
JOIN latest_creatives c
  ON cs.creative_id = c.creativeId
LEFT JOIN latest_campaigns cmp
  ON cs.campaign_id = cmp.campaignId
LEFT JOIN latest_advertisers adv
  ON c.advertiserId = adv.advertiserId
LEFT JOIN latest_settings sett
  ON c.advertiserId = sett.advertiserId
LEFT JOIN advertiser_currencies ac
  ON c.advertiserId = ac.advertiser_id;
