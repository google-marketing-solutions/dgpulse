CREATE OR REPLACE TABLE `__PROJECT_ID__.__DATASET_ID__.final_creative_variety` AS
WITH dg_ads AS (
  SELECT 
    ad.*,
    COALESCE(
      NULLIF(ad.insertionOrderId, ''),
      NULLIF(li.insertionOrderId, '')
    ) AS resolved_io_id
  FROM `__PROJECT_ID__.__DATASET_ID__.ad_group_ads` ad
  LEFT JOIN (
    SELECT DISTINCT lineItemId, insertionOrderId 
    FROM `__PROJECT_ID__.__DATASET_ID__.line_items`
  ) li ON ad.lineItemId = li.lineItemId
  WHERE ad.entityStatus = 'ENTITY_STATUS_ACTIVE'
),
io_asset_counts AS (
  SELECT 
    resolved_io_id AS insertion_order_id,
    advertiserId AS advertiser_id,
    MAX(campaignId) AS campaign_id,
    SUM(videos_count) AS horizontal_videos,
    0 AS vertical_videos,
    0 AS square_videos,
    SUM(horizontal_images_count) AS horizontal_images,
    SUM(portrait_images_count) AS vertical_images,
    SUM(square_images_count) AS square_images,
    SUM(headlines_count) AS headlines,
    SUM(descriptions_count) AS descriptions
  FROM dg_ads
  WHERE resolved_io_id IS NOT NULL AND resolved_io_id != ''
  GROUP BY 1, 2
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
    MAX(NULLIF(displayName, '')) AS displayName
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
  COALESCE(io.campaign_id, ac.campaign_id, 'N/A') AS campaign_id,
  COALESCE(c.displayName, io.campaign_id, 'N/A') AS campaign_name,
  io.advertiser_id,
  io.advertiser_id AS account_id,
  COALESCE(sett.advertiser_name, adv.displayName, io.advertiser_id) AS account_name,
  '__PARTNER_ID__' AS partner_id,

  -- Image + Video Flag (YES if IO has both image and video assets)
  CASE 
    WHEN (COALESCE(ac.horizontal_videos, 0) + COALESCE(ac.vertical_videos, 0) + COALESCE(ac.square_videos, 0) > 0)
     AND (COALESCE(ac.horizontal_images, 0) + COALESCE(ac.vertical_images, 0) + COALESCE(ac.square_images, 0) > 0) THEN 'YES'
    ELSE 'NO'
  END AS image_and_video,

  -- Aspect Ratio Video Counts
  COALESCE(ac.vertical_videos, 0) AS vertical_videos,
  COALESCE(ac.horizontal_videos, 0) AS horizontal_videos,
  COALESCE(ac.square_videos, 0) AS square_videos,

  -- Aspect Ratio Image Counts
  COALESCE(ac.horizontal_images, 0) AS horizontal_images,
  COALESCE(ac.vertical_images, 0) AS vertical_images,
  COALESCE(ac.square_images, 0) AS square_images,

  -- Text Assets
  COALESCE(ac.headlines, 0) AS headlines,
  COALESCE(ac.descriptions, 0) AS descriptions,

  'NO' AS product_feed,

  -- Best Practice Rule: 3 vertical, 3 square, 3 horizontal images OR 1 vertical, 1 square, 1 horizontal video OR 1 vertical video (Shorts)
  CASE 
    WHEN (COALESCE(ac.vertical_images, 0) >= 3 AND COALESCE(ac.square_images, 0) >= 3 AND COALESCE(ac.horizontal_images, 0) >= 3)
      OR (COALESCE(ac.vertical_videos, 0) >= 1 AND COALESCE(ac.square_videos, 0) >= 1 AND COALESCE(ac.horizontal_videos, 0) >= 1)
      OR (COALESCE(ac.vertical_videos, 0) >= 1) THEN 'PASSED'
    ELSE 'NEEDS_ACTION'
  END AS asset_coverage_status
FROM latest_ios io
JOIN io_asset_counts ac ON io.insertion_order_id = ac.insertion_order_id
LEFT JOIN latest_campaigns c ON COALESCE(io.campaign_id, ac.campaign_id) = c.campaignId
LEFT JOIN latest_advertisers adv ON io.advertiser_id = adv.advertiserId
LEFT JOIN latest_settings sett ON io.advertiser_id = sett.advertiserId;
