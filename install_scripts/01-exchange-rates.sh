#!/bin/bash
# Copyright 2025 Google LLC
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

DEFAULT_MULTI_REGION=$1
GCP_REGION=$2
GCP_PROJECT_ID=$3
SERVICE_ACCOUNT_EMAIL=$4


echo "----"
echo "Creating Dataset for reference data and Table for Exchange Rates"
echo "Estimated time: 5 seconds"

# Check if the dataset exists
if bq --location="$DEFAULT_MULTI_REGION" show --dataset "${GCP_PROJECT_ID}:dgpulse_ads_reference_data" > /dev/null 2>&1; then
  echo "Dataset already exists."
else
  # Create the dataset if it does not exist
  bq --location="$DEFAULT_MULTI_REGION" mk -d "${GCP_PROJECT_ID}:dgpulse_ads_reference_data"
fi

# Ensure the exchange_rates table exists
if ! bq show "${GCP_PROJECT_ID}:dgpulse_ads_reference_data.exchange_rates" > /dev/null 2>&1; then
  bq mk \
    -t \
    "${GCP_PROJECT_ID}:dgpulse_ads_reference_data.exchange_rates" \
    base_currency:STRING,target_currency:STRING,rate:FLOAT,date:DATE
fi

# Create a dedicated least-privilege service account for exchange_rates_fetcher
FX_SA_NAME="dgpulse-fx-fetcher"
FX_SA_EMAIL="${FX_SA_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"

if ! gcloud iam service-accounts describe "$FX_SA_EMAIL" --project="$GCP_PROJECT_ID" > /dev/null 2>&1; then
  gcloud iam service-accounts create "$FX_SA_NAME" \
    --project="$GCP_PROJECT_ID" \
    --display-name="DGPulse Exchange Rates Fetcher"
fi

# Grant minimal project-level roles (job execution + logging only; no project-wide dataEditor)
gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
  --member="serviceAccount:$FX_SA_EMAIL" \
  --condition=None \
  --role="roles/bigquery.jobUser"

gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
  --member="serviceAccount:$FX_SA_EMAIL" \
  --condition=None \
  --role="roles/logging.logWriter"

# Restrict BigQuery dataEditor strictly to dgpulse_ads_reference_data.exchange_rates
bq add-iam-policy-binding \
  --member="serviceAccount:$FX_SA_EMAIL" \
  --role="roles/bigquery.dataEditor" \
  "${GCP_PROJECT_ID}:dgpulse_ads_reference_data.exchange_rates"


# step into exchange_rates folder with sub project scripts.
cd exchange_rates_fetcher


# install dgpulse-exchange-rates-fetcher function under dedicated service account.
echo "----"
echo "Deploying Run function for Exchange Rates"
echo "Estimated time: Less than 5 minutes"
gcloud functions deploy dgpulse-exchange-rates-fetcher \
  --gen2 \
  --runtime=nodejs22 \
  --region="$GCP_REGION" \
  --project="$GCP_PROJECT_ID" \
  --service-account="$FX_SA_EMAIL" \
  --source=. \
  --entry-point=exchangeRatesGET \
  --trigger-http \
  --no-allow-unauthenticated \
  --timeout=3600 \
  --set-env-vars "GCP_PROJECT_ID=$GCP_PROJECT_ID"

gcloud functions add-invoker-policy-binding dgpulse-exchange-rates-fetcher \
  --region="$GCP_REGION" \
  --project="$GCP_PROJECT_ID" \
  --member="serviceAccount:$SERVICE_ACCOUNT_EMAIL"

EXCHANGE_RATES_FUNCTION_URL=$(gcloud functions describe \
  dgpulse-exchange-rates-fetcher \
  --gen2 \
  --region="$GCP_REGION" \
  --project="$GCP_PROJECT_ID" \
  --format='value(serviceConfig.uri)'\
)

# install dgpulse-exchange-rates-fetcher scheduler that calls function.
echo "----"
echo "Deploying Scheduler job for dgpulse-exchange-rates-fetcher"
echo "Estimated time: 5 seconds"
X_RATES_JOB_NAME="dgpulse-exchange-rates-fetcher-job"
if ! gcloud scheduler jobs describe "$X_RATES_JOB_NAME" --location="$GCP_REGION" --project="$GCP_PROJECT_ID" > /dev/null 2>&1; then
  gcloud scheduler jobs create http "$X_RATES_JOB_NAME" \
    --location="$GCP_REGION" \
    --project="$GCP_PROJECT_ID" \
    --http-method="GET" \
    --schedule="0 0 1 * *" \
    --uri="$EXCHANGE_RATES_FUNCTION_URL" \
    --oidc-service-account-email="$SERVICE_ACCOUNT_EMAIL" \
    --oidc-token-audience="$EXCHANGE_RATES_FUNCTION_URL"
else
  echo "Job already exists."
fi


echo "Running dgpulse-exchange-rates-fetcher-job for the 1st time"
echo "Estimated time: 5 seconds"
gcloud scheduler jobs run dgpulse-exchange-rates-fetcher-job \
  --location="$GCP_REGION" \
  --project="$GCP_PROJECT_ID"


# step back one level since our function is ready.
cd ..
