# Copyright 2024 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.


SELECT
  customer.id AS account_id,
  change_event.change_date_time AS date,
  campaign.id AS campaign_id
FROM change_event
WHERE
  -- This needs to be set as static 29 days sliding window.
  -- change_event cannot be queried for longer than that.
  change_event.change_date_time >= '${today()-period('P29D')}' 
  AND change_event.change_date_time <= '${today()}'
  AND change_event.resource_change_operation = 'UPDATE'
  AND campaign.advertising_channel_type = 'DEMAND_GEN'
  AND campaign.status = 'ENABLED'
LIMIT 10000
