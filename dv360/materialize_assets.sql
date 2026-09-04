CREATE OR REPLACE TABLE `__PROJECT_ID__.__DATASET_ID__.final_assets_performance` AS
WITH demand_gen_line_items AS (
  SELECT DISTINCT 
    lineItemId, 
    insertionOrderId, 
    campaignId, 
    advertiserId,
    displayName AS line_item_name
  FROM `__PROJECT_ID__.__DATASET_ID__.line_items`
  WHERE lineItemType = 'LINE_ITEM_TYPE_DEMAND_GEN'
     OR lineItemType LIKE '%DEMAND_GEN%'
),
dg_approved_ads AS (
  SELECT 
    ad.*,
    COALESCE(NULLIF(ad.insertionOrderId, ''), NULLIF(li.insertionOrderId, '')) AS resolved_io_id,
    COALESCE(NULLIF(ad.campaignId, ''), NULLIF(li.campaignId, '')) AS resolved_campaign_id,
    li.line_item_name
  FROM `__PROJECT_ID__.__DATASET_ID__.ad_group_ads` ad
  JOIN demand_gen_line_items li 
    ON ad.lineItemId = li.lineItemId
  WHERE ad.entityStatus = 'ENTITY_STATUS_ACTIVE'
    AND ad.approvalStatus IN ('APPROVED', 'APPROVED_LIMITED')
),
unpacked_assets AS (
  -- 1. Video Assets (from Demand Gen Video Ads)
  SELECT 
    ad.adGroupAdId AS asset_id,
    ad.displayName AS asset_name,
    ad.adGroupAdId,
    ad.video_id,
    ad.lineItemId,
    ad.line_item_name,
    ad.resolved_io_id AS insertion_order_id,
    ad.resolved_campaign_id AS campaign_id,
    ad.advertiserId AS advertiser_id,
    CASE 
      WHEN ad.aspect_ratio IS NOT NULL AND ad.aspect_ratio < 1.0 THEN 'VERTICAL VIDEO'
      WHEN ad.aspect_ratio IS NOT NULL AND ad.aspect_ratio = 1.0 THEN 'SQUARE VIDEO'
      ELSE 'HORIZONTAL VIDEO'
    END AS asset_type,
    'VIDEO' AS asset_variant,
    CASE 
      WHEN ad.aspect_ratio IS NOT NULL AND ad.aspect_ratio < 1.0 THEN '9:16'
      WHEN ad.aspect_ratio IS NOT NULL AND ad.aspect_ratio = 1.0 THEN '1:1'
      ELSE '16:9'
    END AS creative_dimensions,
    CASE 
      WHEN ad.video_id IS NOT NULL AND ad.video_id != '' 
        THEN CONCAT('https://i.ytimg.com/vi/', ad.video_id, '/hqdefault.jpg')
      ELSE 'https://www.gstatic.com/images/branding/product/2x/youtube_64dp.png'
    END AS image_url,
    'YOUTUBE' AS hosting_source,
    ad.entityStatus AS entity_status,
    ad.approvalStatus AS approval_status
  FROM dg_approved_ads ad
  WHERE ad.adType = 'DEMAND_GEN_VIDEO_AD'

  UNION ALL

  -- 2. Horizontal Marketing Images (from Demand Gen Image Ads)
  SELECT 
    ad.adGroupAdId AS asset_id,
    CONCAT(ad.displayName, ' [Horizontal Image]') AS asset_name,
    ad.adGroupAdId,
    CAST(NULL AS STRING) AS video_id,
    ad.lineItemId,
    ad.line_item_name,
    ad.resolved_io_id AS insertion_order_id,
    ad.resolved_campaign_id AS campaign_id,
    ad.advertiserId AS advertiser_id,
    'HORIZONTAL IMAGE' AS asset_type,
    'HORIZONTAL' AS asset_variant,
    '1200x628' AS creative_dimensions,
    'https://www.gstatic.com/images/branding/googleg/1x/googleg_standard_color_128dp.png' AS image_url,
    'HOSTING_SOURCE_INTERNAL' AS hosting_source,
    ad.entityStatus AS entity_status,
    ad.approvalStatus AS approval_status
  FROM dg_approved_ads ad
  WHERE ad.adType = 'DEMAND_GEN_IMAGE_AD' AND COALESCE(ad.horizontal_images_count, 0) > 0

  UNION ALL

  -- 3. Square Marketing Images (from Demand Gen Image Ads)
  SELECT 
    ad.adGroupAdId AS asset_id,
    CONCAT(ad.displayName, ' [Square Image]') AS asset_name,
    ad.adGroupAdId,
    CAST(NULL AS STRING) AS video_id,
    ad.lineItemId,
    ad.line_item_name,
    ad.resolved_io_id AS insertion_order_id,
    ad.resolved_campaign_id AS campaign_id,
    ad.advertiserId AS advertiser_id,
    'SQUARE IMAGE' AS asset_type,
    'SQUARE' AS asset_variant,
    '1200x1200' AS creative_dimensions,
    'https://www.gstatic.com/images/branding/googleg/1x/googleg_standard_color_128dp.png' AS image_url,
    'HOSTING_SOURCE_INTERNAL' AS hosting_source,
    ad.entityStatus AS entity_status,
    ad.approvalStatus AS approval_status
  FROM dg_approved_ads ad
  WHERE ad.adType = 'DEMAND_GEN_IMAGE_AD' AND COALESCE(ad.square_images_count, 0) > 0

  UNION ALL

  -- 4. Vertical / Portrait Marketing Images (from Demand Gen Image Ads)
  SELECT 
    ad.adGroupAdId AS asset_id,
    CONCAT(ad.displayName, ' [Vertical Image]') AS asset_name,
    ad.adGroupAdId,
    CAST(NULL AS STRING) AS video_id,
    ad.lineItemId,
    ad.line_item_name,
    ad.resolved_io_id AS insertion_order_id,
    ad.resolved_campaign_id AS campaign_id,
    ad.advertiserId AS advertiser_id,
    'VERTICAL IMAGE' AS asset_type,
    'VERTICAL' AS asset_variant,
    '960x1200' AS creative_dimensions,
    'https://www.gstatic.com/images/branding/googleg/1x/googleg_standard_color_128dp.png' AS image_url,
    'HOSTING_SOURCE_INTERNAL' AS hosting_source,
    ad.entityStatus AS entity_status,
    ad.approvalStatus AS approval_status
  FROM dg_approved_ads ad
  WHERE ad.adType = 'DEMAND_GEN_IMAGE_AD' AND COALESCE(ad.portrait_images_count, 0) > 0
),
line_item_asset_weights AS (
  SELECT lineItemId, COUNT(*) AS asset_count
  FROM unpacked_assets
  GROUP BY lineItemId
),
line_item_stats AS (
  SELECT 
    COALESCE(Report_Day, CURRENT_DATE()) AS date,
    CAST(Line_Item_Id AS STRING) AS line_item_id,
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
  FROM `__PROJECT_ID__.__DATASET_ID__.dbm_performance`
  WHERE Line_Item_Id IS NOT NULL 
    AND Line_Item_Id IN (SELECT DISTINCT CAST(lineItemId AS INT64) FROM demand_gen_line_items)
  GROUP BY 1, 2, 3, 4, 5
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
    MAX(NULLIF(currencyCode, '')) AS currency_code,
    MAX(NULLIF(partnerId, '')) AS partnerId
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
latest_ios AS (
  SELECT 
    insertionOrderId AS insertion_order_id,
    MAX(NULLIF(displayName, '')) AS insertion_order_name
  FROM `__PROJECT_ID__.__DATASET_ID__.insertion_orders`
  GROUP BY 1
)
SELECT 
  COALESCE(lis.date, CURRENT_DATE()) AS date,
  a.asset_id,
  a.adGroupAdId AS ad_group_ad_id,
  a.video_id,
  a.asset_name,
  a.asset_type,
  a.asset_variant,
  a.creative_dimensions,
  a.image_url,
  a.hosting_source,
  a.entity_status,
  a.insertion_order_id,
  COALESCE(io.insertion_order_name, a.insertion_order_id, 'N/A') AS insertion_order_name,
  a.lineItemId AS line_item_id,
  COALESCE(a.line_item_name, 'N/A') AS line_item_name,
  lis.device_type,
  lis.inventory_source,
  a.advertiser_id,
  a.advertiser_id AS account_id,
  COALESCE(sett.advertiser_name, adv.displayName, a.advertiser_id) AS account_name,
  COALESCE(a.campaign_id, lis.campaign_id, 'N/A') AS campaign_id,
  COALESCE(cmp.displayName, a.campaign_id, lis.campaign_id, 'N/A') AS campaign_name,
  COALESCE(lis.currency_code, NULLIF(adv.currency_code, ''), 'USD') AS currency_code,
  COALESCE(lis.partner_id, adv.partnerId, '__PARTNER_ID__') AS partner_id,

  -- Precomputed Deep Links
  CASE 
    WHEN a.video_id IS NOT NULL AND a.video_id != '' 
      THEN CONCAT('https://www.youtube.com/watch?v=', a.video_id)
    ELSE CONCAT('https://displayvideo.google.com/ng_nav/p/', COALESCE(lis.partner_id, adv.partnerId, '__PARTNER_ID__'), '/a/', a.advertiser_id, '/c/', COALESCE(a.campaign_id, lis.campaign_id, '0'), '/io/', COALESCE(a.insertion_order_id, '0'), '/li/', a.lineItemId, '/adgroups')
  END AS asset_link,
  CONCAT('https://displayvideo.google.com/ng_nav/p/', COALESCE(lis.partner_id, adv.partnerId, '__PARTNER_ID__'), '/a/', a.advertiser_id, '/c/', COALESCE(a.campaign_id, lis.campaign_id, '0'), '/io/', COALESCE(a.insertion_order_id, '0'), '/li/', a.lineItemId, '/adgroups') AS dv360_url,
  CASE 
    WHEN a.video_id IS NOT NULL AND a.video_id != '' 
      THEN CONCAT('https://www.youtube.com/watch?v=', a.video_id)
    ELSE NULL 
  END AS youtube_url,

  -- Delivery & Cost (Proportionally attributed by asset weight within line item)
  COALESCE(SAFE_DIVIDE(lis.impressions, w.asset_count), 0) AS impressions,
  COALESCE(SAFE_DIVIDE(lis.clicks, w.asset_count), 0) AS clicks,
  COALESCE(SAFE_DIVIDE(lis.cost, w.asset_count), 0) AS cost,
  COALESCE(SAFE_DIVIDE(lis.cost_usd, w.asset_count), 0) AS cost_usd,
  SAFE_DIVIDE(lis.clicks, NULLIF(lis.impressions, 0)) AS ctr,
  SAFE_DIVIDE(lis.cost, NULLIF(lis.clicks, 0)) AS cpc,
  SAFE_DIVIDE(lis.cost_usd, NULLIF(lis.clicks, 0)) AS cpc_usd,
  SAFE_DIVIDE(lis.cost * 1000, NULLIF(lis.impressions, 0)) AS cpm,
  SAFE_DIVIDE(lis.cost_usd * 1000, NULLIF(lis.impressions, 0)) AS cpm_usd,

  -- Media Quality & Viewability
  COALESCE(SAFE_DIVIDE(lis.active_view_viewable_impressions, w.asset_count), 0) AS active_view_viewable_impressions,
  COALESCE(SAFE_DIVIDE(lis.active_view_measurable_impressions, w.asset_count), 0) AS active_view_measurable_impressions,
  COALESCE(SAFE_DIVIDE(lis.active_view_eligible_impressions, w.asset_count), 0) AS active_view_eligible_impressions,
  SAFE_DIVIDE(lis.active_view_viewable_impressions, NULLIF(lis.active_view_measurable_impressions, 0)) AS viewability_rate,
  SAFE_DIVIDE(lis.active_view_measurable_impressions, NULLIF(lis.active_view_eligible_impressions, 0)) AS measurable_rate,

  -- Video & YouTube Delivery
  COALESCE(SAFE_DIVIDE(lis.trueview_views, w.asset_count), 0) AS trueview_views,
  SAFE_DIVIDE(lis.trueview_views, NULLIF(lis.impressions, 0)) AS vtr,
  COALESCE(SAFE_DIVIDE(lis.video_plays, w.asset_count), 0) AS video_plays,
  COALESCE(SAFE_DIVIDE(lis.video_first_quartile_completes, w.asset_count), 0) AS video_first_quartile_completes,
  COALESCE(SAFE_DIVIDE(lis.video_midpoints, w.asset_count), 0) AS video_midpoints,
  COALESCE(SAFE_DIVIDE(lis.video_third_quartile_completes, w.asset_count), 0) AS video_third_quartile_completes,
  COALESCE(SAFE_DIVIDE(lis.video_completions, w.asset_count), 0) AS video_completions,
  SAFE_DIVIDE(lis.video_completions, NULLIF(lis.video_plays, 0)) AS video_completion_rate,

  -- Attribution Breakdown
  COALESCE(SAFE_DIVIDE(lis.conversions, w.asset_count), 0) AS conversions,
  COALESCE(SAFE_DIVIDE(lis.post_click_conversions, w.asset_count), 0) AS post_click_conversions,
  COALESCE(SAFE_DIVIDE(lis.post_view_conversions, w.asset_count), 0) AS post_view_conversions,
  COALESCE(SAFE_DIVIDE(lis.post_click_revenue, w.asset_count), 0) AS post_click_revenue,
  COALESCE(SAFE_DIVIDE(lis.post_view_revenue, w.asset_count), 0) AS post_view_revenue,
  SAFE_DIVIDE(lis.post_click_conversions, NULLIF(lis.clicks, 0)) AS post_click_conv_rate
FROM unpacked_assets a
JOIN line_item_asset_weights w 
  ON a.lineItemId = w.lineItemId
LEFT JOIN line_item_stats lis
  ON a.lineItemId = lis.line_item_id
LEFT JOIN latest_ios io
  ON a.insertion_order_id = io.insertion_order_id
LEFT JOIN latest_campaigns cmp
  ON COALESCE(a.campaign_id, lis.campaign_id) = cmp.campaignId
LEFT JOIN latest_advertisers adv
  ON a.advertiser_id = adv.advertiserId
LEFT JOIN latest_settings sett
  ON a.advertiser_id = sett.advertiserId;
