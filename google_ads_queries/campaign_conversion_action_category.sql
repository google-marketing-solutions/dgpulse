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
  campaign.id AS campaign_id,
  segments.conversion_action_category AS conversion_action_category,
  segments.conversion_action_name AS conversion_action_name,
  segments.conversion_action AS conversion_action,
  metrics.all_conversions AS number_of_conversions
FROM campaign
WHERE
  campaign.advertising_channel_type = "DEMAND_GEN"
  AND segments.conversion_action_category != "DEFAULT"
  AND campaign.status = "ENABLED"
  AND segments.date >= "{start_date}"
  AND segments.date <= "{end_date}"
