CREATE OR REPLACE TABLE `__PROJECT_ID__.__DATASET_ID__.final_floodlight_activities_audit` AS
WITH latest_advertisers AS (
  SELECT 
    advertiserId,
    ANY_VALUE(displayName) AS advertiser_name
  FROM `__PROJECT_ID__.__DATASET_ID__.advertisers`
  GROUP BY advertiserId
),
latest_settings AS (
  SELECT 
    advertiserId,
    ANY_VALUE(gtg_status) AS gtg_status
  FROM `__PROJECT_ID__.__DATASET_ID__.advertiser_settings`
  GROUP BY advertiserId
)
SELECT 
  COALESCE(fa.auditDate, CURRENT_DATE()) AS date,
  fa.floodlightActivityId AS activity_id,
  fa.activityName AS activity_name,
  fa.advertiserId AS advertiser_id,
  fa.partnerId AS partner_id,
  fa.floodlightGroupId AS floodlight_group_id,
  COALESCE(adv.advertiser_name, fa.advertiserId) AS account_name,
  fa.servingStatus AS serving_status,
  fa.webTagType AS web_tag_type,
  fa.tagModernizationStatus AS tag_modernization_status,
  fa.clickLookbackDays AS click_lookback_days,
  fa.impressionLookbackDays AS impression_lookback_days,
  fa.attributionLookbackStatus AS attribution_lookback_status,
  fa.sslRequired AS ssl_required,
  fa.sslComplianceStatus AS ssl_compliance_status,
  fa.remarketingEnabled AS remarketing_enabled,
  COALESCE(sett.gtg_status, 'NOT_CONFIGURED') AS gtg_status,
  CASE 
    WHEN fa.servingStatus = 'FLOODLIGHT_ACTIVITY_SERVING_STATUS_DISABLED' THEN 'Disabled / Inactive Activity'
    WHEN fa.tagModernizationStatus = 'LEGACY_IMAGE_TAG' THEN '🔴 Upgrade to Modern Google Tag'
    WHEN fa.sslComplianceStatus = 'NON_SSL_COMPLIANT_WARNING' THEN '🔴 Enable SSL Compliance'
    WHEN fa.attributionLookbackStatus = 'ZERO_DAY_WINDOW_WARNING' THEN '🟡 Review 0-Day Lookback Window'
    ELSE '🟢 Healthy / Modern Tag'
  END AS recommended_action
FROM `__PROJECT_ID__.__DATASET_ID__.floodlight_activities` fa
LEFT JOIN latest_advertisers adv
  ON fa.advertiserId = adv.advertiserId
LEFT JOIN latest_settings sett
  ON fa.advertiserId = sett.advertiserId;
