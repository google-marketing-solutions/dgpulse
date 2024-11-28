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

#TODO: Allow for user customization during setup
SERVICE_ACCOUNT_EMAIL=$GCP_PROJECT_NUMBER-compute@developer.gserviceaccount.com




# START: Permissions to Service Account:


echo "Setting permissions to Service Account:"
echo "Estimated time: Less than 1 minute"
# Artifact registry administrator
gcloud projects add-iam-policy-binding $GCP_PROJECT_ID \
    --member serviceAccount:$SERVICE_ACCOUNT_EMAIL \
    --role="roles/artifactregistry.admin"

# Logs Writer
gcloud projects add-iam-policy-binding $GCP_PROJECT_ID \
    --member serviceAccount:$SERVICE_ACCOUNT_EMAIL \
    --role="roles/logging.logWriter"

# Storage object viewer
gcloud projects add-iam-policy-binding $GCP_PROJECT_ID \
    --member serviceAccount:$SERVICE_ACCOUNT_EMAIL \
    --role="roles/storage.objectViewer"

# Cloud Build Editor
gcloud projects add-iam-policy-binding $GCP_PROJECT_ID \
    --member serviceAccount:$SERVICE_ACCOUNT_EMAIL \
    --role="roles/cloudbuild.builds.editor"

# Cloud Run Invoker
gcloud projects add-iam-policy-binding $GCP_PROJECT_ID \
    --member serviceAccount:$SERVICE_ACCOUNT_EMAIL \
    --role="roles/run.invoker"

# Cloud Functions invoker
gcloud projects add-iam-policy-binding $GCP_PROJECT_ID \
    --member serviceAccount:$SERVICE_ACCOUNT_EMAIL \
    --role="roles/cloudfunctions.invoker"

# Cloud Functions Deployment Builder
gcloud projects add-iam-policy-binding $GCP_PROJECT_ID \
 --member serviceAccount:$SERVICE_ACCOUNT_EMAIL \
 --role="roles/cloudbuild.builds.builder"

# BigQuery Data Editor
gcloud projects add-iam-policy-binding $GCP_PROJECT_ID \
    --member serviceAccount:$SERVICE_ACCOUNT_EMAIL \
    --role="roles/bigquery.dataEditor"


# END: Permissions to Service Account.








# START: exchange-rates-fetcher setup.



echo "Creating Dataset for reference data and Table for Exchange Rates"
echo "Estimated time: 5 seconds"
# Check if the dataset exists
if bq --location=$DEFAULT_MULTI_REGION show --dataset dgpulse_ads_reference_data; then
  echo "Dataset already exists."
else
  # Create the dataset if it does not exist
  bq --location=$DEFAULT_MULTI_REGION mk -d dgpulse_ads_reference_data
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

# Create the new API key.
YOUTUBE_KEY_CREATE_LOGS=$(gcloud alpha services api-keys create \
    --api-target=service=youtube.googleapis.com \
    --display-name="Youtube API Key for Demand Gen Pulse" \
    2>&1)

# Extract the API key value from the logs.
YOUTUBE_API_KEY=$(echo "$YOUTUBE_KEY_CREATE_LOGS" | grep -oP '"keyString":"\K[^"]+')

echo "API Key created: ${YOUTUBE_API_KEY}"






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
  --set-env-vars YOUTUBE_API_KEY=$YOUTUBE_API_KEY,GCP_PROJECT_ID=$GCP_PROJECT_ID

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





# START: dgpulse-ai-bubbles setup.



echo "Creating Dataset for reference data and Table for AI Bubbles"
echo "Estimated time: 5 seconds"
# Check if the dataset exists
if bq --location=$DEFAULT_MULTI_REGION show --dataset dgpulse_ads_ai_bubbles; then
  echo "Dataset already exists."
else
  # Create the dataset if it does not exist
  bq --location=$DEFAULT_MULTI_REGION mk -d dgpulse_ads_ai_bubbles
  # Create the exchange_rates table
  bq mk \
    -t \
    dgpulse_ads_ai_bubbles.insights \
    table:STRING,insights:STRING,date:DATE
fi

# step into youtube_aspect_ratio_fetcher with sub project scripts.
cd ai_bubbles



# create and store Youtube Data API Key for later usage.
echo "----"
echo "Creating a Gemini API key"
echo "Estimated time: 10 seconds"
# Hack: Currently, the "api-keys create" does not return anything
# but the api key value is printed in the logs.

# Create the new API key.
GEMINI_KEY_CREATE_LOGS=$(gcloud alpha services api-keys create \
    --api-target=service=cloudaicompanion.googleapis.com \
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
  --set-env-vars YOUTUBE_API_KEY=$GEMINI_API_KEY,GCP_PROJECT_ID=$GCP_PROJECT_ID
  
AI_BUBBLES_FUNCTION_URL=$(gcloud functions describe \
  dgpulse-youtube-aspect-ratio-fetcher \
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



# END: dgpulse-ai-bubbles setup.







# START: GAARF Installation

echo "----"
echo "Initializing Google Ads data ETL Workflow..."
echo "Estimated time: 10 minutes"
npm init gaarf-wf@latest -- --answers=answers.json


# END: GAARF Installation