#!/bin/bash
#
# Copyright 2025 Google LLC
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
