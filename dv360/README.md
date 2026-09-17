# DV360 Pulse

A serverless monitoring and performance analytics pipeline for **Display & Video 360 (DV360)**. It automates daily DBM reporting queries, extracts rich advertiser and creative metadata via the DV360 API v4, and materializes analytics tables into BigQuery for direct visualization in Looker Studio.

---

## Architecture Overview

```
                                  +------------------------------------+
                                  |        Cloud Scheduler             |
                                  | (Daily 6:00 AM Metadata Sync)      |
                                  +-----------------+------------------+
                                                    |
                                                    v
                                  +------------------------------------+
                                  |   Cloud Function (fetchAdvertisers)|
                                  +-----------------+------------------+
                                                    |
                                                    v
                                  +------------------------------------+
                                  |   Pub/Sub (dv360-advertiser-topic) |
                                  +-----------------+------------------+
                                                    |
                                                    v
                                  +------------------------------------+
                                  |Cloud Function (processAdvertiser)  |
                                  +-----------------+------------------+
                                                    |
                                                    v
                                  +------------------------------------+
                                  |      BigQuery Base Tables          |
                                  |  - advertisers & settings          |
                                  |  - campaigns & line_items          |
                                  |  - insertion_orders & creatives    |
                                  |  - floodlight_activities           |
                                  |  - dbm_performance                |
                                  +-----------------+------------------+
                                                    |
                                                    v
                                  +------------------------------------+
                                  |    BigQuery Materialized Views     |
                                  |  - final_campaign_performance      |
                                  |  - final_line_items_performance    |
                                  |  - final_insertion_orders_perf     |
                                  |  - final_assets_performance        |
                                  |  - final_floodlight_activities     |
                                  +-----------------+------------------+
                                                    |
                                                    v
                                  +------------------------------------+
                                  |   Looker Studio Template           |
                                  |  (Connected via Linking API)       |
                                  +-----------------+------------------+
```

---

## Requirements & Prerequisites

Before deploying, ensure you have:

1. **Google Cloud Project**: A GCP project with billing enabled.
2. **DV360 Partner Access**: Your DV360 Partner ID.
3. **OAuth 2.0 Credentials & Consent Screen Setup**:
   * In the Google Cloud Console, navigate to **APIs & Services** ➔ **OAuth consent screen**:
     * Select **Internal** (if deploying within your Google Workspace organization) or **External** (if using standard Gmail accounts).
     * Enter an App name (e.g., `DGPulse DV360`) and your developer contact email.
     * Click **Add or Remove Scopes** and add:
       * `https://www.googleapis.com/auth/display-video`
       * `https://www.googleapis.com/auth/doubleclickbidmanager`
     * *(If using External user type)*: On the **Test users** screen, add your email address so you are permitted to authorize during testing.

   > ⚠️ **This choice decides whether your daily sync keeps running unattended.**
   >
   > Google expires refresh tokens after **7 days** for any app whose publishing
   > status is **Testing**. When that happens the deployed Cloud Function starts
   > failing every night with `invalid_grant`, and no data reaches BigQuery until
   > someone manually generates and redeploys a new token.
   >
   > | Setup | Refresh token lifetime |
   > |---|---|
   > | **Internal** user type (Workspace org) | Does not expire — **recommended** |
   > | **External**, publishing status *In production* | Does not expire |
   > | **External**, publishing status *Testing* | **Expires after 7 days** |
   >
   > If you are deploying inside your own Workspace organization, choose
   > **Internal** and there is nothing further to do. If you must use **External**,
   > go to the OAuth consent screen and click **PUBLISH APP** to move it out of
   > Testing before you generate the refresh token in step 1. Leaving it in
   > Testing is fine only for short-lived evaluation.
   * Navigate to **APIs & Services** ➔ **Credentials**:
     * Click **+ CREATE CREDENTIALS** ➔ **OAuth client ID**.
     * Select **Web application** as the application type.
     * Under **Authorized redirect URIs**, click **+ ADD URI** and enter: `http://localhost:3000`
     * Click **CREATE**, then download the client secret JSON file.
     * Rename the downloaded file to `client_secret.json` and place it inside the `dv360/` directory.

---

## Step-by-Step Deployment (From Scratch)

### 1. Authenticate & Obtain Refresh Token
On your local machine (where port 3000 can receive the redirect):
```bash
npm install
node auth.js
```
* Click the URL printed in the terminal, log in with your Google account that has DV360 access, and authorize.
* Copy the printed `refresh_token`.

### 2. Run the Automated Installer
In Google Cloud Shell:
```bash
export PARTNER_ID="<YOUR_DV360_PARTNER_ID>"
export REFRESH_TOKEN="<PASTE_YOUR_REFRESH_TOKEN>"

chmod +x install.sh
./install.sh
```

The script automatically:
* Enables all necessary GCP APIs (`displayvideo`, `doubleclickbidmanager`, `run`, `cloudfunctions`, `bigquerydatatransfer`, `cloudscheduler`).
* Creates the Cloud Storage bucket and uploads `client_secret.json`.
* Creates the recurring partner-level DBM query via `create_report.js`.
* Sets up an isolated BigQuery dataset (`dv360_dgpulse_${PARTNER_ID}`) and all base schema tables.
* Deploys namespaced extraction and worker Cloud Functions (`dv360-dgpulse-${PARTNER_ID}`, `dv360-dgpulse-process-advertiser-${PARTNER_ID}`).
* Configures Cloud Scheduler for daily execution at 6:00 AM (`dv360-dgpulse-daily-sync-${PARTNER_ID}`).
* Deploys daily BigQuery scheduled queries for all 8 materialized analytics views scoped to the partner.
* **Prints the One-Click Looker Studio Linking API URL** connected directly to the partner's dataset.

> [!TIP]
> **Multi-Partner Support**: Multiple DV360 partners can be deployed in the same GCP project without collisions. Every partner has isolated datasets, Cloud Functions, Pub/Sub topics, and scheduled queries keyed by `${PARTNER_ID}`.

---

## Looker Studio Linking API & Data Source Aliases

The [Looker Studio dashboard template](https://datastudio.google.com/c/reporting/d9e9b92c-74b8-4248-b57d-f9bd2a59be2f) connects via the Google Data Studio Linking API. 

Each data source has a pre-configured alias that automatically binds to your project's BigQuery tables:

| Looker Data Source Name | Alias Name | Target BigQuery Table |
| :--- | :--- | :--- |
| **DV360 Campaign Performance** | `campaign_performance` | `final_campaign_performance` |
| **DV360 Line Items Performance** | `line_items_performance` | `final_line_items_performance` |
| **DV360 Insertion Orders Performance** | `insertion_orders_performance` | `final_insertion_orders_performance` |
| **DV360 Asset Performance** | `assets_performance` | `final_assets_performance` |
| **DV360 Creative Variety** | `creative_variety` | `final_creative_variety` |
| **DV360 Audiences Performance** | `audiences_performance` | `final_audiences_performance` |
| **DV360 Floodlight Activities Audit** | `floodlight_audit` | `final_floodlight_activities_audit` |
| **DV360 Floodlight Pre-Flight Audit** | `floodlight_preflight_audit` | `final_cls_preflight_audit` |

---

## Manual Sync & Maintenance Commands

### Trigger Sync Immediately
```bash
gcloud scheduler jobs run "dv360-dgpulse-daily-sync-${PARTNER_ID}" --location=us-central1
```

### Re-run Materialization Queries Manually
```bash
DATASET_ID="${DATASET_ID:-dv360_dgpulse_${PARTNER_ID}}"
for sql in materialize_campaigns.sql materialize_line_items.sql materialize_insertion_orders.sql materialize_assets.sql materialize_audiences.sql materialize_creative_variety.sql materialize_floodlight_activities.sql; do
  bq query --use_legacy_sql=false "$(cat $sql | sed "s/__PROJECT_ID__/$(gcloud config get-value project)/g" | sed "s/__DATASET_ID__/${DATASET_ID}/g" | sed "s/__PARTNER_ID__/${PARTNER_ID}/g")"
done
```

---

## Troubleshooting

### `invalid_grant` on every report

This has two unrelated causes. Check which one applies before regenerating anything — a regenerated token will not fix the second.

The scripts print their credential source on startup:

```
Using refresh token from: Cloud Function dv360-dgpulse-<PARTNER_ID>.
```

**Cause 1 — the token expired.** Expected if your OAuth app is still in *Testing*
publishing status (see Prerequisites). Generate a new one and write it to the
deployed function:

```bash
node auth.js   # copy the printed refresh_token

gcloud functions deploy "dv360-dgpulse-${PARTNER_ID}" \
  --region=us-central1 --gen2 \
  --update-env-vars "REFRESH_TOKEN=<new token>"
```

> ⚠️ Use `--update-env-vars`, **never** `--set-env-vars`. The latter replaces the
> entire environment, discarding `BUCKET_NAME`, `PARTNER_ID` and `DATASET_ID`,
> which breaks the function in a way that looks unrelated to the token change.

If you also run the scripts locally, put the same value in `dv360/.env`:

```bash
echo "REFRESH_TOKEN=<new token>" >> .env
```

**Cause 2 — the wrong credential was picked up.** Credentials are resolved in
priority order: `REFRESH_TOKEN` in the environment, then `dv360/.env`, then the
deployed Cloud Function `dv360-dgpulse-<PARTNER_ID>`. If a stale value is sitting
in an earlier source it silently wins over the correct one. The startup line
above tells you which source was used; clear whichever one is stale.

Always pass the partner ID explicitly so the correct function is consulted:

```bash
node create_report.js "${PARTNER_ID}" setup   # verify report definitions only
node create_report.js "${PARTNER_ID}" sync    # full data sync
```

### Report queries are recreated on every run

If the logs show `Creating new DBM ... query` on every run instead of
`Found existing DBM ... query ID`, the reuse check is failing and a new query is
being registered each time. These accumulate against the 100-query lookup window
and will eventually stop the other reports from finding themselves too. The
recreation reason is logged — check whether the deployed query's dimensions still
match the code.

---

## Demo Dataset & Walkthroughs

To generate a synthetic demo dataset showcasing all dashboard scenarios (all 9 pacing alerts, healthy vs. legacy floodlight activities, conversion lift readiness, and creative varieties) without requiring active live campaigns:

```bash
# Populate synthetic demo tables in dataset dv360_dgpulse_demo:
npm run seed:demo
# Or specify a custom dataset/project:
node seed_demo_data.js <my_demo_dataset> <my_project_id>
```
The script will output a pre-configured One-Click Looker Studio linking URL that connects directly to the demo dataset.

