#!/bin/bash
# DV360 Pulse Installation Script
# This script automates the deployment to Google Cloud Run and GCS.

set -e

echo "------------------------------------------------"
echo "DV360 DG Pulse - Installation Script"
echo "------------------------------------------------"

# 1. Partner ID must ALWAYS be manually input (never inferred from deployed resources)
if [ -n "$PARTNER_ID" ]; then
  read -p "Enter Partner ID [default: ${PARTNER_ID}]: " INPUT_PARTNER_ID
  PARTNER_ID="${INPUT_PARTNER_ID:-$PARTNER_ID}"
else
  read -p "Enter Partner ID: " PARTNER_ID
fi

while [ -z "$PARTNER_ID" ]; do
  echo "Partner ID is required. Please enter a valid Partner ID."
  read -p "Enter Partner ID: " PARTNER_ID
done

# Auto-detect existing configuration from deployed Cloud Function if env vars are empty
if [ -z "$REFRESH_TOKEN" ]; then
  EXISTING_ENV=$(gcloud functions describe dv360-dgpulse-${PARTNER_ID} --region=us-central1 --format="json(serviceConfig.environmentVariables)" 2>/dev/null || gcloud functions describe dv360-dgpulse-${PARTNER_ID} --region=us-central1 --format="json(environmentVariables)" 2>/dev/null || gcloud functions describe dv360-dgpulse --region=us-central1 --format="json(serviceConfig.environmentVariables)" 2>/dev/null || gcloud functions describe dv360-dgpulse --region=us-central1 --format="json(environmentVariables)" 2>/dev/null || true)
  if [ -n "$EXISTING_ENV" ]; then
    DETECTED_TOKEN=$(echo "$EXISTING_ENV" | grep -oP '"REFRESH_TOKEN":\s*"\K[^"]+' || true)
    if [ -n "$DETECTED_TOKEN" ]; then
      REFRESH_TOKEN="$DETECTED_TOKEN"
      echo "Detected existing Refresh Token from deployed Cloud Function."
    fi
  fi
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

# Validate detected/provided REFRESH_TOKEN before proceeding
if [ -n "$REFRESH_TOKEN" ] && [ -n "$CLIENT_ID" ] && [ -n "$CLIENT_SECRET" ]; then
  TOKEN_CHECK=$(curl -s -X POST https://oauth2.googleapis.com/token \
    -d "client_id=${CLIENT_ID}" \
    -d "client_secret=${CLIENT_SECRET}" \
    -d "refresh_token=${REFRESH_TOKEN}" \
    -d "grant_type=refresh_token" || true)
  if echo "$TOKEN_CHECK" | grep -q '"invalid_grant"'; then
    echo "⚠️ Warning: The existing Refresh Token has expired or been revoked (invalid_grant)."
    echo "Tip: Run 'node auth.js' to generate a fresh Refresh Token."
    REFRESH_TOKEN=""
  fi
fi

while [ -z "$REFRESH_TOKEN" ]; do
  read -p "Enter a valid Refresh Token: " REFRESH_TOKEN
done

# 2. Infer project ID and region
PROJECT_ID=$(gcloud config get-value project)
REGION="us-central1"
NODE_VERSION="22"

# Namespaced resource identifiers (isolated per partner for multi-tenant support)
DATASET_ID="${DATASET_ID:-dv360_dgpulse_${PARTNER_ID}}"
TABLE_ID="campaigns"
TOPIC_NAME="${TOPIC_NAME:-dv360-dgpulse-topic-${PARTNER_ID}}"
FUNCTION_NAME="dv360-dgpulse-${PARTNER_ID}"
PROCESS_FUNCTION_NAME="dv360-dgpulse-process-advertiser-${PARTNER_ID}"
JOB_NAME="dv360-dgpulse-daily-sync-${PARTNER_ID}"

echo "Using Project ID: ${PROJECT_ID}"
echo "Using Region: ${REGION}"
echo "Using Partner ID: ${PARTNER_ID}"
echo "Using BigQuery Dataset: ${DATASET_ID}"
echo "Using Pub/Sub Topic: ${TOPIC_NAME}"
echo "Using Cloud Functions: ${FUNCTION_NAME} & ${PROCESS_FUNCTION_NAME}"
echo "Using Cloud Scheduler Job: ${JOB_NAME}"

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
  youtube.googleapis.com \
  apikeys.googleapis.com \
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

# 4a. Configure YouTube Data API key for Video Aspect Ratio evaluation
echo "Configuring YouTube Data API key..."
if [ -z "$YOUTUBE_API_KEY" ]; then
  if [ -f "youtube_api_key.txt" ] && [ -s "youtube_api_key.txt" ]; then
    YOUTUBE_API_KEY=$(cat youtube_api_key.txt | tr -d '\r\n')
  elif gsutil ls gs://${BUCKET_NAME}/youtube_api_key.txt >/dev/null 2>&1; then
    YOUTUBE_API_KEY=$(gsutil cat gs://${BUCKET_NAME}/youtube_api_key.txt | tr -d '\r\n')
  else
    echo "Creating YouTube Data API key via gcloud..."
    YOUTUBE_KEY_CREATE_LOGS=$(gcloud alpha services api-keys create \
        --api-target=service=youtube.googleapis.com \
        --display-name="YouTube API Key for DV360 DG Pulse" \
        --project="${PROJECT_ID}" \
        2>&1 || true)
    YOUTUBE_API_KEY=$(echo "$YOUTUBE_KEY_CREATE_LOGS" | grep -oP '"keyString":"\K[^"]+' || true)
  fi
fi

if [ -n "$YOUTUBE_API_KEY" ]; then
  echo "$YOUTUBE_API_KEY" > youtube_api_key.txt
  gsutil cp youtube_api_key.txt gs://${BUCKET_NAME}/youtube_api_key.txt 2>/dev/null || true
  echo "YouTube API key configured successfully."
else
  echo "Notice: YOUTUBE_API_KEY was not automatically retrieved. Video aspect ratio calculation will look for youtube_api_key.txt or BUCKET_NAME/youtube_api_key.txt."
fi

echo "Installing Node.js dependencies..."
npm install

echo "Setting up daily DBM report queries..."
# Only create/verify the report definitions here; the actual data sync happens
# once, later, at the "Syncing DBM Reports into BigQuery" step. Without the
# explicit "setup" argument this defaulted to a full sync, so every install
# downloaded and loaded the ~490k-row performance report twice.
# The || guard matters under `set -e`: create_report.js exits non-zero when a
# report fails, and an unguarded failure here would abort the install before
# the Cloud Function deploy and the Looker Studio link at the end.
BUCKET_NAME="${BUCKET_NAME}" REFRESH_TOKEN="${REFRESH_TOKEN}" PARTNER_ID="${PARTNER_ID}" DATASET_ID="${DATASET_ID}" node create_report.js "${PARTNER_ID}" setup || echo "Warning: one or more DBM report queries could not be created; see the error above."

# 4b. Create Pub/Sub Topic and BigQuery Dataset/Table
echo "Creating Pub/Sub topic: ${TOPIC_NAME}..."
gcloud pubsub topics create ${TOPIC_NAME} || echo "Topic already exists."

echo "Creating BigQuery dataset: ${DATASET_ID}..."
bq mk --dataset --location=${REGION} ${PROJECT_ID}:${DATASET_ID} || echo "Dataset already exists."

echo "Creating BigQuery table: ${DATASET_ID}.advertisers..."
bq mk --table ${PROJECT_ID}:${DATASET_ID}.advertisers \
  advertiserId:STRING,displayName:STRING,entityStatus:STRING,partnerId:STRING,currencyCode:STRING,cmFloodlightConfigId:STRING,cmFloodlightLinkingAuthorized:BOOLEAN || echo "Table advertisers already exists."
bq query --use_legacy_sql=false "ALTER TABLE \`${PROJECT_ID}.${DATASET_ID}.advertisers\` ADD COLUMN IF NOT EXISTS currencyCode STRING;" 2>/dev/null || true

echo "Creating BigQuery table: ${DATASET_ID}.advertiser_settings..."
# auto_tagging_enabled and ec_enabled were removed: neither Enhanced Conversions
# nor auto-tagging is exposed by the DV360 v4 or CM360 v5 APIs, so both were
# constant for every advertiser. Existing installs keep the (now unwritten)
# columns; nothing reads them.
bq mk --table ${PROJECT_ID}:${DATASET_ID}.advertiser_settings \
  advertiserId:STRING,displayName:STRING,partnerId:STRING,currency_code:STRING,has_crm_audience:STRING,has_ga_audience:STRING,floodlight_optimization_enabled:STRING,gtg_status:STRING,web_tag_type:STRING,dda_status:STRING || echo "Table advertiser_settings already exists."
bq query --use_legacy_sql=false "ALTER TABLE \`${PROJECT_ID}.${DATASET_ID}.advertiser_settings\` ADD COLUMN IF NOT EXISTS currency_code STRING, ADD COLUMN IF NOT EXISTS dda_status STRING;" 2>/dev/null || true

echo "Creating BigQuery table: ${DATASET_ID}.${TABLE_ID}..."
bq mk --table ${PROJECT_ID}:${DATASET_ID}.${TABLE_ID} campaignId:STRING,advertiserId:STRING,entityStatus:STRING,displayName:STRING || echo "Table already exists."

echo "Creating BigQuery table: ${DATASET_ID}.dbm_performance..."
bq mk --table ${PROJECT_ID}:${DATASET_ID}.dbm_performance \
  Report_Day:DATE,Partner:STRING,Partner_Id:INTEGER,Advertiser:STRING,Advertiser_Id:INTEGER,Advertiser_Currency:STRING,Media_Plan:STRING,Media_Plan_Id:INTEGER,Insertion_Order:STRING,Insertion_Order_Id:INTEGER,Line_Item:STRING,Line_Item_Id:INTEGER,Creative_Id:INTEGER,Device_Type:STRING,Inventory_Source:STRING,Revenue:FLOAT,Revenue_USD:FLOAT,Impressions:INTEGER,Clicks:INTEGER,Total_Conversions:FLOAT,Active_View_Viewable_Impressions:INTEGER,Active_View_Measurable_Impressions:INTEGER,Active_View_Eligible_Impressions:INTEGER,TrueView_Views:INTEGER,Video_Plays:INTEGER,Video_First_Quartile_Completes:INTEGER,Video_Midpoints:INTEGER,Video_Third_Quartile_Completes:INTEGER,Video_Completions:INTEGER,Video_Completion_Rate:FLOAT,Post_Click_Conversions:FLOAT,Post_View_Conversions:FLOAT,CM_Post_Click_Revenue:FLOAT,CM_Post_View_Revenue:FLOAT || echo "Table dbm_performance already exists."
bq query --use_legacy_sql=false "ALTER TABLE \`${PROJECT_ID}.${DATASET_ID}.dbm_performance\` ADD COLUMN IF NOT EXISTS Revenue_USD FLOAT64, ADD COLUMN IF NOT EXISTS Line_Item STRING, ADD COLUMN IF NOT EXISTS Line_Item_Id INT64;" 2>/dev/null || true

echo "Creating BigQuery table: ${DATASET_ID}.dbm_audiences_performance..."
bq mk --table ${PROJECT_ID}:${DATASET_ID}.dbm_audiences_performance \
  Report_Day:DATE,Partner:STRING,Partner_Id:INTEGER,Advertiser:STRING,Advertiser_Id:INTEGER,Advertiser_Currency:STRING,Media_Plan:STRING,Media_Plan_Id:INTEGER,Insertion_Order:STRING,Insertion_Order_Id:INTEGER,Line_Item:STRING,Line_Item_Id:INTEGER,Audience_List:STRING,Audience_List_Id:INTEGER,Audience_List_Type:STRING,Revenue:FLOAT,Revenue_USD:FLOAT,Impressions:INTEGER,Clicks:INTEGER,Total_Conversions:FLOAT,Post_View_Conversions:FLOAT,Post_Click_Conversions:FLOAT,CM_Post_Click_Revenue:FLOAT,CM_Post_View_Revenue:FLOAT || echo "Table dbm_audiences_performance already exists."

echo "Creating BigQuery table: ${DATASET_ID}.insertion_orders..."
bq mk --table ${PROJECT_ID}:${DATASET_ID}.insertion_orders \
  insertionOrderId:STRING,advertiserId:STRING,campaignId:STRING,displayName:STRING,entityStatus:STRING,pacingType:STRING,pacingPeriod:STRING,dailyMaxAmount:FLOAT,budgetUnit:STRING,automationType:STRING,budgetAmount:FLOAT,startDate:DATE,endDate:DATE || echo "Table insertion_orders already exists."

# One row per DV360 budget segment. Budget pacing is evaluated against the
# segment currently in flight, which the lifetime roll-up on insertion_orders
# cannot express.
echo "Creating BigQuery table: ${DATASET_ID}.io_budget_segments..."
bq mk --table ${PROJECT_ID}:${DATASET_ID}.io_budget_segments \
  insertionOrderId:STRING,advertiserId:STRING,campaignId:STRING,description:STRING,budget_amount:FLOAT,start_date:DATE,end_date:DATE || echo "Table io_budget_segments already exists."

# Full-flight IO spend from the ALL_TIME DBM pacing report. dbm_performance is
# capped at LAST_90_DAYS and so cannot be used to pace longer flights.
echo "Creating BigQuery table: ${DATASET_ID}.dbm_io_spend_daily..."
bq mk --table ${PROJECT_ID}:${DATASET_ID}.dbm_io_spend_daily \
  Report_Day:DATE,Partner_Id:INTEGER,Advertiser_Id:INTEGER,Advertiser_Currency:STRING,Insertion_Order:STRING,Insertion_Order_Id:INTEGER,Revenue:FLOAT,Revenue_USD:FLOAT,Impressions:INTEGER,Clicks:INTEGER || echo "Table dbm_io_spend_daily already exists."

echo "Creating BigQuery table: ${DATASET_ID}.line_items..."
bq mk --table ${PROJECT_ID}:${DATASET_ID}.line_items \
  lineItemId:STRING,insertionOrderId:STRING,campaignId:STRING,advertiserId:STRING,entityStatus:STRING,displayName:STRING,lineItemType:STRING,conversion_tracking_enabled:STRING || echo "Table line_items already exists."
bq query --use_legacy_sql=false "ALTER TABLE \`${PROJECT_ID}.${DATASET_ID}.line_items\` ADD COLUMN IF NOT EXISTS insertionOrderId STRING, ADD COLUMN IF NOT EXISTS conversion_tracking_enabled STRING;" 2>/dev/null || true

echo "Creating BigQuery table: ${DATASET_ID}.creatives..."
bq mk --table ${PROJECT_ID}:${DATASET_ID}.creatives \
  creativeId:STRING,advertiserId:STRING,entityStatus:STRING,displayName:STRING,creativeType:STRING,hostingSource:STRING,dimensions:STRING,imageUrl:STRING || echo "Table creatives already exists."

echo "Creating BigQuery table: ${DATASET_ID}.ad_group_ads..."
bq mk --table ${PROJECT_ID}:${DATASET_ID}.ad_group_ads \
  adGroupAdId:STRING,adGroupId:STRING,lineItemId:STRING,insertionOrderId:STRING,campaignId:STRING,advertiserId:STRING,displayName:STRING,entityStatus:STRING,adType:STRING,approvalStatus:STRING,video_id:STRING,aspect_ratio:FLOAT,videos_count:INTEGER,square_images_count:INTEGER,portrait_images_count:INTEGER,horizontal_images_count:INTEGER,headlines_count:INTEGER,long_headlines_count:INTEGER,descriptions_count:INTEGER,call_to_actions_count:INTEGER,created_at:TIMESTAMP || echo "Table ad_group_ads already exists."
bq query --use_legacy_sql=false "ALTER TABLE \`${PROJECT_ID}.${DATASET_ID}.ad_group_ads\` ADD COLUMN IF NOT EXISTS lineItemId STRING, ADD COLUMN IF NOT EXISTS insertionOrderId STRING, ADD COLUMN IF NOT EXISTS campaignId STRING, ADD COLUMN IF NOT EXISTS video_id STRING, ADD COLUMN IF NOT EXISTS aspect_ratio FLOAT64, ADD COLUMN IF NOT EXISTS approvalStatus STRING, ADD COLUMN IF NOT EXISTS created_at TIMESTAMP;" 2>/dev/null || true

echo "Creating BigQuery table: ${DATASET_ID}.video_aspect_ratio..."
bq mk --table ${PROJECT_ID}:${DATASET_ID}.video_aspect_ratio \
  video_id:STRING,aspect_ratio:FLOAT,updated_at:TIMESTAMP || echo "Table video_aspect_ratio already exists."



# 5. Deploy as a Cloud Run Function
echo "Deploying Cloud Function: ${FUNCTION_NAME}..."
gcloud functions deploy ${FUNCTION_NAME} \
  --gen2 \
  --runtime=nodejs${NODE_VERSION} \
  --region=${REGION} \
  --source=. \
  --entry-point=fetchAdvertisers \
  --trigger-http \
  --no-allow-unauthenticated \
  --cpu=2 \
  --memory=4Gi \
  --timeout=540s \
  --set-env-vars BUCKET_NAME=${BUCKET_NAME},REFRESH_TOKEN=${REFRESH_TOKEN},PARTNER_ID=${PARTNER_ID},TOPIC_NAME=${TOPIC_NAME},DATASET_ID=${DATASET_ID},NODE_OPTIONS=--max-old-space-size=3584

# 6. Get the service URL
SERVICE_URL=$(gcloud functions describe ${FUNCTION_NAME} --region=${REGION} --gen2 --format='value(serviceConfig.uri)')
echo "Service URL: ${SERVICE_URL}"

PROJECT_NUMBER=$(gcloud projects describe ${PROJECT_ID} --format='value(projectNumber)')
SERVICE_ACCOUNT="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

# Ensure the Cloud Scheduler service account has permission to invoke the service via OIDC
echo "Granting run.invoker to ${SERVICE_ACCOUNT}..."
gcloud run services add-iam-policy-binding ${FUNCTION_NAME} \
  --region=${REGION} \
  --member="serviceAccount:${SERVICE_ACCOUNT}" \
  --role="roles/run.invoker" > /dev/null 2>&1 || true

# 6b. Deploy Cloud Function for processing advertisers
#
# --retry is not optional. Without it the trigger defaults to
# RETRY_POLICY_DO_NOT_RETRY, and a Pub/Sub delivery that Cloud Run rejects is
# discarded permanently with no error surfaced anywhere. On a large partner
# (46 advertisers) that silently lost 34 of them: the publisher fanned out all
# 46 messages inside 1.5s, the worker runs at concurrency 1 so each needs its
# own instance, and Cloud Run aborted the overflow with "The request was
# aborted because there was no available instance". The batching in index.js
# stops the herd forming; this makes the remaining failures recoverable rather
# than fatal.
#
# --max-instances bounds DV360 API concurrency. The worker runs at concurrency
# 1, so instance count is request concurrency. Measured in testing, a single
# worker sustains roughly 120 DV360 requests/minute, and the "All requests per
# minute" quota is 1,500 per project and is NOT adjustable upward (the console
# caps the edit field at 1,500). Left at the Cloud Run default, a large partner
# fanned out to ~1,685 rpm and pinned the quota at 100% for an hour; because
# --retry has no dead-letter topic, every rejection was redelivered and the
# stall became self-sustaining. 8 instances is ~960 rpm, leaving headroom for
# the orchestrator's own sync.
#
# Do not raise this without re-measuring. Setting it too LOW is also harmful:
# at 4, Cloud Run rejected most deliveries with "no available instance" and the
# run crawled on retry backoff.
echo "Deploying Cloud Function: ${PROCESS_FUNCTION_NAME}..."
gcloud functions deploy ${PROCESS_FUNCTION_NAME} \
  --gen2 \
  --runtime=nodejs${NODE_VERSION} \
  --region=${REGION} \
  --source=. \
  --entry-point=processAdvertiser \
  --trigger-topic=${TOPIC_NAME} \
  --retry \
  --cpu=1 \
  --memory=1Gi \
  --max-instances=8 \
  --timeout=540s \
  --set-env-vars BUCKET_NAME=${BUCKET_NAME},REFRESH_TOKEN=${REFRESH_TOKEN},DATASET_ID=${DATASET_ID},TABLE_ID=${TABLE_ID},YOUTUBE_API_KEY=${YOUTUBE_API_KEY},PARTNER_ID=${PARTNER_ID}

# 7. Create Cloud Scheduler job
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

echo "Triggering initial DV360 advertiser & entity sync via Cloud Scheduler..."
gcloud scheduler jobs run ${JOB_NAME} --location=${REGION} || echo "Warning: Could not trigger immediate scheduler run."
# Wait for the per-advertiser workers, and verify they covered everyone.
#
# This used to be a flat "sleep 30", which was both too short and unverified.
# The workers are asynchronous and fire-and-forget, so nothing downstream
# notices when one is dropped: advertiser_settings
# simply lack that account, and every readiness column COALESCEs to
# NO / NEEDS_ACTION as though it had been checked and failed. Partner
# One partner installed with 12 of 46 advertisers covered and still printed a
# success banner.
#
# Waiting here also fixes a second problem. line_items is populated by these
# same workers, and the DBM performance and audience queries below scope
# themselves to the Demand Gen insertion orders read from it. Moving on too
# early meant the first sync built partner-wide queries that the second pass
# then had to tear down and rebuild.
echo "Waiting for Pub/Sub advertiser workers to populate raw tables..."
sleep 30

COVERAGE_OK="no"
COVERED_ADV=0
TOTAL_ADV=0
ATTEMPT=1
while [ "${ATTEMPT}" -le 20 ]; do
  TOTAL_ADV=$(bq query --quiet --use_legacy_sql=false --format=csv \
    "SELECT COUNT(DISTINCT CAST(advertiserId AS STRING)) FROM \`${PROJECT_ID}.${DATASET_ID}.advertisers\`" 2>/dev/null | tail -n1)
  COVERED_ADV=$(bq query --quiet --use_legacy_sql=false --format=csv \
    "SELECT COUNT(DISTINCT CAST(advertiserId AS STRING)) FROM \`${PROJECT_ID}.${DATASET_ID}.advertiser_settings\`" 2>/dev/null | tail -n1)
  echo "${TOTAL_ADV}" | grep -qE '^[0-9]+$' || TOTAL_ADV=0
  echo "${COVERED_ADV}" | grep -qE '^[0-9]+$' || COVERED_ADV=0

  if [ "${TOTAL_ADV}" -gt 0 ] && [ "${COVERED_ADV}" -ge "${TOTAL_ADV}" ]; then
    echo "Advertiser coverage complete: ${COVERED_ADV}/${TOTAL_ADV}."
    COVERAGE_OK="yes"
    break
  fi
  echo "  Advertiser coverage ${COVERED_ADV}/${TOTAL_ADV}; waiting for workers (attempt ${ATTEMPT}/20)..."
  sleep 30
  ATTEMPT=$((ATTEMPT + 1))
done

if [ "${COVERAGE_OK}" != "yes" ]; then
  echo ""
  echo "############################################################"
  echo "WARNING: advertiser coverage is INCOMPLETE (${COVERED_ADV}/${TOTAL_ADV})."
  echo ""
  echo "  advertiser_settings is written by the"
  echo "  per-advertiser workers. Accounts skipped do NOT render as blanks"
  echo "  -- they render as NO / NEEDS_ACTION / NOT_CONFIGURED, which are wrong"
  echo "  answers rather than absent ones."
  echo ""
  echo "  Inspect:  gcloud functions logs read ${PROCESS_FUNCTION_NAME} --gen2 --region=${REGION}"
  echo "  Re-run:   gcloud scheduler jobs run ${JOB_NAME} --location=${REGION}"
  echo "############################################################"
  echo ""
fi

echo "Syncing DBM Reports into BigQuery..."
DATASET_ID="${DATASET_ID}" BUCKET_NAME="${BUCKET_NAME}" REFRESH_TOKEN="${REFRESH_TOKEN}" PARTNER_ID="${PARTNER_ID}" node create_report.js "${PARTNER_ID}" sync || echo "Warning: DBM report generation in progress; data will populate on subsequent sync."

echo "Syncing Demand Gen ad group ads & video aspect ratios..."
DATASET_ID="${DATASET_ID}" YOUTUBE_API_KEY="${YOUTUBE_API_KEY}" BUCKET_NAME="${BUCKET_NAME}" REFRESH_TOKEN="${REFRESH_TOKEN}" PARTNER_ID="${PARTNER_ID}" node sync_ad_group_ads.js || echo "Warning: Initial ad sync will complete on next scheduled run."


echo "Setting up / Updating Scheduled Queries for daily materialization..."
export PROJECT_ID="${PROJECT_ID}"
export DATASET_ID="${DATASET_ID}"
export PARTNER_ID="${PARTNER_ID}"
export SERVICE_ACCOUNT="${SERVICE_ACCOUNT}"
export LOCATION="${REGION}"
node setup_scheduled_queries.js || echo "Warning: Scheduled query update via node helper encountered a warning."

LOOKER_LINK="https://lookerstudio.google.com/reporting/create?c.reportId=8052b105-d00c-4cb8-bc32-864fe4fe827f\
&ds.campaign_performance.connector=bigQuery&ds.campaign_performance.projectId=${PROJECT_ID}&ds.campaign_performance.datasetId=${DATASET_ID}&ds.campaign_performance.type=TABLE&ds.campaign_performance.tableId=final_campaign_performance&ds.campaign_performance.refreshFields=false\
&ds.line_items_performance.connector=bigQuery&ds.line_items_performance.projectId=${PROJECT_ID}&ds.line_items_performance.datasetId=${DATASET_ID}&ds.line_items_performance.type=TABLE&ds.line_items_performance.tableId=final_line_items_performance&ds.line_items_performance.refreshFields=false\
&ds.io_pacing_current.connector=bigQuery&ds.io_pacing_current.projectId=${PROJECT_ID}&ds.io_pacing_current.datasetId=${DATASET_ID}&ds.io_pacing_current.type=TABLE&ds.io_pacing_current.tableId=final_io_pacing_current&ds.io_pacing_current.refreshFields=false\
&ds.assets_performance.connector=bigQuery&ds.assets_performance.projectId=${PROJECT_ID}&ds.assets_performance.datasetId=${DATASET_ID}&ds.assets_performance.type=TABLE&ds.assets_performance.tableId=final_assets_performance&ds.assets_performance.refreshFields=false\
&ds.creative_variety.connector=bigQuery&ds.creative_variety.projectId=${PROJECT_ID}&ds.creative_variety.datasetId=${DATASET_ID}&ds.creative_variety.type=TABLE&ds.creative_variety.tableId=final_creative_variety&ds.creative_variety.refreshFields=false\
&ds.audiences_performance.connector=bigQuery&ds.audiences_performance.projectId=${PROJECT_ID}&ds.audiences_performance.datasetId=${DATASET_ID}&ds.audiences_performance.type=TABLE&ds.audiences_performance.tableId=final_audiences_performance&ds.audiences_performance.refreshFields=false"

echo "------------------------------------------------"
echo "🎉 Installation & Deployment Complete!"
echo "Your DV360 DG Pulse service is deployed at: ${SERVICE_URL}"
echo "The daily sync job is scheduled to run at 6:00 AM daily (${JOB_NAME})."
echo ""
echo "================================================================="
echo "📊 One-Click Looker Studio Dashboard Connection:"
echo "Click the link below to automatically clone the report template and"
echo "connect all 6 BigQuery tables for Partner ${PARTNER_ID} (Dataset: ${DATASET_ID}):"
echo ""
echo "${LOOKER_LINK}"
echo "================================================================="