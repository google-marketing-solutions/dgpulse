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

GCP_REGION=$1
GCP_PROJECT_ID=$2
SERVICE_ACCOUNT_EMAIL=$3

# step into youtube_aspect_ratio_fetcher with sub project scripts.
cd youtube_aspect_ratio_fetcher


# create and store Youtube Data API Key for later usage.
echo "----"
echo "Creating a YouTube API key"
echo "Estimated time: 10 seconds"

# Hack: Currently, the "api-keys create" does not return anything
# but the api key value is printed in the logs.
# Create the new API key.
YOUTUBE_KEY_CREATE_LOGS=$(gcloud alpha services api-keys create \
    --api-target=service=youtube.googleapis.com \
    --display-name="Youtube API Key for Demand Gen Pulse" \
    2>&1)

# Extract the API key value from the logs.
API_KEY=$(echo "$YOUTUBE_KEY_CREATE_LOGS" | grep -oP '"keyString":"\K[^"]+')

echo "New API key created: ${API_KEY_NAME}"
echo "API Key: ${API_KEY}"






# install youtube_aspect_ratio_fetcher function
echo "----"
echo "Deploying Run function for Youtube aspect ratio fetcher"
echo "Estimated time: Less than 5 minutes"
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

YOUTUBE_RATIO_FUNCTION_URL=$(gcloud functions describe \
  dgpulse-youtube-aspect-ratio-fetcher \
  --gen2 \
  --region="$GCP_REGION" \
  --format='value(serviceConfig.uri)'\
)

# install youtube_aspect_ratio_fetcher scheduler that calls function
echo "----"
echo "Deploying Scheduler job for dgpulse-youtube-aspect-ratio-fetcher"
echo "Estimated time: 30 seconds"
YOUTUBE_JOB_NAME="dgpulse-youtube-aspect-ratio-fetcher-job"
if ! gcloud scheduler jobs describe $YOUTUBE_JOB_NAME --location=$GCP_REGION > /dev/null 2>&1; then
  gcloud scheduler jobs create http $YOUTUBE_JOB_NAME \
    --location=$GCP_REGION \
    --http-method="GET" \
    --schedule="0 5 * * *" \
    --uri=$YOUTUBE_RATIO_FUNCTION_URL \
    --oidc-service-account-email=$SERVICE_ACCOUNT_EMAIL \
    --oidc-token-audience=$YOUTUBE_RATIO_FUNCTION_URL
else
  echo "Job already exists."
fi



# step back one level.
cd ..