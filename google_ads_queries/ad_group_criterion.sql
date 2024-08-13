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
 This script will be used by gaarf to fetch Audience Performance data
 for a given date range from Google Ads API and store in a BQ Table.
 
 @param {start_date} The start date of the date range.
 @param {end_date} The end date of the date range.
 */
SELECT
  ad_group_criterion.criterion_id AS criterion_id,
  ad_group_criterion.user_list.user_list ~ 0 AS user_list_id
FROM
  ad_group_criterion
WHERE
  ad_group_criterion.type = 'USER_LIST'
  AND user_list.type = 'LOOKALIKE'
  AND ad_group_criterion.status = 'ENABLED' -- SQLSTYLE: Notice that semi-colon (;) at the end of the script is not allowed by gaarf.