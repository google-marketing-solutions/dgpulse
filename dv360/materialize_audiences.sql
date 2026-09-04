CREATE OR REPLACE TABLE `__PROJECT_ID__.__DATASET_ID__.final_audiences_performance` AS
WITH demand_gen_line_items AS (
  SELECT DISTINCT campaignId, insertionOrderId, lineItemId
  FROM `__PROJECT_ID__.__DATASET_ID__.line_items`
  WHERE lineItemType LIKE '%DEMAND_GEN%'
),
deduped_dbm AS (
  SELECT * EXCEPT(row_num) FROM (
    SELECT *, ROW_NUMBER() OVER(
      PARTITION BY Report_Day, Insertion_Order_Id, COALESCE(Line_Item_Id, 0), COALESCE(Audience_List_Id, 0), Audience_List
    ) AS row_num
    FROM `__PROJECT_ID__.__DATASET_ID__.dbm_audiences_performance`
    WHERE Insertion_Order_Id IS NOT NULL AND Insertion_Order_Id > 0
      AND (
        Insertion_Order_Id IN (SELECT DISTINCT CAST(insertionOrderId AS INT64) FROM demand_gen_line_items WHERE insertionOrderId IS NOT NULL)
        OR (Line_Item_Id IS NOT NULL AND Line_Item_Id IN (SELECT DISTINCT CAST(lineItemId AS INT64) FROM demand_gen_line_items))
      )
  )
  WHERE row_num = 1
),
audience_stats AS (
  SELECT 
    COALESCE(Report_Day, CURRENT_DATE()) AS date,
    CAST(Partner_Id AS STRING) AS partner_id,
    CAST(Advertiser_Id AS STRING) AS advertiser_id,
    CAST(Media_Plan_Id AS STRING) AS campaign_id,
    CAST(Insertion_Order_Id AS STRING) AS insertion_order_id,
    CAST(Line_Item_Id AS STRING) AS line_item_id,
    COALESCE(CAST(Audience_List_Id AS STRING), 'N/A') AS audience_id,
    COALESCE(NULLIF(Audience_List, ''), 'Unassigned / Optimized Expansion') AS audience_segment,
    COALESCE(NULLIF(Audience_List_Type, ''), 'OTHER') AS raw_audience_type,
    MAX(NULLIF(Advertiser_Currency, '')) AS currency_code,
    SUM(Impressions) AS impressions,
    SUM(Clicks) AS clicks,
    SUM(Revenue) AS cost,
    SUM(COALESCE(NULLIF(Revenue_USD, 0), Revenue)) AS cost_usd,
    SUM(Total_Conversions) AS conversions,
    SUM(COALESCE(Post_View_Conversions, 0)) AS vtc,
    SUM(COALESCE(Post_Click_Conversions, 0)) AS post_click_conversions,
    SUM(COALESCE(CM_Post_Click_Revenue, 0)) AS post_click_revenue,
    SUM(COALESCE(CM_Post_View_Revenue, 0)) AS post_view_revenue
  FROM deduped_dbm
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
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
    insertionOrderId,
    MAX(NULLIF(displayName, '')) AS displayName
  FROM `__PROJECT_ID__.__DATASET_ID__.insertion_orders`
  GROUP BY insertionOrderId
),
latest_line_items AS (
  SELECT 
    lineItemId,
    MAX(NULLIF(displayName, '')) AS displayName
  FROM `__PROJECT_ID__.__DATASET_ID__.line_items`
  WHERE lineItemType LIKE '%DEMAND_GEN%'
  GROUP BY lineItemId
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
    MAX(NULLIF(displayName, '')) AS advertiser_name,
    MAX(NULLIF(currency_code, '')) AS currency_code
  FROM `__PROJECT_ID__.__DATASET_ID__.advertiser_settings`
  GROUP BY advertiserId
)
SELECT 
  s.date,
  COALESCE(s.partner_id, adv.partnerId, '__PARTNER_ID__') AS partner_id,
  s.advertiser_id,
  s.advertiser_id AS account_id,
  COALESCE(sett.advertiser_name, adv.displayName, s.advertiser_id) AS account_name,
  s.campaign_id,
  COALESCE(c.displayName, s.campaign_id) AS campaign_name,
  s.insertion_order_id,
  COALESCE(io.displayName, s.insertion_order_id) AS insertion_order_name,
  s.line_item_id,
  COALESCE(li.displayName, s.line_item_id) AS line_item_name,
  s.audience_id,
  s.audience_segment,
  
  -- Clean Audience Types matching Google Ads UI: USER_LIST (1PD), CUSTOM_AUDIENCE, USER_INTEREST, LOOKALIKE, OTHER
  CASE 
    WHEN UPPER(s.raw_audience_type) LIKE '%FIRST_PARTY%' OR UPPER(s.raw_audience_type) LIKE '%1P%' OR UPPER(s.raw_audience_type) LIKE '%CUSTOMER%' THEN 'USER_LIST (1PD)'
    WHEN UPPER(s.raw_audience_type) LIKE '%CUSTOM%' THEN 'CUSTOM_AUDIENCE'
    WHEN UPPER(s.raw_audience_type) LIKE '%INTEREST%' OR UPPER(s.raw_audience_type) LIKE '%AFFINITY%' OR UPPER(s.raw_audience_type) LIKE '%IN_MARKET%' THEN 'USER_INTEREST (Google Audience)'
    WHEN UPPER(s.raw_audience_type) LIKE '%SIMILAR%' OR UPPER(s.raw_audience_type) LIKE '%LOOKALIKE%' THEN 'LOOKALIKE'
    WHEN UPPER(s.raw_audience_type) LIKE '%THIRD_PARTY%' OR UPPER(s.raw_audience_type) LIKE '%3P%' THEN 'THIRD_PARTY'
    ELSE s.raw_audience_type
  END AS audience_type,
  
  CASE 
    WHEN UPPER(s.raw_audience_type) LIKE '%FIRST_PARTY%' OR UPPER(s.raw_audience_type) LIKE '%1P%' OR UPPER(s.raw_audience_type) LIKE '%CUSTOMER%' THEN 'YES'
    ELSE 'NO'
  END AS is_first_party,

  COALESCE(s.currency_code, NULLIF(adv.currency_code, ''), NULLIF(sett.currency_code, '')) AS currency_code,
  
  -- Performance Metrics
  COALESCE(s.impressions, 0) AS impressions,
  COALESCE(s.clicks, 0) AS clicks,
  COALESCE(s.cost, 0) AS cost,
  COALESCE(s.cost_usd, 0) AS cost_usd,
  COALESCE(s.conversions, 0) AS conversions,
  COALESCE(s.vtc, 0) AS vtc,
  SAFE_DIVIDE(COALESCE(s.cost, 0), NULLIF(COALESCE(s.conversions, 0), 0)) AS cpa,
  SAFE_DIVIDE(COALESCE(s.cost_usd, 0), NULLIF(COALESCE(s.conversions, 0), 0)) AS cpa_usd,
  SAFE_DIVIDE(COALESCE(s.post_click_revenue, 0) + COALESCE(s.post_view_revenue, 0), NULLIF(COALESCE(s.cost, 0), 0)) AS roas,
  SAFE_DIVIDE(COALESCE(s.cost, 0), NULLIF(COALESCE(s.clicks, 0), 0)) AS avg_cpc,
  SAFE_DIVIDE(COALESCE(s.cost_usd, 0), NULLIF(COALESCE(s.clicks, 0), 0)) AS avg_cpc_usd
FROM audience_stats s
LEFT JOIN latest_campaigns c ON s.campaign_id = c.campaignId
LEFT JOIN latest_ios io ON s.insertion_order_id = io.insertionOrderId
LEFT JOIN latest_line_items li ON s.line_item_id = li.lineItemId
LEFT JOIN latest_advertisers adv ON s.advertiser_id = adv.advertiserId
LEFT JOIN latest_settings sett ON s.advertiser_id = sett.advertiserId;
