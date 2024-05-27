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

GCP_PROJECT_ID=$(gcloud config get-value project)
#TODO: Request region from user prompt and provide it to gaarf later:
GCP_REGION="europe-west1"




# create and store Youtube Data API Key for later usage
echo "\n----"
echo "Creating a YouTube API key"
echo "Estimated time: 10 seconds"
# Hack: Currently, the "api-keys create" does not return anything
# but the api key value is printed in the logs.
YOUTUBE_KEY_CREATE_LOGS=$(gcloud services api-keys create \
    --api-target=service=youtube.googleapis.com \
    --key-id="youtube-key" \
    --display-name="Youtube API Key for Demand Gen Pulse" \
    2>&1)
# The api key value is logged in "keyString":
API_KEY=$(echo "$YOUTUBE_KEY_CREATE_LOGS" | grep -oP '"keyString":"\K[^"]+')





# step into folder with sub project scripts
cd youtube_aspect_ratio_fetcher





# install youtube_aspect_ratio_fetcher function and obtain url:
echo "\n----"
echo "Deploying Run function for Youtube aspect ratio fetcher"
echo "Estimated time: 2 minutes"
gcloud functions deploy dgpulse-youtube-aspect-ratio-fetcher \
  --gen2 \
  --runtime=nodejs20 \
  --region=$GCP_REGION \
  --source=. \
  --entry-point=ytarfGET \
  --trigger-http \
  --no-allow-unauthenticated \
  --timeout=3600 \
  --set-env-vars YOUTUBE_API_KEY=$API_KEY,GCP_PROJECT_ID=$GCP_PROJECT_ID

FUNCTION_URL=$(gcloud functions describe \
  dgpulse-youtube-aspect-ratio-fetcher \
  --gen2 \
  --region="$GCP_REGION" \
  --format='value(serviceConfig.uri)'\
)




# step back one level
cd ..


 


# install youtube_aspect_ratio_fetcher workflow
echo "\n----"
echo "Deploying Workflow for dgpulse-youtube-aspect-ratio-fetcher"
echo "Estimated time: 30 seconds"
gcloud workflows deploy dgpulse-youtube-aspect-ratio-fetcher-wf \
  --source=youtube_aspect_ratio_fetcher_workflow.yaml \
  --location=$GCP_REGION


# install youtube_aspect_ratio_fetcher scheduler that calls workflow
echo "\n----"
echo "Deploying Scheduler job for dgpulse-youtube-aspect-ratio-fetcher-wf"
echo "Estimated time: 30 seconds"

WORKFLOW_NAME_PATH=$(gcloud workflows describe \
  dgpulse-youtube-aspect-ratio-fetcher-wf \
  --location=$GCP_REGION \
  --format='value(name)' \
)

SERVICE_ACCOUNT_EMAIL=$(gcloud workflows describe \
  dgpulse-youtube-aspect-ratio-fetcher-wf \
  --location=$GCP_REGION \
  --format='value(serviceAccount)' \
  | grep -E -o "\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,6}\b" \
)

gcloud scheduler jobs create http dgpulse-youtube-aspect-ratio-fetcher-wf-job \
  --location=$GCP_REGION \
  --schedule="0 3 * * *" \
  --uri="https://workflowexecutions.googleapis.com/v1/$WORKFLOW_NAME_PATH/executions" \
  --oauth-service-account-email=$SERVICE_ACCOUNT_EMAIL







# GAARF Installation:
echo "\n----"
echo "Initializing Google Ads data ETL Workflow..."
echo "Estimated time: 10 minutes"
npm init gaarf-wf@latest -- --answers=answers.json
