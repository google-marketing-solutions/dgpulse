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

DEFAULT_MULTI_REGION=$1
GCP_REGION=$2
GCP_PROJECT_ID=$3
SERVICE_ACCOUNT_EMAIL=$4


echo "Creating Dataset and Table for AI Bubbles"
echo "Estimated time: 5 seconds"
# Check if the dataset exists
if bq --location=$DEFAULT_MULTI_REGION show --dataset dgpulse_ads_bq; then
  echo "Dataset already exists."
else
  # Create the dataset if it does not exist
  bq --location=$DEFAULT_MULTI_REGION mk -d dgpulse_ads_bq
fi

# Create the insights table
bq mk \
  -t \
  dgpulse_ads_bq.insights \
  table:STRING,insights:STRING,headline:STRING,date:DATE

# step into ai_bubbles with sub project scripts.
cd ai_bubbles



# create and store Gemini API Key for later usage.
echo "----"
echo "Creating a Gemini API key"
echo "Estimated time: 10 seconds"
# Hack: Currently, the "api-keys create" does not return anything
# but the api key value is printed in the logs.

# Create the new API key.
GEMINI_KEY_CREATE_LOGS=$(gcloud alpha services api-keys create \
    --api-target=service=cloudaicompanion.googleapis.com \
    --api-target=service=generativelanguage.googleapis.com \
    --display-name="Gemini API Key for Demand Gen Pulse" \
    2>&1)

# Extract the API key value from the logs.
GEMINI_API_KEY=$(echo "$GEMINI_KEY_CREATE_LOGS" | grep -oP '"keyString":"\K[^"]+')

echo "API Key created: ${GEMINI_API_KEY}"





# install dgpulse-ai-bubbles function
echo "----"
echo "Deploying Run function for AI Bubbles"
echo "Estimated time: Less than 5 minutes"
gcloud functions deploy dgpulse-ai-bubbles \
  --gen2 \
  --runtime=nodejs20 \
  --region=$GCP_REGION \
  --source=. \
  --entry-point=aiBubblesGET \
  --trigger-http \
  --no-allow-unauthenticated \
  --timeout=3600 \
  --set-env-vars GEMINI_API_KEY=$GEMINI_API_KEY,GCP_PROJECT_ID=$GCP_PROJECT_ID
  
AI_BUBBLES_FUNCTION_URL=$(gcloud functions describe \
  dgpulse-ai-bubbles \
  --gen2 \
  --region="$GCP_REGION" \
  --format='value(serviceConfig.uri)'\
)






# install dgpulse-ai-bubbles scheduler that calls function
echo "----"
echo "Deploying Scheduler job for dgpulse-ai-bubbles"
echo "Estimated time: 30 seconds"
AI_BUBBLES_JOB_NAME="dgpulse-ai-bubbles-job"
if ! gcloud scheduler jobs describe $AI_BUBBLES_JOB_NAME --location=$GCP_REGION > /dev/null 2>&1; then
  gcloud scheduler jobs create http $AI_BUBBLES_JOB_NAME \
    --location=$GCP_REGION \
    --http-method="GET" \
    --schedule="0 6 * * *" \
    --uri=$AI_BUBBLES_FUNCTION_URL \
    --oidc-service-account-email=$SERVICE_ACCOUNT_EMAIL \
    --oidc-token-audience=$AI_BUBBLES_FUNCTION_URL
else
  echo "Job already exists."
fi









# step back one level since our function is ready.
cd ..