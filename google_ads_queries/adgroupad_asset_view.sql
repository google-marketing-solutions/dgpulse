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
 This script will be used by gaarf to fetch ad_group_ad_asset_view
 for a given date range from Google Ads API and store in a BQ Table.

 @param {start_date} The start date of the date range.
 @param {end_date} The end date of the date range.
 */
SELECT
    segments.date AS date,
    metrics.conversions AS conversions,
    metrics.clicks AS clicks,
    metrics.ctr AS ctr,
    metrics.cost_micros AS cost,
    campaign.id,
    campaign.name AS campaign_name,
    ad_group_ad_asset_view.resource_name AS asset_type_inferred,
    customer.id AS account_id,
    customer.descriptive_name AS account_name,
    asset.id,
    asset.image_asset.full_size.url AS image_url
  FROM ad_group_ad_asset_view
  WHERE segments.date >= "{start_date}"
  AND segments.date <= "{end_date}"
  AND campaign.advertising_channel_type = "DEMAND_GEN"
-- SQLSTYLE: Notice that semi-colon (;) at the end of the script is not allowed by gaarf.
