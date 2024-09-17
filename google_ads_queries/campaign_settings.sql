# Copyright 2024 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#   https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.



SELECT
  segments.date AS date,
  customer.id AS account_id,
  customer.descriptive_name AS account_name,
  campaign.id AS campaign_id,
  campaign.name AS campaign_name,
  campaign.shopping_setting.disable_product_feed AS shopping_disable_product_feed,
  campaign.shopping_setting.merchant_id AS shopping_merchant_id,
  campaign.bidding_strategy_type AS bidding_strategy,
  campaign_budget.amount_micros AS budget_amount,

  -- for tRoas calculation:
  bidding_strategy.maximize_conversion_value.target_roas AS bidding_strategy_mcv_troas,
  bidding_strategy.target_roas.target_roas AS bidding_strategy_troas,
  campaign.maximize_conversion_value.target_roas AS campaign_mcv_troas,
  campaign.target_roas.target_roas AS campaign_troas,

  -- for tCpa calculation:
  bidding_strategy.maximize_conversions.target_cpa_micros AS bidding_strategy_mc_tcpa,
  bidding_strategy.target_cpa.target_cpa_micros AS bidding_strategy_tcpa,
  campaign.maximize_conversions.target_cpa_micros AS campaign_mc_tcpa,
  campaign.target_cpa.target_cpa_micros AS campaign_tcpa,
  metrics.cost_micros AS cost,
  metrics.conversions AS conversions,
  metrics.conversions_value AS conversions_value,
  metrics.all_conversions_value AS all_conversions_value
FROM campaign
WHERE
  campaign.advertising_channel_type = "DEMAND_GEN"
  AND segments.date >= "{start_date}"
  AND segments.date <= "{end_date}"