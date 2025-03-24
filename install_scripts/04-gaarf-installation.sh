#!/bin/bash
#
# Copyright 2024 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
set -e

echo "----"
until [[ "$yn" == [YyNn] ]]; do
    msg='We use anonymized and aggregated data to understand how DG Pulse is '
    msg+='being used and make improvements. Would you allow us to track it? '
    msg+='Please respond with 'y' for yes or 'n' for no: '
    read -p "$msg" yn
done

echo "Initializing Google Ads data ETL Workflow..."
echo "Estimated time: 10 minutes"

if [[ "$yn" == "y"  || "$yn" == "Y" ]]; then
    npm init gaarf-wf@latest -- --answers=answers-tracked-template.json
    ./install_scripts/04-1-installation-completed-tracking.sh
else
    npm init gaarf-wf@latest -- --answers=answers.json
fi