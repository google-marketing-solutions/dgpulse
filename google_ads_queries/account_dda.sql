-- Copyright 2025 Google LLC
--
-- Licensed under the Apache License, Version 2.0 (the "License");
-- you may not use this file except in compliance with the License.
-- You may obtain a copy of the License at
--
--     https://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing, software
-- distributed under the License is distributed on an "AS IS" BASIS,
-- WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
-- See the License for the specific language governing permissions and
-- limitations under the License.


SELECT
    customer.id AS account_id,
    conversion_action.attribution_model_settings.attribution_model AS dda_conversion_action,
    conversion_action.name AS conversion_action_name,
    conversion_action.id AS conversion_action_id
FROM
    conversion_action
WHERE
    conversion_action.attribution_model_settings.attribution_model = "GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN"
    AND conversion_action.status = "ENABLED"
