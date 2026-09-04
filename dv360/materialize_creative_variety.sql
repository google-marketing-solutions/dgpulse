CREATE OR REPLACE TABLE `__PROJECT_ID__.__DATASET_ID__.final_creative_variety` AS
WITH dg_line_items AS (
  SELECT DISTINCT lineItemId, insertionOrderId, campaignId, advertiserId
  FROM `__PROJECT_ID__.__DATASET_ID__.line_items`
  WHERE lineItemType = 'LINE_ITEM_TYPE_DEMAND_GEN'
     OR lineItemType LIKE '%DEMAND_GEN%'
),
dg_ads AS (
  SELECT 
    ad.*,
    COALESCE(
      NULLIF(ad.insertionOrderId, ''),
      NULLIF(li.insertionOrderId, '')
    ) AS resolved_io_id
  FROM `__PROJECT_ID__.__DATASET_ID__.ad_group_ads` ad
  LEFT JOIN dg_line_items li 
    ON ad.lineItemId = li.lineItemId
  WHERE ad.entityStatus = 'ENTITY_STATUS_ACTIVE'
    AND ad.approvalStatus IN ('APPROVED', 'APPROVED_LIMITED')
),
-- Deduplicate identical ad concepts per IO
unique_ads_per_io AS (
  SELECT 
    resolved_io_id,
    advertiserId,
    displayName AS ad_name,
    adType AS ad_type,
    ANY_VALUE(campaignId) AS campaignId,
    ANY_VALUE(adGroupAdId) AS adGroupAdId,
    ANY_VALUE(video_id) AS video_id,
    AVG(aspect_ratio) AS aspect_ratio,
    MAX(videos_count) AS videos_count,
    MAX(horizontal_images_count) AS horizontal_images_count,
    MAX(portrait_images_count) AS portrait_images_count,
    MAX(square_images_count) AS square_images_count,
    MAX(headlines_count) AS headlines_count,
    MAX(descriptions_count) AS descriptions_count
  FROM dg_ads
  WHERE resolved_io_id IS NOT NULL AND resolved_io_id != ''
  GROUP BY resolved_io_id, advertiserId, displayName, adType
),
-- Classify aspect ratios per ad based on YouTube player dimensions
classified_ads AS (
  SELECT
    resolved_io_id,
    advertiserId,
    ad_name,
    ad_type,
    campaignId,
    adGroupAdId,
    video_id,
    aspect_ratio,
    -- Video aspect ratio evaluation: strictly numerical, matching Google Ads DGPulse
    -- aspect_ratio < 1.0 -> Portrait / Vertical (e.g. 0.56)
    -- aspect_ratio = 1.0 -> Square
    -- aspect_ratio > 1.0 -> Landscape / Horizontal (e.g. 1.78)
    CASE 
      WHEN ad_type = 'DEMAND_GEN_VIDEO_AD' AND aspect_ratio IS NOT NULL AND aspect_ratio < 1.0 THEN 1 
      ELSE 0 
    END AS vertical_videos,
    CASE 
      WHEN ad_type = 'DEMAND_GEN_VIDEO_AD' AND aspect_ratio IS NOT NULL AND aspect_ratio = 1.0 THEN 1 
      ELSE 0 
    END AS square_videos,
    CASE 
      WHEN ad_type = 'DEMAND_GEN_VIDEO_AD' AND (aspect_ratio IS NULL OR aspect_ratio > 1.0) THEN 1 
      ELSE 0 
    END AS horizontal_videos,
    -- Image aspect ratios
    COALESCE(horizontal_images_count, 0) AS horizontal_images,
    COALESCE(portrait_images_count, 0) AS vertical_images,
    COALESCE(square_images_count, 0) AS square_images,
    -- Text counts
    COALESCE(headlines_count, 0) AS headlines,
    COALESCE(descriptions_count, 0) AS descriptions
  FROM unique_ads_per_io
),
latest_ios AS (
  SELECT 
    insertionOrderId AS insertion_order_id,
    MAX(NULLIF(displayName, '')) AS insertion_order_name,
    MAX(NULLIF(advertiserId, '')) AS advertiser_id,
    MAX(NULLIF(campaignId, '')) AS campaign_id
  FROM `__PROJECT_ID__.__DATASET_ID__.insertion_orders`
  GROUP BY 1
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
)
SELECT 
  io.insertion_order_id,
  COALESCE(io.insertion_order_name, io.insertion_order_id) AS insertion_order_name,
  ca.ad_name,
  ca.ad_type,
  ca.adGroupAdId AS ad_group_ad_id,
  COALESCE(io.campaign_id, ca.campaignId, 'N/A') AS campaign_id,
  COALESCE(c.displayName, io.campaign_id, 'N/A') AS campaign_name,
  io.advertiser_id,
  io.advertiser_id AS account_id,
  COALESCE(sett.advertiser_name, adv.displayName, io.advertiser_id) AS account_name,
  COALESCE(adv.partnerId, '__PARTNER_ID__') AS partner_id,

  -- Holistic IO-Level Image + Video Flag (Evaluated across all ads in the IO)
  CASE 
    WHEN (SUM(ca.horizontal_videos + ca.vertical_videos + ca.square_videos) OVER(PARTITION BY io.insertion_order_id) > 0)
     AND (SUM(ca.horizontal_images + ca.vertical_images + ca.square_images) OVER(PARTITION BY io.insertion_order_id) > 0) THEN 'YES'
    ELSE 'NO'
  END AS image_and_video,

  -- Aspect Ratio Video Counts (Summable by Looker Studio at IO level, drillable to Ad level)
  ca.vertical_videos,
  ca.horizontal_videos,
  ca.square_videos,

  -- Aspect Ratio Image Counts
  ca.horizontal_images,
  ca.vertical_images,
  ca.square_images,

  -- Text Assets
  ca.headlines,
  ca.descriptions,

  'NO' AS product_feed,

  -- Holistic Best Practice Rule: 3 vertical, 3 square, 3 horizontal images OR 1 vertical, 1 square, 1 horizontal video OR 1 vertical video (Shorts)
  CASE 
    WHEN (
      SUM(ca.vertical_images) OVER(PARTITION BY io.insertion_order_id) >= 3 
      AND SUM(ca.square_images) OVER(PARTITION BY io.insertion_order_id) >= 3 
      AND SUM(ca.horizontal_images) OVER(PARTITION BY io.insertion_order_id) >= 3
    )
    OR (
      SUM(ca.vertical_videos) OVER(PARTITION BY io.insertion_order_id) >= 1 
      AND SUM(ca.square_videos) OVER(PARTITION BY io.insertion_order_id) >= 1 
      AND SUM(ca.horizontal_videos) OVER(PARTITION BY io.insertion_order_id) >= 1
    )
    OR (
      SUM(ca.vertical_videos) OVER(PARTITION BY io.insertion_order_id) >= 1
    ) THEN 'PASSED'
    ELSE 'NEEDS_ACTION'
  END AS asset_coverage_status
FROM latest_ios io
JOIN classified_ads ca 
  ON io.insertion_order_id = ca.resolved_io_id
LEFT JOIN latest_campaigns c 
  ON COALESCE(io.campaign_id, ca.campaignId) = c.campaignId
LEFT JOIN latest_advertisers adv 
  ON io.advertiser_id = adv.advertiserId
LEFT JOIN latest_settings sett 
  ON io.advertiser_id = sett.advertiserId;
