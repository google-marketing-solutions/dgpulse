#!/bin/bash
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
set -e

echo "Tracking 'Installation Completed'..."

COLLECT_BASE_URL="https://www.google-analytics.com/mp/collect"
MEASUREMENT_ID="G-3E6WG3C5TD"
API_SECRET="X9fYuV5eSvuJeE1Au_NK-A"

CLIENT_ID=""
if [ -f "google-ads.yaml" ]; then
  CLIENT_ID=$(grep -v '^[[:space:]]*#' google-ads.yaml | grep 'login_customer_id' | head -n 1 | cut -d ':' -f2 | tr -d " '\"\r")
fi

if [ -z "$CLIENT_ID" ]; then
  read -p "What's the highest level google ads account you'll use dgpulse for? " CLIENT_ID
fi

PAYLOAD=$(cat <<EOF
{
  "client_id": "${CLIENT_ID}",
  "events": [{
    "name": "installation_completed",
    "params": {
      "solutions_name": "dgpulse",
      "gads_external_ads_account_id": "${CLIENT_ID}"
    }
  }]
}
EOF
)

curl -s -X POST \
  "${COLLECT_BASE_URL}?measurement_id=${MEASUREMENT_ID}&api_secret=${API_SECRET}" \
  -H "Content-Type: application/json" \
  -d "${PAYLOAD}"

# --- Telemetry Hub: one SOLUTION_USAGE event per Demand Gen account, sent
# with the tadau library (see telemetry_hub.py). Accounts are discovered with
# get-accounts.sql via gaarf, exactly like the data pipeline. Fail-open: any
# failure below is logged and ignored so it can never break the installation.
echo "Tracking Telemetry Hub 'SOLUTION_USAGE'..."
export TELEMETRY_HUB_API_SECRET="${TELEMETRY_HUB_API_SECRET:-S7toNnNZQPWzViq44q_8gg}"
export TELEMETRY_HUB_MEASUREMENT_ID="${TELEMETRY_HUB_MEASUREMENT_ID:-G-Z2TKLQZ79K}"
# Optional, Googler-assisted deployments only: export ROPPS_URL (Connect Sales
# opportunity URL) or OPPORTUNITY_ID before running the installer.
(
  set +e
  python3 -m pip install --quiet --user -r requirements.txt
  python3 telemetry_hub.py
) || echo "Telemetry Hub tracking skipped (non-fatal)."
