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

GCP_PROJECT_ID=$(gcloud config get-value project) && \
GCP_PROJECT_NUMBER=$(gcloud projects list \
  --filter="projectId:$GCP_PROJECT_ID" \
  --format="value(PROJECT_NUMBER)")

#TODO: Allow for user customization during setup
SERVICE_ACCOUNT_EMAIL=$GCP_PROJECT_NUMBER-compute@developer.gserviceaccount.com

#TODO: Request region from user prompt and provide it to gaarf later:
GCP_REGION="europe-west1"




# START: exchange-rates-fetcher setup.



# TODO: create dataset and table for currency exchange rates (reference data)
echo "Creating Dataset for reference data and Table for Exchange Rates"
echo "Estimated time: 5 seconds"
# Check if the dataset exists
if bq --location=EU show --dataset dgpulse_ads_reference_data; then
  echo "Dataset already exists."
else
  # Create the dataset if it does not exist
  bq --location=EU mk -d dgpulse_ads_reference_data
  # Create the exchange_rates table
  bq mk \
    -t \
    dgpulse_ads_reference_data.exchange_rates \
    base_currency:STRING,target_currency:STRING,rate:FLOAT,date:DATE
fi





# step into exchange_rates folder with sub project scripts.
cd exchange_rates_fetcher


# install dgpulse-exchange-rates-fetcher function.
echo "----"
echo "Deploying Run function for Exchange Rates"
echo "Estimated time: Less than 5 minutes"
gcloud functions deploy dgpulse-exchange-rates-fetcher \
  --gen2 \
  --runtime=nodejs20 \
  --region=$GCP_REGION \
  --source=. \
  --entry-point=exchangeRatesGET \
  --trigger-http \
  --no-allow-unauthenticated \
  --timeout=3600 \
  --set-env-vars GCP_PROJECT_ID=$GCP_PROJECT_ID

EXCHANGE_RATES_FUNCTION_URL=$(gcloud functions describe \
  dgpulse-exchange-rates-fetcher \
  --gen2 \
  --region="$GCP_REGION" \
  --format='value(serviceConfig.uri)'\
)

# install dgpulse-exchange-rates-fetcher scheduler that calls function.
echo "----"
echo "Deploying Scheduler job for dgpulse-exchange-rates-fetcher"
echo "Estimated time: 5 seconds"
X_RATES_JOB_NAME="dgpulse-exchange-rates-fetcher-job"
if ! gcloud scheduler jobs describe $X_RATES_JOB_NAME --location=$GCP_REGION > /dev/null 2>&1; then
  gcloud scheduler jobs create http $X_RATES_JOB_NAME \
    --location=$GCP_REGION \
    --http-method="GET" \
    --schedule="0 0 1 * *" \
    --uri=$EXCHANGE_RATES_FUNCTION_URL \
    --oidc-service-account-email=$SERVICE_ACCOUNT_EMAIL \
    --oidc-token-audience=$EXCHANGE_RATES_FUNCTION_URL
else
  echo "Job already exists."
fi




echo "Running dgpulse-exchange-rates-fetcher-job for the 1st time"
echo "Estimated time: 5 seconds"
gcloud scheduler jobs run dgpulse-exchange-rates-fetcher-job \
  --location=$GCP_REGION


# step back one level since our function is ready.
cd ..

# END: exchange-rates-fetcher setup.










# START: youtube_aspect_ratio_fetcher setup.

# step into youtube_aspect_ratio_fetcher with sub project scripts.
cd youtube_aspect_ratio_fetcher



# create and store Youtube Data API Key for later usage.
echo "----"
echo "Creating a YouTube API key"
echo "Estimated time: 10 seconds"
# Hack: Currently, the "api-keys create" does not return anything
# but the api key value is printed in the logs.

# Generate a random short string using date and md5sum.
RANDOM_STRING=$(date +%s | md5sum | head -c 8)
API_KEY_NAME="youtube-key-${RANDOM_STRING}"

# Create the new API key.
YOUTUBE_KEY_CREATE_LOGS=$(gcloud services api-keys create \
    --api-target=service=youtube.googleapis.com \
    --key-id="${API_KEY_NAME}" \
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


# END: youtube_aspect_ratio_fetcher setup.








# START: GAARF Installation

echo "----"
echo "Initializing Google Ads data ETL Workflow..."
echo "Estimated time: 10 minutes"
npm init gaarf-wf@latest -- --answers=answers.json


# END: GAARF Installation