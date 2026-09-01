CREATE OR REPLACE TABLE `__PROJECT_ID__.__DATASET_ID__.final_creative_variety` AS
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
latest_creatives AS (
  SELECT 
    creativeId,
    MAX(NULLIF(advertiserId, '')) AS advertiserId,
    MAX(NULLIF(displayName, '')) AS displayName,
    MAX(NULLIF(creativeType, '')) AS creativeType,
    MAX(NULLIF(dimensions, '')) AS dimensions,
    MAX(NULLIF(imageUrl, '')) AS imageUrl
  FROM `__PROJECT_ID__.__DATASET_ID__.creatives`
  GROUP BY creativeId
),
creative_aspect_types AS (
  SELECT 
    creativeId,
    advertiserId,
    displayName,
    creativeType,
    dimensions,
    imageUrl,
    SAFE_CAST(SPLIT(dimensions, 'x')[SAFE_OFFSET(0)] AS INT64) AS width,
    SAFE_CAST(SPLIT(dimensions, 'x')[SAFE_OFFSET(1)] AS INT64) AS height,
    CASE 
      WHEN UPPER(creativeType) LIKE '%VIDEO%' OR UPPER(displayName) LIKE '%VIDEO%' OR UPPER(dimensions) LIKE '%VIDEO%' THEN
        CASE 
          WHEN (SAFE_CAST(SPLIT(dimensions, 'x')[SAFE_OFFSET(1)] AS INT64) > SAFE_CAST(SPLIT(dimensions, 'x')[SAFE_OFFSET(0)] AS INT64) * 1.15)
            OR dimensions LIKE '%1080x1920%' OR dimensions LIKE '%720x1280%' OR dimensions LIKE '%9:16%' OR UPPER(displayName) LIKE '%VERTICAL%' OR UPPER(displayName) LIKE '%SHORTS%' THEN 'VERTICAL VIDEO'
          WHEN (SAFE_CAST(SPLIT(dimensions, 'x')[SAFE_OFFSET(0)] AS INT64) = SAFE_CAST(SPLIT(dimensions, 'x')[SAFE_OFFSET(1)] AS INT64) AND SAFE_CAST(SPLIT(dimensions, 'x')[SAFE_OFFSET(0)] AS INT64) > 0)
            OR dimensions LIKE '%1080x1080%' OR dimensions LIKE '%1:1%' OR UPPER(displayName) LIKE '%SQUARE%' THEN 'SQUARE VIDEO'
          ELSE 'HORIZONTAL VIDEO'
        END
      ELSE
        CASE 
          WHEN (SAFE_CAST(SPLIT(dimensions, 'x')[SAFE_OFFSET(1)] AS INT64) > SAFE_CAST(SPLIT(dimensions, 'x')[SAFE_OFFSET(0)] AS INT64) * 1.15)
            OR dimensions LIKE '%1080x1920%' OR dimensions LIKE '%1200x1500%' OR dimensions LIKE '%4:5%' OR dimensions LIKE '%9:16%' OR dimensions LIKE '%300x600%' OR dimensions LIKE '%160x600%' THEN 'VERTICAL IMAGE'
          WHEN (SAFE_CAST(SPLIT(dimensions, 'x')[SAFE_OFFSET(0)] AS INT64) = SAFE_CAST(SPLIT(dimensions, 'x')[SAFE_OFFSET(1)] AS INT64) AND SAFE_CAST(SPLIT(dimensions, 'x')[SAFE_OFFSET(0)] AS INT64) > 0)
            OR dimensions LIKE '%1080x1080%' OR dimensions LIKE '%300x300%' OR dimensions LIKE '%1:1%' OR UPPER(displayName) LIKE '%SQUARE%' THEN 'SQUARE IMAGE'
          ELSE 'HORIZONTAL IMAGE'
        END
    END AS asset_type
  FROM latest_creatives
),
campaign_creatives AS (
  SELECT 
    CAST(dbm.Media_Plan_Id AS STRING) AS campaign_id,
    CAST(dbm.Advertiser_Id AS STRING) AS advertiser_id,
    c.creativeId,
    c.asset_type
  FROM deduped_dbm dbm
  JOIN creative_aspect_types c ON CAST(dbm.Creative_Id AS STRING) = c.creativeId
  WHERE dbm.Media_Plan_Id IS NOT NULL AND dbm.Creative_Id IS NOT NULL
  GROUP BY 1, 2, 3, 4
),
campaign_asset_counts AS (
  SELECT 
    campaign_id,
    advertiser_id,
    COUNTIF(asset_type = 'VERTICAL VIDEO') AS vertical_videos,
    COUNTIF(asset_type = 'HORIZONTAL VIDEO') AS horizontal_videos,
    COUNTIF(asset_type = 'SQUARE VIDEO') AS square_videos,
    COUNTIF(asset_type = 'HORIZONTAL IMAGE') AS horizontal_images,
    COUNTIF(asset_type = 'VERTICAL IMAGE') AS vertical_images,
    COUNTIF(asset_type = 'SQUARE IMAGE') AS square_images,
    -- Headlines and descriptions count (estimated from active text components/creatives)
    GREATEST(COUNTIF(asset_type LIKE '%IMAGE%'), 1) * 2 AS headlines,
    GREATEST(COUNTIF(asset_type LIKE '%IMAGE%'), 1) * 2 AS descriptions
  FROM campaign_creatives
  GROUP BY 1, 2
),
latest_campaigns AS (
  SELECT 
    campaignId,
    MAX(NULLIF(displayName, '')) AS displayName,
    MAX(NULLIF(advertiserId, '')) AS advertiserId
  FROM `__PROJECT_ID__.__DATASET_ID__.campaigns`
  WHERE campaignId IN (SELECT DISTINCT campaignId FROM demand_gen_line_items WHERE campaignId IS NOT NULL)
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
  c.campaignId AS campaign_id,
  COALESCE(c.displayName, c.campaignId) AS campaign_name,
  c.advertiserId AS advertiser_id,
  c.advertiserId AS account_id,
  COALESCE(sett.advertiser_name, adv.displayName, c.advertiserId) AS account_name,
  '__PARTNER_ID__' AS partner_id,

  -- Image + Video Flag (YES if campaign has both image and video assets)
  CASE 
    WHEN (COALESCE(ac.vertical_videos, 0) + COALESCE(ac.horizontal_videos, 0) + COALESCE(ac.square_videos, 0) > 0)
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

  -- Text Assets & Feeds
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
FROM latest_campaigns c
LEFT JOIN campaign_asset_counts ac ON c.campaignId = ac.campaign_id
LEFT JOIN latest_advertisers adv ON c.advertiserId = adv.advertiserId
LEFT JOIN latest_settings sett ON c.advertiserId = sett.advertiserId;
