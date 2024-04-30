/*
Copyright 2024 Google LLC

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

https://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

/*
This script will be used by gaarf to fetch Ad Group Ad
data from Google Ads API and store in a BQ Table.
*/

SELECT
  ad_group_ad.ad.id AS aga_id,
  ad_group.name AS ag_name,
  ad_group_ad.ad.type AS aga_type,
  ad_group_ad.ad.discovery_multi_asset_ad.portrait_marketing_images:asset AS dmaa_portrait_mkt_imgs,
  ad_group_ad.ad.discovery_multi_asset_ad.square_marketing_images:asset AS dmaa_square_mkt_imgs,
  ad_group_ad.ad.discovery_multi_asset_ad.marketing_images:asset AS dmaa_mkt_imgs,
  ad_group_ad.ad.discovery_multi_asset_ad.logo_images:asset AS dmaa_logo_imgs,
  ad_group_ad.ad.discovery_multi_asset_ad.descriptions AS dmaa_descriptions,
  ad_group_ad.ad.discovery_multi_asset_ad.headlines AS aga_headlines,
  ad_group_ad.ad.discovery_video_responsive_ad.videos:asset AS dvra_videos,
  ad_group_ad.ad.discovery_video_responsive_ad.long_headlines AS dvra_long_headlines,
  ad_group_ad.ad.discovery_video_responsive_ad.logo_images AS dvra_logo_imgs,
  ad_group_ad.ad.discovery_video_responsive_ad.descriptions AS dvra_descriptions,
  ad_group_ad.ad.discovery_video_responsive_ad.headlines AS dvra_headlines,
  customer.id AS account_id,
  campaign.id AS campaign_id,
  ad_group.id AS ag_id,
  campaign.name AS campaign_name
FROM
  ad_group_ad
WHERE
  campaign.advertising_channel_type = 'DISCOVERY'
  AND campaign.status = 'ENABLED'
  AND ad_group_ad.status = 'ENABLED'
-- SQLSTYLE: Notice that semi-colon (;) at the end of the script is not allowed by gaarf.