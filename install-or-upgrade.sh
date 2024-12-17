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

#TODO: Request region from user prompt and provide it to gaarf later:
DEFAULT_MULTI_REGION="EU"
GCP_REGION="europe-west1"

GCP_PROJECT_ID=$(gcloud config get-value project) && \
GCP_PROJECT_NUMBER=$(gcloud projects list \
  --filter="projectId:$GCP_PROJECT_ID" \
  --format="value(PROJECT_NUMBER)")

SERVICE_ACCOUNT_EMAIL=$GCP_PROJECT_NUMBER-compute@developer.gserviceaccount.com

# Call sub-scripts and pass variables as arguments
./00-setup-permissions.sh "$GCP_PROJECT_ID" "$SERVICE_ACCOUNT_EMAIL"
./01-exchange-rates.sh "$DEFAULT_MULTI_REGION" "$GCP_REGION" "$GCP_PROJECT_ID" "$SERVICE_ACCOUNT_EMAIL"
./02-youtube-aspect-ratio.sh "$GCP_REGION" "$GCP_PROJECT_ID" "$SERVICE_ACCOUNT_EMAIL"
./03-ai-bubbles.sh "$DEFAULT_MULTI_REGION" "$GCP_REGION" "$GCP_PROJECT_ID" "$SERVICE_ACCOUNT_EMAIL"
./04-gaarf-installation.sh