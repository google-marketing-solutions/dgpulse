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
* Sets up BigQuery dataset (`dv360_dgpulse`) and all 6 base schema tables.
* Deploys the extraction and worker Cloud Functions (`dv360-dgpulse`, `dv360-dgpulse-process-advertiser`).
* Configures Cloud Scheduler for daily execution at 6:00 AM.
* Deploys daily BigQuery scheduled queries for all 5 materialized analytics views.
* **Prints the One-Click Looker Studio Linking API URL**.

---

## Looker Studio Linking API & Data Source Aliases

The Looker Studio dashboard template ([Report Template ID: `5e126b6a-33fc-4d0a-80cb-7ce6bc990001`](https://datastudio.google.com/c/reporting/5e126b6a-33fc-4d0a-80cb-7ce6bc990001)) connects via the Google Data Studio Linking API. 

Each data source has a pre-configured alias that automatically binds to your project's BigQuery tables:

| Looker Data Source Name | Alias Name | Target BigQuery Table |
| :--- | :--- | :--- |
| **DV360 Campaign Performance** | `campaign_performance` | `final_campaign_performance` |
| **DV360 Line Items Performance** | `line_items_performance` | `final_line_items_performance` |
| **DV360 Insertion Orders Performance** | `insertion_orders_performance` | `final_insertion_orders_performance` |
| **DV360 Asset Performance** | `assets_performance` | `final_assets_performance` |
| **DV360 Floodlight Activities Audit** | `floodlight_audit` | `final_floodlight_activities_audit` |

---

## Manual Sync & Maintenance Commands

### Trigger Sync Immediately
```bash
gcloud scheduler jobs run dv360-dgpulse-daily-sync --location=us-central1
```

### Re-run Materialization Queries Manually
```bash
for sql in materialize_campaigns.sql materialize_line_items.sql materialize_insertion_orders.sql materialize_assets.sql materialize_floodlight_activities.sql; do
  bq query --use_legacy_sql=false "$(cat $sql | sed "s/__PROJECT_ID__/$(gcloud config get-value project)/g" | sed "s/__DATASET_ID__/dv360_dgpulse/g" | sed "s/__PARTNER_ID__/${PARTNER_ID}/g")"
done
```
