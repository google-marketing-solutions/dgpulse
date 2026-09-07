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
    ANY_VALUE(gtg_status) AS gtg_status,
    ANY_VALUE(floodlight_optimization_enabled) AS floodlight_optimization_enabled,
    ANY_VALUE(ec_enabled) AS ec_enabled,
    ANY_VALUE(dda_status) AS dda_status,
    ANY_VALUE(web_tag_type) AS web_tag_type
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
  COALESCE(fa.ec_enabled, 'NO') AS ec_enabled,
  COALESCE(fa.youtube_enabled, 'NO') AS youtube_enabled,
  CASE 
    WHEN sett.gtg_status = 'READY' THEN '🟢 READY'
    WHEN sett.gtg_status = 'NEEDS_TAG_UPGRADE' THEN '🔴 NEEDS_TAG_UPGRADE'
    ELSE '⚪ NOT_CONFIGURED'
  END AS gtg_status,
  CASE 
    WHEN fa.servingStatus = 'FLOODLIGHT_ACTIVITY_SERVING_STATUS_DISABLED' THEN 'Disabled / Inactive Activity'
    WHEN fa.tagModernizationStatus = 'LEGACY_IMAGE_TAG' THEN '🔴 Upgrade to Modern Google Tag'
    WHEN fa.sslComplianceStatus = 'NON_SSL_COMPLIANT_WARNING' THEN '🔴 Enable SSL Compliance'
    WHEN fa.attributionLookbackStatus = 'ZERO_DAY_WINDOW_WARNING' THEN '🟡 Review 0-Day Lookback Window'
    WHEN COALESCE(fa.youtube_enabled, 'NO') = 'NO' THEN '🟡 Enable for YouTube Tracking'
    WHEN COALESCE(fa.ec_enabled, 'NO') = 'NO' THEN '🟡 Enable Enhanced Conversions'
    ELSE '🟢 Healthy / Modern Tag'
  END AS recommended_action,
  CASE
    WHEN COALESCE(fa.youtube_enabled, 'NO') = 'NO' THEN 'https://support.google.com/displayvideo/answer/12123563'
    WHEN fa.tagModernizationStatus = 'LEGACY_IMAGE_TAG' THEN 'https://support.google.com/campaignmanager/answer/2823194'
    WHEN COALESCE(fa.ec_enabled, 'NO') = 'NO' THEN 'https://support.google.com/campaignmanager/answer/13019808'
    WHEN fa.attributionLookbackStatus = 'ZERO_DAY_WINDOW_WARNING' THEN 'https://support.google.com/campaignmanager/answer/2823194'
    ELSE 'https://support.google.com/displayvideo/answer/2697097'
  END AS steps_to_fix_url,
  -- Executive CLS Pre-Flight Status Indicators
  CASE 
    WHEN COALESCE(fa.youtube_enabled, 'NO') = 'YES' THEN '✅ Enabled' 
    ELSE '❌ Needs Setup' 
  END AS cls_youtube_status,
  CASE 
    WHEN fa.webTagType = 'WEB_TAG_TYPE_DYNAMIC' OR fa.tagModernizationStatus = 'MODERN_GOOGLE_TAG' THEN '✅ Dynamic Tag' 
    ELSE '❌ Image Tag' 
  END AS cls_dynamic_tag_status,
  CASE 
    WHEN COALESCE(fa.ec_enabled, 'NO') = 'YES' THEN '✅ Active' 
    ELSE '❌ Not Enabled' 
  END AS cls_ec_status,
  CASE 
    WHEN COALESCE(sett.dda_status, 'NOT_CONFIGURED') = 'ACTIVE' THEN '✅ DDA Active' 
    ELSE '🟡 Last Interaction' 
  END AS cls_dda_status,
  CASE 
    WHEN COALESCE(sett.gtg_status, 'NOT_CONFIGURED') = 'READY' THEN '🟢 Ready' 
    ELSE '🔴 Needs Upgrade' 
  END AS cls_gtg_status
FROM `__PROJECT_ID__.__DATASET_ID__.floodlight_activities` fa
LEFT JOIN latest_advertisers adv
  ON fa.advertiserId = adv.advertiserId
LEFT JOIN latest_settings sett
  ON fa.advertiserId = sett.advertiserId;

-- Executive Summary Pre-flight Checklist Table for Conversion Lift Studies (CLS)
CREATE OR REPLACE TABLE `__PROJECT_ID__.__DATASET_ID__.final_cls_preflight_audit` AS
WITH latest_settings AS (
  SELECT 
    advertiserId,
    ANY_VALUE(gtg_status) AS gtg_status,
    ANY_VALUE(dda_status) AS dda_status
  FROM `__PROJECT_ID__.__DATASET_ID__.advertiser_settings`
  GROUP BY advertiserId
),
adv_base AS (
  SELECT 
    adv.advertiserId AS advertiser_id,
    adv.displayName AS account_name,
    adv.partnerId AS partner_id,
    COUNT(fa.activity_id) AS total_activities,
    COUNTIF(fa.youtube_enabled = 'YES') AS yt_passing_activities,
    COUNTIF(fa.cls_dynamic_tag_status = '✅ Dynamic Tag') AS dynamic_passing_activities,
    COUNTIF(fa.ec_enabled = 'YES') AS ec_passing_activities,
    CASE 
      WHEN sett.dda_status = 'ACTIVE' THEN '✅ DDA Active'
      ELSE '🟡 Last Interaction'
    END AS dda_status,
    CASE 
      WHEN sett.gtg_status = 'READY' THEN '🟢 Ready'
      ELSE '🔴 Needs Upgrade'
    END AS gtg_status
  FROM `__PROJECT_ID__.__DATASET_ID__.advertisers` adv
  LEFT JOIN `__PROJECT_ID__.__DATASET_ID__.final_floodlight_activities_audit` fa
    ON adv.advertiserId = fa.advertiser_id
  LEFT JOIN latest_settings sett
    ON adv.advertiserId = sett.advertiserId
  GROUP BY adv.advertiserId, adv.displayName, adv.partnerId, sett.dda_status, sett.gtg_status
)
SELECT 
  advertiser_id,
  account_name,
  partner_id,
  CURRENT_DATE() AS audit_date,
  1 AS check_order,
  '1. YouTube Enabled' AS required_check,
  CASE 
    WHEN total_activities = 0 THEN '❌ Action Required'
    WHEN yt_passing_activities > 0 AND yt_passing_activities = total_activities THEN '✅ Pass'
    WHEN yt_passing_activities > 0 THEN '🟡 Partial'
    ELSE '❌ Action Required'
  END AS status,
  CASE 
    WHEN total_activities = 0 THEN 'FAIL'
    WHEN yt_passing_activities > 0 AND yt_passing_activities = total_activities THEN 'PASS'
    WHEN yt_passing_activities > 0 THEN 'WARN'
    ELSE 'FAIL'
  END AS status_code,
  CASE
    WHEN total_activities = 0 THEN 'No Floodlight activities configured'
    ELSE CONCAT(CAST(yt_passing_activities AS STRING), ' of ', CAST(total_activities AS STRING), ' activities enabled')
  END AS details,
  CASE 
    WHEN total_activities = 0 THEN 0.0
    ELSE ROUND(IEEE_DIVIDE(yt_passing_activities, total_activities) * 100, 1)
  END AS adoption_pct,
  'Set up conversion tracking for YouTube using YouTube-enabled Floodlight activities' AS steps_to_fix,
  'https://support.google.com/displayvideo/answer/12123563' AS steps_to_fix_url
FROM adv_base

UNION ALL

SELECT 
  advertiser_id,
  account_name,
  partner_id,
  CURRENT_DATE() AS audit_date,
  2 AS check_order,
  '2. Dynamic Tagging' AS required_check,
  CASE 
    WHEN total_activities = 0 THEN '❌ Action Required'
    WHEN dynamic_passing_activities = total_activities THEN '✅ Pass'
    WHEN dynamic_passing_activities > 0 THEN '🟡 Partial'
    ELSE '❌ Action Required'
  END AS status,
  CASE 
    WHEN total_activities = 0 THEN 'FAIL'
    WHEN dynamic_passing_activities = total_activities THEN 'PASS'
    WHEN dynamic_passing_activities > 0 THEN 'WARN'
    ELSE 'FAIL'
  END AS status_code,
  CASE
    WHEN total_activities = 0 THEN 'No Floodlight activities configured'
    ELSE CONCAT(CAST(dynamic_passing_activities AS STRING), ' of ', CAST(total_activities AS STRING), ' dynamic tags')
  END AS details,
  CASE 
    WHEN total_activities = 0 THEN 0.0
    ELSE ROUND(IEEE_DIVIDE(dynamic_passing_activities, total_activities) * 100, 1)
  END AS adoption_pct,
  'Enable dynamic tagging in Floodlight group / configuration' AS steps_to_fix,
  'https://support.google.com/campaignmanager/answer/2823194' AS steps_to_fix_url
FROM adv_base

UNION ALL

SELECT 
  advertiser_id,
  account_name,
  partner_id,
  CURRENT_DATE() AS audit_date,
  3 AS check_order,
  '3. Enhanced Conversions' AS required_check,
  CASE 
    WHEN total_activities = 0 THEN '❌ Action Required'
    WHEN ec_passing_activities = total_activities THEN '✅ Pass'
    WHEN ec_passing_activities > 0 THEN '🟡 Partial'
    ELSE '❌ Action Required'
  END AS status,
  CASE 
    WHEN total_activities = 0 THEN 'FAIL'
    WHEN ec_passing_activities = total_activities THEN 'PASS'
    WHEN ec_passing_activities > 0 THEN 'WARN'
    ELSE 'FAIL'
  END AS status_code,
  CASE
    WHEN total_activities = 0 THEN 'No Floodlight activities configured'
    ELSE CONCAT(CAST(ec_passing_activities AS STRING), ' of ', CAST(total_activities AS STRING), ' activities with EC')
  END AS details,
  CASE 
    WHEN total_activities = 0 THEN 0.0
    ELSE ROUND(IEEE_DIVIDE(ec_passing_activities, total_activities) * 100, 1)
  END AS adoption_pct,
  'Enable Enhanced Conversions for Floodlight at advertiser & activity levels' AS steps_to_fix,
  'https://support.google.com/campaignmanager/answer/13019808' AS steps_to_fix_url
FROM adv_base

UNION ALL

SELECT 
  advertiser_id,
  account_name,
  partner_id,
  CURRENT_DATE() AS audit_date,
  4 AS check_order,
  '4. Data Driven Attribution (DDA)' AS required_check,
  CASE 
    WHEN dda_status = '✅ DDA Active' THEN '✅ Pass'
    ELSE '🟡 Last Interaction'
  END AS status,
  CASE 
    WHEN dda_status = '✅ DDA Active' THEN 'PASS'
    ELSE 'WARN'
  END AS status_code,
  CASE 
    WHEN dda_status = '✅ DDA Active' THEN 'Smart Bidding / DDA applied on line items'
    ELSE 'Line items using standard / last-click attribution'
  END AS details,
  CASE WHEN dda_status = '✅ DDA Active' THEN 100.0 ELSE 0.0 END AS adoption_pct,
  'Create DDA model in CM360 and apply to DV360 line items' AS steps_to_fix,
  'https://support.google.com/campaignmanager/answer/6361280' AS steps_to_fix_url
FROM adv_base

UNION ALL

SELECT 
  advertiser_id,
  account_name,
  partner_id,
  CURRENT_DATE() AS audit_date,
  5 AS check_order,
  '5. Google Tag Gateway (GTG) Readiness' AS required_check,
  CASE 
    WHEN gtg_status = '🟢 Ready' THEN '🟢 Ready'
    ELSE '🔴 Needs Upgrade'
  END AS status,
  CASE 
    WHEN gtg_status = '🟢 Ready' THEN 'PASS'
    ELSE 'FAIL'
  END AS status_code,
  CASE 
    WHEN gtg_status = '🟢 Ready' THEN 'Modern tag deployed; check telemetry ping % at go/fermat'
    ELSE 'Legacy tag detected; migrate to modern Google Tag container'
  END AS details,
  CASE WHEN gtg_status = '🟢 Ready' THEN 100.0 ELSE 0.0 END AS adoption_pct,
  'Deploy Google Tag Gateway / First-Party Mode container (internal telemetry: go/fermat)' AS steps_to_fix,
  'https://support.google.com/tagmanager/answer/14800548' AS steps_to_fix_url
FROM adv_base;
