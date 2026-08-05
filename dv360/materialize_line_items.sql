CREATE OR REPLACE TABLE `__PROJECT_ID__.__DATASET_ID__.final_line_items_performance` AS
WITH li_stats AS (
  SELECT 
    COALESCE(Report_Day, CURRENT_DATE()) AS date,
    CAST(Advertiser_Id AS STRING) AS advertiser_id,
    CAST(Partner_Id AS STRING) AS partner_id,
    ANY_VALUE(Insertion_Order) AS insertion_order_name,
    ANY_VALUE(CAST(Insertion_Order_Id AS STRING)) AS insertion_order_id,
    ANY_VALUE(Device_Type) AS device_type,
    ANY_VALUE(Inventory_Source) AS inventory_source,
    SUM(Impressions) AS impressions,
    SUM(Clicks) AS clicks,
    SUM(Revenue) AS cost,
    SUM(Total_Conversions) AS conversions,
    SUM(COALESCE(Active_View_Viewable_Impressions, 0)) AS active_view_viewable_impressions,
    SUM(COALESCE(Active_View_Measurable_Impressions, 0)) AS active_view_measurable_impressions,
    SUM(COALESCE(TrueView_Views, 0)) AS trueview_views
  FROM `__PROJECT_ID__.__DATASET_ID__.dbm_performance`
  GROUP BY 1, 2, 3
)
SELECT 
  COALESCE(s.date, CURRENT_DATE()) AS date,
  li.lineItemId AS line_item_id,
  li.displayName AS line_item_name,
  li.lineItemType AS line_item_type,
  li.entityStatus AS entity_status,
  IF(li.entityStatus = 'ENTITY_STATUS_PAUSED', 'YES', 'NO') AS is_limited_by_budget,
  s.insertion_order_id,
  s.insertion_order_name,
  s.device_type,
  s.inventory_source,
  li.campaignId AS campaign_id,
  c.displayName AS campaign_name,
  li.advertiserId AS advertiser_id,
  li.advertiserId AS account_id,
  li.advertiserId AS account_name,
  COALESCE(s.partner_id, '__PARTNER_ID__') AS partner_id,
  COALESCE(s.impressions, 0) AS impressions,
  COALESCE(s.clicks, 0) AS clicks,
  COALESCE(s.cost, 0) AS cost,
  COALESCE(s.conversions, 0) AS conversions,
  COALESCE(s.active_view_viewable_impressions, 0) AS active_view_viewable_impressions,
  COALESCE(s.active_view_measurable_impressions, 0) AS active_view_measurable_impressions,
  SAFE_DIVIDE(COALESCE(s.active_view_viewable_impressions, 0), COALESCE(s.active_view_measurable_impressions, 0)) AS viewability_rate,
  COALESCE(s.trueview_views, 0) AS trueview_views,
  SAFE_DIVIDE(COALESCE(s.trueview_views, 0), COALESCE(s.impressions, 0)) AS vtr,
  SAFE_DIVIDE(COALESCE(s.clicks, 0), COALESCE(s.impressions, 0)) AS ctr,
  SAFE_DIVIDE(COALESCE(s.cost, 0), COALESCE(s.clicks, 0)) AS cpc,
  SAFE_DIVIDE(COALESCE(s.cost, 0) * 1000, COALESCE(s.impressions, 0)) AS cpm
FROM `__PROJECT_ID__.__DATASET_ID__.line_items` li
LEFT JOIN `__PROJECT_ID__.__DATASET_ID__.campaigns` c
  ON li.campaignId = c.campaignId
LEFT JOIN li_stats s
  ON li.advertiserId = s.advertiser_id;
