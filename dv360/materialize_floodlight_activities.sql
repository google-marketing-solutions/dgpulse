CREATE OR REPLACE TABLE `__PROJECT_ID__.__DATASET_ID__.final_floodlight_activities_audit` AS
WITH dg_advertisers AS (
  SELECT DISTINCT CAST(advertiserId AS STRING) AS advertiserId
  FROM `__PROJECT_ID__.__DATASET_ID__.line_items`
  WHERE lineItemType LIKE '%DEMAND_GEN%'
),
latest_advertisers AS (
  SELECT 
    advertiserId,
    ANY_VALUE(displayName) AS advertiser_name,
    ANY_VALUE(partnerId) AS partner_id
  FROM `__PROJECT_ID__.__DATASET_ID__.advertisers`
  WHERE (
    (SELECT COUNT(1) FROM dg_advertisers) = 0 
    OR advertiserId IN (SELECT advertiserId FROM dg_advertisers)
  )
  GROUP BY advertiserId
),
latest_activities AS (
  SELECT 
    advertiserId,
    floodlightActivityId,
    ANY_VALUE(partnerId) AS partnerId,
    ANY_VALUE(floodlightGroupId) AS floodlightGroupId,
    ANY_VALUE(activityName) AS activityName,
    ANY_VALUE(servingStatus) AS servingStatus,
    ANY_VALUE(webTagType) AS webTagType,
    ANY_VALUE(clickLookbackDays) AS clickLookbackDays,
    ANY_VALUE(impressionLookbackDays) AS impressionLookbackDays,
    ANY_VALUE(attributionLookbackStatus) AS attributionLookbackStatus,
    ANY_VALUE(sslRequired) AS sslRequired,
    ANY_VALUE(sslComplianceStatus) AS sslComplianceStatus,
    ANY_VALUE(remarketingEnabled) AS remarketingEnabled,
    ANY_VALUE(youtube_enabled) AS youtube_enabled,
    MAX(auditDate) AS auditDate
  FROM `__PROJECT_ID__.__DATASET_ID__.floodlight_activities`
  WHERE advertiserId IN (SELECT advertiserId FROM latest_advertisers)
    -- Serving activities only.
    --
    -- Disabled activities vastly outnumber live ones (~5,000 vs ~174 on
    -- partner 6631618296) and were inflating every account-level denominator
    -- in final_cls_preflight_audit -- e.g. "637 of 637 activities enabled"
    -- and "0 of 2206 activities with EC", where the true serving population
    -- is a small fraction of that.
    --
    -- Filtering here fixes BOTH tables in one place: final_cls_preflight_audit
    -- is built from final_floodlight_activities_audit via adv_base (below),
    -- so the rollup inherits this filter automatically. Do not add a second
    -- filter downstream.
    --
    -- The raw floodlight_activities table is deliberately left complete, so
    -- the disabled population stays queryable and this change is reversible
    -- without re-syncing from the DV360 API.
    --
    -- Enum values are FLOODLIGHT_ACTIVITY_SERVING_STATUS_{ENABLED,DISABLED,
    -- UNSPECIFIED}; process_advertiser.js additionally writes the literal
    -- 'UNKNOWN' when the API omits the field. This is a strict equality by
    -- deliberate choice, so UNSPECIFIED/UNKNOWN are excluded along with
    -- DISABLED.
    AND servingStatus = 'FLOODLIGHT_ACTIVITY_SERVING_STATUS_ENABLED'
  GROUP BY advertiserId, floodlightActivityId
),
latest_settings AS (
  SELECT 
    advertiserId,
    ANY_VALUE(gtg_status) AS gtg_status,
    ANY_VALUE(floodlight_optimization_enabled) AS floodlight_optimization_enabled,
    ANY_VALUE(dda_status) AS dda_status,
    ANY_VALUE(web_tag_type) AS web_tag_type
  FROM `__PROJECT_ID__.__DATASET_ID__.advertiser_settings`
  WHERE advertiserId IN (SELECT advertiserId FROM latest_advertisers)
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
  fa.clickLookbackDays AS click_lookback_days,
  fa.impressionLookbackDays AS impression_lookback_days,
  fa.attributionLookbackStatus AS attribution_lookback_status,
  fa.sslRequired AS ssl_required,
  fa.sslComplianceStatus AS ssl_compliance_status,
  fa.remarketingEnabled AS remarketing_enabled,
  -- ec_enabled / cls_ec_status removed: no Enhanced Conversions flag exists on
  -- the DV360 v4 FloodlightActivity resource, so both were constant 'NO' /
  -- '❌ Not Enabled' for every activity ever audited.
  COALESCE(fa.youtube_enabled, 'NO') AS youtube_enabled,
  CASE 
    WHEN sett.gtg_status = 'READY' THEN '🟢 READY'
    WHEN sett.gtg_status = 'NEEDS_TAG_UPGRADE' THEN '🔴 NEEDS_TAG_UPGRADE'
    ELSE '⚪ NOT_CONFIGURED'
  END AS gtg_status,
  -- Precomputed DV360 Deep Links
  CONCAT('https://displayvideo.google.com/ng_nav/p/', COALESCE(NULLIF(fa.partnerId, ''), NULLIF(adv.partner_id, ''), '__PARTNER_ID__'), '/a/', fa.advertiserId, '/fl/fle/', fa.floodlightActivityId, '/details') AS dv360_activity_url,
  CONCAT('https://displayvideo.google.com/ng_nav/p/', COALESCE(NULLIF(fa.partnerId, ''), NULLIF(adv.partner_id, ''), '__PARTNER_ID__'), '/a/', fa.advertiserId, '/fl/details') AS dv360_floodlight_group_url,
  -- Executive CLS Pre-Flight Status Indicators
  CASE 
    WHEN COALESCE(fa.youtube_enabled, 'NO') = 'YES' THEN '✅ Enabled' 
    ELSE '❌ Needs Setup' 
  END AS cls_youtube_status,
  CASE 
    WHEN fa.webTagType = 'WEB_TAG_TYPE_DYNAMIC' THEN '✅ Dynamic Tag' 
    ELSE '❌ Image Tag' 
  END AS cls_dynamic_tag_status,
  CASE 
    WHEN COALESCE(sett.dda_status, 'NOT_CONFIGURED') = 'ACTIVE' THEN '✅ DDA Active' 
    ELSE '🟡 Last Interaction' 
  END AS cls_dda_status,
  CASE 
    WHEN COALESCE(sett.gtg_status, 'NOT_CONFIGURED') = 'READY' THEN '🟢 Ready' 
    ELSE '🔴 Needs Upgrade' 
  END AS cls_gtg_status
FROM latest_activities fa
INNER JOIN latest_advertisers adv
  ON fa.advertiserId = adv.advertiserId
LEFT JOIN latest_settings sett
  ON fa.advertiserId = sett.advertiserId;

-- Executive Summary Pre-flight Checklist Table for Conversion Lift Studies (CLS)
CREATE OR REPLACE TABLE `__PROJECT_ID__.__DATASET_ID__.final_cls_preflight_audit` AS
WITH dg_advertisers AS (
  SELECT DISTINCT CAST(advertiserId AS STRING) AS advertiserId
  FROM `__PROJECT_ID__.__DATASET_ID__.line_items`
  WHERE lineItemType LIKE '%DEMAND_GEN%'
),
latest_settings AS (
  SELECT 
    advertiserId,
    ANY_VALUE(gtg_status) AS gtg_status,
    ANY_VALUE(dda_status) AS dda_status
  FROM `__PROJECT_ID__.__DATASET_ID__.advertiser_settings`
  GROUP BY advertiserId
),
latest_advertisers AS (
  SELECT 
    advertiserId,
    ANY_VALUE(displayName) AS advertiser_name,
    ANY_VALUE(partnerId) AS partner_id
  FROM `__PROJECT_ID__.__DATASET_ID__.advertisers`
  WHERE (
    (SELECT COUNT(1) FROM dg_advertisers) = 0 
    OR advertiserId IN (SELECT advertiserId FROM dg_advertisers)
  )
  GROUP BY advertiserId
),
adv_base AS (
  SELECT 
    adv.advertiserId AS advertiser_id,
    adv.advertiser_name AS account_name,
    adv.partner_id AS partner_id,
    COUNT(fa.activity_id) AS total_activities,
    COUNTIF(fa.youtube_enabled = 'YES') AS yt_passing_activities,
    COUNTIF(fa.cls_dynamic_tag_status = '✅ Dynamic Tag') AS dynamic_passing_activities,
    CASE 
      WHEN sett.dda_status = 'ACTIVE' THEN '✅ DDA Active'
      ELSE '🟡 Last Interaction'
    END AS dda_status,
    CASE 
      WHEN sett.gtg_status = 'READY' THEN '🟢 Ready'
      ELSE '🔴 Needs Upgrade'
    END AS gtg_status
  FROM latest_advertisers adv
  LEFT JOIN `__PROJECT_ID__.__DATASET_ID__.final_floodlight_activities_audit` fa
    ON adv.advertiserId = fa.advertiser_id
  LEFT JOIN latest_settings sett
    ON adv.advertiserId = sett.advertiserId
  GROUP BY adv.advertiserId, adv.advertiser_name, adv.partner_id, sett.dda_status, sett.gtg_status
)
SELECT 
  advertiser_id,
  account_name,
  partner_id,
  CURRENT_DATE() AS audit_date,
  1 AS check_order,
  'YouTube Enabled' AS required_check,
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
    WHEN total_activities = 0 THEN 'No serving Floodlight activities'
    ELSE CONCAT(CAST(yt_passing_activities AS STRING), ' of ', CAST(total_activities AS STRING), ' activities enabled')
  END AS details,
  CASE 
    WHEN yt_passing_activities > 0 AND yt_passing_activities = total_activities THEN NULL
    ELSE 'Set up conversion tracking for YouTube using YouTube-enabled Floodlight activities' 
  END AS steps_to_fix,
  CASE 
    WHEN yt_passing_activities > 0 AND yt_passing_activities = total_activities THEN NULL 
    ELSE 'https://support.google.com/displayvideo/answer/12123563' 
  END AS steps_to_fix_url
FROM adv_base

UNION ALL

SELECT 
  advertiser_id,
  account_name,
  partner_id,
  CURRENT_DATE() AS audit_date,
  2 AS check_order,
  'Dynamic Tagging' AS required_check,
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
    WHEN total_activities = 0 THEN 'No serving Floodlight activities'
    ELSE CONCAT(CAST(dynamic_passing_activities AS STRING), ' of ', CAST(total_activities AS STRING), ' dynamic tags')
  END AS details,
  CASE 
    WHEN dynamic_passing_activities = total_activities AND total_activities > 0 THEN NULL
    ELSE 'Enable dynamic tagging in Floodlight group / configuration' 
  END AS steps_to_fix,
  CASE 
    WHEN dynamic_passing_activities = total_activities AND total_activities > 0 THEN NULL 
    ELSE 'https://support.google.com/campaignmanager/answer/2823194' 
  END AS steps_to_fix_url
FROM adv_base

-- CLS check #3, "Enhanced Conversions", was removed here. The DV360 v4
-- FloodlightActivity resource carries no Enhanced Conversions flag (and neither
-- does CM360 v5), so ec_enabled was always 'NO' and the check reported
-- "0 of N activities with EC" for every advertiser regardless of their real
-- configuration. Do not reinstate it without a verified API source. The
-- remaining checks are renumbered 1-4.
UNION ALL

SELECT 
  advertiser_id,
  account_name,
  partner_id,
  CURRENT_DATE() AS audit_date,
  3 AS check_order,
  'Data Driven Attribution (DDA)' AS required_check,
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
  CASE 
    WHEN dda_status = '✅ DDA Active' THEN NULL 
    ELSE 'Create DDA model in CM360 and apply to DV360 line items' 
  END AS steps_to_fix,
  CASE 
    WHEN dda_status = '✅ DDA Active' THEN NULL 
    ELSE 'https://support.google.com/campaignmanager/answer/6361280' 
  END AS steps_to_fix_url
FROM adv_base

UNION ALL

SELECT 
  advertiser_id,
  account_name,
  partner_id,
  CURRENT_DATE() AS audit_date,
  4 AS check_order,
  'Google Tag Gateway (GTG) Readiness' AS required_check,
  CASE 
    WHEN gtg_status = '🟢 Ready' THEN '🟢 Ready'
    ELSE '🔴 Needs Upgrade'
  END AS status,
  CASE 
    WHEN gtg_status = '🟢 Ready' THEN 'PASS'
    ELSE 'FAIL'
  END AS status_code,
  CASE 
    WHEN gtg_status = '🟢 Ready' THEN 'Modern Google Tag deployed and ready for First-Party Mode'
    ELSE 'Legacy tag detected; migrate to modern Google Tag container'
  END AS details,
  CASE 
    WHEN gtg_status = '🟢 Ready' THEN NULL 
    ELSE 'Deploy Google Tag Gateway / First-Party Mode container to protect measurement' 
  END AS steps_to_fix,
  CASE 
    WHEN gtg_status = '🟢 Ready' THEN NULL 
    ELSE 'https://developers.google.com/tag-platform/tag-manager/gateway/setup-guide' 
  END AS steps_to_fix_url
FROM adv_base;
