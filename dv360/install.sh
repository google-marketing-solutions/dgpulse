#!/bin/bash
# DV360 Pulse Installation Script
# This script automates the deployment to Google Cloud Run and GCS.

set -e

echo "------------------------------------------------"
echo "DV360 DG Pulse - Installation Script"
echo "------------------------------------------------"

# 1. Ask for user inputs (or use env vars if provided)
if [ -z "$PARTNER_ID" ]; then
  read -p "Enter Partner ID: " PARTNER_ID
fi



# Auto-detect client_id and client_secret from client_secret.json if present
if [ -f "client_secret.json" ] && [ -s "client_secret.json" ]; then
  echo "Found client_secret.json. Attempting to extract credentials..."
  
  if [ -z "$CLIENT_ID" ]; then
    CLIENT_ID=$(node -e "try { const d=require('fs').readFileSync('client_secret.json'); const c=JSON.parse(d).installed||JSON.parse(d).web||JSON.parse(d); console.log(c.client_id||''); } catch(e) { process.exit(0); }" 2>/dev/null || true)
    if [ -n "$CLIENT_ID" ]; then
      echo "Using Client ID from client_secret.json"
    fi
  fi
  
  if [ -z "$CLIENT_SECRET" ]; then
    CLIENT_SECRET=$(node -e "try { const d=require('fs').readFileSync('client_secret.json'); const c=JSON.parse(d).installed||JSON.parse(d).web||JSON.parse(d); console.log(c.client_secret||''); } catch(e) { process.exit(0); }" 2>/dev/null || true)
    if [ -n "$CLIENT_SECRET" ]; then
      echo "Using Client Secret from client_secret.json"
    fi
  fi
fi

if [ -z "$CLIENT_ID" ]; then
  read -p "Enter Client ID: " CLIENT_ID
fi
if [ -z "$CLIENT_SECRET" ]; then
  read -p "Enter Client Secret: " CLIENT_SECRET
fi
if [ -z "$REFRESH_TOKEN" ]; then
  read -p "Enter Refresh Token: " REFRESH_TOKEN
fi

# 2. Infer project ID and region
PROJECT_ID=$(gcloud config get-value project)
REGION="us-central1"
NODE_VERSION="22"

echo "Using Project ID: ${PROJECT_ID}"
echo "Using Region: ${REGION}"

# Enable necessary APIs
echo "Enabling necessary APIs..."
gcloud services enable \
  artifactregistry.googleapis.com \
  cloudfunctions.googleapis.com \
  run.googleapis.com \
  cloudscheduler.googleapis.com \
  storage.googleapis.com \
  displayvideo.googleapis.com \
  doubleclickbidmanager.googleapis.com \
  bigquerydatatransfer.googleapis.com \
  eventarc.googleapis.com \
  eventarcpublishing.googleapis.com --project="${PROJECT_ID}"

# 3. Create client_secret.json locally if it doesn't exist
if [ ! -f "client_secret.json" ]; then
  echo "Generating client_secret.json..."
  cat <<EOF > client_secret.json
{
  "installed": {
    "client_id": "${CLIENT_ID}",
    "project_id": "${PROJECT_ID}",
    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
    "token_uri": "https://oauth2.googleapis.com/token",
    "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
    "client_secret": "${CLIENT_SECRET}",
    "redirect_uris": ["http://localhost"]
  }
}
EOF
else
  echo "client_secret.json already exists. Skipping generation."
fi

# 4. Create GCS bucket and upload file
BUCKET_NAME="${PROJECT_ID}-dv360-dgpulse"
echo "Creating GCS bucket: ${BUCKET_NAME}..."
# Check if bucket exists, if not create it
if ! gsutil ls -b gs://${BUCKET_NAME} > /dev/null 2>&1; then
  gsutil mb -l ${REGION} gs://${BUCKET_NAME}
else
  echo "Bucket already exists."
fi

echo "Uploading client_secret.json to GCS..."
gsutil cp client_secret.json gs://${BUCKET_NAME}/client_secret.json

echo "Installing Node.js dependencies..."
npm install

echo "Setting up daily DBM performance report query..."
BUCKET_NAME="${BUCKET_NAME}" REFRESH_TOKEN="${REFRESH_TOKEN}" PARTNER_ID="${PARTNER_ID}" node create_report.js

# 4b. Create Pub/Sub Topic and BigQuery Dataset/Table
TOPIC_NAME="dv360-dgpulse-advertiser-topic"
echo "Creating Pub/Sub topic: ${TOPIC_NAME}..."
gcloud pubsub topics create ${TOPIC_NAME} || echo "Topic already exists."

DATASET_ID="dv360_dgpulse"
TABLE_ID="campaigns"
echo "Creating BigQuery dataset: ${DATASET_ID}..."
bq mk --dataset --location=${REGION} ${PROJECT_ID}:${DATASET_ID} || echo "Dataset already exists."

echo "Creating BigQuery table: ${DATASET_ID}.advertisers..."
bq mk --table ${PROJECT_ID}:${DATASET_ID}.advertisers \
  advertiserId:STRING,displayName:STRING,entityStatus:STRING,partnerId:STRING,currencyCode:STRING,cmFloodlightConfigId:STRING,cmFloodlightLinkingAuthorized:BOOLEAN || echo "Table advertisers already exists."
bq query --use_legacy_sql=false "ALTER TABLE \`${PROJECT_ID}.${DATASET_ID}.advertisers\` ADD COLUMN IF NOT EXISTS currencyCode STRING;" 2>/dev/null || true

echo "Creating BigQuery table: ${DATASET_ID}.advertiser_settings..."
bq mk --table ${PROJECT_ID}:${DATASET_ID}.advertiser_settings \
  advertiserId:STRING,displayName:STRING,partnerId:STRING,currency_code:STRING,has_crm_audience:STRING,has_ga_audience:STRING,floodlight_optimization_enabled:STRING,auto_tagging_enabled:STRING,ec_enabled:STRING,gtg_status:STRING,web_tag_type:STRING || echo "Table advertiser_settings already exists."
bq query --use_legacy_sql=false "ALTER TABLE \`${PROJECT_ID}.${DATASET_ID}.advertiser_settings\` ADD COLUMN IF NOT EXISTS currency_code STRING;" 2>/dev/null || true

echo "Creating BigQuery table: ${DATASET_ID}.${TABLE_ID}..."
bq mk --table ${PROJECT_ID}:${DATASET_ID}.${TABLE_ID} campaignId:STRING,advertiserId:STRING,entityStatus:STRING,displayName:STRING || echo "Table already exists."

echo "Creating BigQuery table: ${DATASET_ID}.dbm_performance..."
bq mk --table ${PROJECT_ID}:${DATASET_ID}.dbm_performance \
  Report_Day:DATE,Partner:STRING,Partner_Id:INTEGER,Advertiser:STRING,Advertiser_Id:INTEGER,Advertiser_Currency:STRING,Media_Plan:STRING,Media_Plan_Id:INTEGER,Insertion_Order:STRING,Insertion_Order_Id:INTEGER,Creative_Id:INTEGER,Device_Type:STRING,Inventory_Source:STRING,Revenue:FLOAT,Revenue_USD:FLOAT,Impressions:INTEGER,Clicks:INTEGER,Total_Conversions:FLOAT,Active_View_Viewable_Impressions:INTEGER,Active_View_Measurable_Impressions:INTEGER,Active_View_Eligible_Impressions:INTEGER,TrueView_Views:INTEGER,Video_Plays:INTEGER,Video_First_Quartile_Completes:INTEGER,Video_Midpoints:INTEGER,Video_Third_Quartile_Completes:INTEGER,Video_Completions:INTEGER,Video_Completion_Rate:FLOAT,Post_Click_Conversions:FLOAT,Post_View_Conversions:FLOAT,CM_Post_Click_Revenue:FLOAT,CM_Post_View_Revenue:FLOAT,Percentage_From_Current_IO_Goal:FLOAT,TrueView_Lost_IS_Budget:FLOAT,TrueView_Lost_IS_Rank:FLOAT || echo "Table dbm_performance already exists."
bq query --use_legacy_sql=false "ALTER TABLE \`${PROJECT_ID}.${DATASET_ID}.dbm_performance\` ADD COLUMN IF NOT EXISTS Revenue_USD FLOAT64;" 2>/dev/null || true

echo "Creating BigQuery table: ${DATASET_ID}.insertion_orders..."
bq mk --table ${PROJECT_ID}:${DATASET_ID}.insertion_orders \
  insertionOrderId:STRING,advertiserId:STRING,campaignId:STRING,displayName:STRING,entityStatus:STRING,pacingType:STRING,pacingPeriod:STRING,dailyMaxAmount:FLOAT,budgetUnit:STRING,automationType:STRING,budgetAmount:FLOAT,startDate:DATE,endDate:DATE || echo "Table insertion_orders already exists."

echo "Creating BigQuery table: ${DATASET_ID}.line_items..."
bq mk --table ${PROJECT_ID}:${DATASET_ID}.line_items \
  lineItemId:STRING,campaignId:STRING,advertiserId:STRING,entityStatus:STRING,displayName:STRING,lineItemType:STRING || echo "Table line_items already exists."

echo "Creating BigQuery table: ${DATASET_ID}.creatives..."
bq mk --table ${PROJECT_ID}:${DATASET_ID}.creatives \
  creativeId:STRING,advertiserId:STRING,entityStatus:STRING,displayName:STRING,creativeType:STRING,hostingSource:STRING,dimensions:STRING,imageUrl:STRING || echo "Table creatives already exists."

echo "Creating BigQuery table: ${DATASET_ID}.floodlight_activities..."
bq mk --table ${PROJECT_ID}:${DATASET_ID}.floodlight_activities \
  floodlightActivityId:STRING,advertiserId:STRING,partnerId:STRING,floodlightGroupId:STRING,activityName:STRING,servingStatus:STRING,webTagType:STRING,tagModernizationStatus:STRING,clickLookbackDays:INTEGER,impressionLookbackDays:INTEGER,attributionLookbackStatus:STRING,sslRequired:STRING,sslComplianceStatus:STRING,remarketingEnabled:STRING,auditDate:DATE || echo "Table floodlight_activities already exists."


# 5. Deploy as a Cloud Run Function
echo "Deploying Cloud Function: dv360-dgpulse..."
gcloud functions deploy dv360-dgpulse \
  --gen2 \
  --runtime=nodejs${NODE_VERSION} \
  --region=${REGION} \
  --source=. \
  --entry-point=fetchAdvertisers \
  --trigger-http \
  --no-allow-unauthenticated \
  --set-env-vars BUCKET_NAME=${BUCKET_NAME},REFRESH_TOKEN=${REFRESH_TOKEN},PARTNER_ID=${PARTNER_ID},TOPIC_NAME=${TOPIC_NAME}

# 6. Get the service URL
SERVICE_URL=$(gcloud functions describe dv360-dgpulse --region=${REGION} --gen2 --format='value(serviceConfig.uri)')
echo "Service URL: ${SERVICE_URL}"

PROJECT_NUMBER=$(gcloud projects describe ${PROJECT_ID} --format='value(projectNumber)')
SERVICE_ACCOUNT="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

# Ensure the Cloud Scheduler service account has permission to invoke the service via OIDC
echo "Granting run.invoker to ${SERVICE_ACCOUNT}..."
gcloud run services add-iam-policy-binding dv360-dgpulse \
  --region=${REGION} \
  --member="serviceAccount:${SERVICE_ACCOUNT}" \
  --role="roles/run.invoker" > /dev/null 2>&1 || true

# 6b. Deploy Cloud Function for processing advertisers
echo "Deploying Cloud Function: process-advertiser..."
gcloud functions deploy dv360-dgpulse-process-advertiser \
  --gen2 \
  --runtime=nodejs${NODE_VERSION} \
  --region=${REGION} \
  --source=. \
  --entry-point=processAdvertiser \
  --trigger-topic=${TOPIC_NAME} \
  --set-env-vars BUCKET_NAME=${BUCKET_NAME},REFRESH_TOKEN=${REFRESH_TOKEN},DATASET_ID=${DATASET_ID},TABLE_ID=${TABLE_ID}

# 7. Create Cloud Scheduler job
JOB_NAME="dv360-dgpulse-daily-sync"
echo "Creating Cloud Scheduler job: ${JOB_NAME}..."

if ! gcloud scheduler jobs describe ${JOB_NAME} --location=${REGION} > /dev/null 2>&1; then
  gcloud scheduler jobs create http ${JOB_NAME} \
    --location=${REGION} \
    --http-method="GET" \
    --schedule="0 6 * * *" \
    --uri="${SERVICE_URL}" \
    --oidc-service-account-email=${SERVICE_ACCOUNT} \
    --oidc-token-audience="${SERVICE_URL}"
else
  echo "Job already exists. Updating..."
  gcloud scheduler jobs update http ${JOB_NAME} \
    --location=${REGION} \
    --uri="${SERVICE_URL}"
fi

echo "Running initial materialization queries..."
for sql in materialize_campaigns.sql materialize_line_items.sql materialize_insertion_orders.sql materialize_assets.sql materialize_floodlight_activities.sql; do
  echo "Materializing: $sql"
  bq query --use_legacy_sql=false "$(cat $sql | sed "s/__PROJECT_ID__/${PROJECT_ID}/g" | sed "s/__DATASET_ID__/${DATASET_ID}/g" | sed "s/__PARTNER_ID__/${PARTNER_ID}/g")" || echo "Warning: $sql initial materialization skipped (will run once API/DBM data is populated)."
done

echo "Creating Scheduled Queries for daily materialization..."
for sql_file in materialize_campaigns.sql materialize_line_items.sql materialize_insertion_orders.sql materialize_assets.sql materialize_floodlight_activities.sql; do
  view_name=$(basename "$sql_file" .sql)
  display_name="Materialize DV360 ${view_name} Daily"
  
    CONFIG_NAME=$(bq ls --transfer_config --transfer_location=${REGION} --project_id=${PROJECT_ID} --format=prettyjson 2>/dev/null | grep -B 2 "${display_name}" | grep '"name"' | head -1 | awk -F'"' '{print $4}')
    QUERY=$(cat "$sql_file" | sed "s/__PROJECT_ID__/${PROJECT_ID}/g" | sed "s/__DATASET_ID__/${DATASET_ID}/g" | sed "s/__PARTNER_ID__/${PARTNER_ID}/g")
    JSON_QUERY=$(echo "${QUERY}" | sed 's/"/\\"/g' | sed ':a;N;$!ba;s/\n/\\n/g')
    PARAMS=$(printf '{"query":"%s"}' "${JSON_QUERY}")
    
    if [ -z "${CONFIG_NAME}" ]; then
      echo "Creating transfer config for ${display_name}..."
      bq mk --transfer_config \
        --project_id="${PROJECT_ID}" \
        --data_source=scheduled_query \
        --target_dataset="${DATASET_ID}" \
        --display_name="${display_name}" \
        --params="${PARAMS}" \
        --service_account_name="${SERVICE_ACCOUNT}" \
        --schedule="every day 08:00" || echo "Warning: Failed to create transfer config for ${display_name}"
    else
      echo "Updating existing transfer config for ${display_name}..."
      bq update --transfer_config \
        --params="${PARAMS}" \
        "${CONFIG_NAME}" || echo "Warning: Failed to update transfer config for ${display_name}"
    fi
  done

LOOKER_LINK="https://lookerstudio.google.com/reporting/create?c.reportId=5e126b6a-33fc-4d0a-80cb-7ce6bc990001\
&ds.campaign_performance.connector=bigQuery&ds.campaign_performance.projectId=${PROJECT_ID}&ds.campaign_performance.datasetId=${DATASET_ID}&ds.campaign_performance.type=TABLE&ds.campaign_performance.tableId=final_campaign_performance&ds.campaign_performance.refreshFields=false\
&ds.line_items_performance.connector=bigQuery&ds.line_items_performance.projectId=${PROJECT_ID}&ds.line_items_performance.datasetId=${DATASET_ID}&ds.line_items_performance.type=TABLE&ds.line_items_performance.tableId=final_line_items_performance&ds.line_items_performance.refreshFields=false\
&ds.insertion_orders_performance.connector=bigQuery&ds.insertion_orders_performance.projectId=${PROJECT_ID}&ds.insertion_orders_performance.datasetId=${DATASET_ID}&ds.insertion_orders_performance.type=TABLE&ds.insertion_orders_performance.tableId=final_insertion_orders_performance&ds.insertion_orders_performance.refreshFields=false\
&ds.assets_performance.connector=bigQuery&ds.assets_performance.projectId=${PROJECT_ID}&ds.assets_performance.datasetId=${DATASET_ID}&ds.assets_performance.type=TABLE&ds.assets_performance.tableId=final_assets_performance&ds.assets_performance.refreshFields=false\
&ds.floodlight_audit.connector=bigQuery&ds.floodlight_audit.projectId=${PROJECT_ID}&ds.floodlight_audit.datasetId=${DATASET_ID}&ds.floodlight_audit.type=TABLE&ds.floodlight_audit.tableId=final_floodlight_activities_audit&ds.floodlight_audit.refreshFields=false"

echo "------------------------------------------------"
echo "🎉 Installation & Deployment Complete!"
echo "Your DV360 DG Pulse service is deployed at: ${SERVICE_URL}"
echo "The daily sync job is scheduled to run at 6:00 AM daily."
echo ""
echo "================================================================="
echo "📊 One-Click Looker Studio Dashboard Connection:"
echo "Click the link below to automatically clone the report template and"
echo "connect all 5 BigQuery tables for Partner ${PARTNER_ID}:"
echo ""
echo "${LOOKER_LINK}"
echo "================================================================="