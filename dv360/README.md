# DV360 Pulse

A serverless application to fetch campaign data from Display & Video 360 (DV360) and store it in BigQuery for analysis. It uses a message-driven architecture with Cloud Pub/Sub to parallelize the extraction of data by advertiser.

## Requirements

Before you begin, please ensure you meet the following requirements:

1.  **Google Cloud Project:** You must have a Google Cloud Project with the necessary permissions to enable APIs, create BigQuery datasets/tables, create Cloud Storage buckets, deploy Cloud Functions, and set up BigQuery Data Transfers.

2.  **Enabled Google Cloud APIs:**
    *   Display & Video 360 API (`displayvideo.googleapis.com`)
    *   DoubleClick Bid Manager API (`doubleclickbidmanager.googleapis.com`)

3.  **DV360 Partner ID:** You will need to provide the DV360 Partner ID you want to monitor during the installation.

4.  **OAuth 2.0 Credentials & Scopes:**
    *   `client_secret.json` and a Refresh Token are required.
    *   Required Scopes:
        *   `https://www.googleapis.com/auth/display-video`
        *   `https://www.googleapis.com/auth/doubleclickbidmanager`

By ensuring these requirements are met, the installation process will run smoothly and the solution will be able to access the necessary DV360 data and scheduled DBM reports.


## Getting Started

Follow these steps to deploy and run the DV360 campaign extraction pipeline:

1.  **Prepare Credentials**:
    If you don't have a `REFRESH_TOKEN`, `CLIENT_ID` and `CLIENT_SECRET` yet, follow these steps:
    *   Go to the **APIs & Services** -> **Credentials** tab in the Google Cloud Console.
    *   Complete the **OAuth consent screen** if you haven't already. Ensure both Display & Video 360 API and DoubleClick Bid Manager API scopes are granted.
    *   Click **+ CREATE CREDENTIALS** -> **OAuth client ID**.
    *   Select **Web application** as the application type.
    *   Add `http://localhost:3000` to the **Authorized redirect URIs**.
    *   Click create, and then download the JSON from the credentials list.
    *   Rename the downloaded file to `client_secret.json` and place it in the project root.
    *   Run `npm install` to install the required dependencies.
    *   Run `node auth.js`. Visit the printed URL to authorize. The script will automatically capture the code on port 3000 and print your `refresh_token`.

2.  **Run the Installation Script**:
    Run the deployment script (`./install.sh`). It will interactively prompt you for the inputs below or read them from your environment variables:
    *   `PARTNER_ID`: Your DV360 partner ID.
    *   `CLIENT_ID`: Your OAuth 2.0 Client ID.
    *   `CLIENT_SECRET`: Your OAuth 2.0 Client Secret.
    *   `REFRESH_TOKEN`: Your OAuth 2.0 Refresh Token.

    The script will automatically handle:
    *   Enabling necessary Google Cloud APIs (including DV360 and DBM APIs).
    *   Creating a Google Cloud Storage bucket and uploading credentials.
    *   Executing `create_report.js` to create the daily DBM performance report query.
    *   Creating the required Pub/Sub topics.
    *   Creating BigQuery tables (`campaigns`, `line_items`, `creatives`, `dbm_performance`).
    *   Deploying fetch and process Cloud Functions with exponential backoff for rate limits.
    *   Setting up Cloud Scheduler jobs for daily extraction and materialization.

## Project Structure

### 1. `auth.js`
*   **Role**: Setup & Authentication Helper
*   **Description**: A local CLI script used to generate initial OAuth2 refresh tokens for DV360 and DBM API authentication.

### 2. `dv360.js`
*   **Role**: API Client Wrapper
*   **Description**: Handles interaction with the DV360 API and DBM API v2 with automatic rate limiting retries (exponential backoff). Provides helper methods for paginated listing of advertisers, campaigns, line items, creatives, and DBM reporting queries.

### 3. `create_report.js`
*   **Role**: DBM Report Automation
*   **Description**: Automates creation of a daily scheduled DBM performance query (`TYPE_GENERAL`, grouped by Date, Partner, Advertiser, Media Plan, Creative ID) and triggers initial report execution.

### 4. `index.js`
*   **Role**: Entry Point & Publisher
*   **Description**: Entry point for the DV360 data fetch process. Fetches all advertiser IDs for a partner and publishes them to Pub/Sub for parallel processing. Exposes `processAdvertiser` and `setupDbmReport`.

### 5. `process_advertiser.js`
*   **Role**: Background Worker
*   **Description**: Handles processing of individual DV360 advertisers triggered by Pub/Sub messages. Fetches campaigns, line items, and creatives for each advertiser and writes them into BigQuery.

### 6. `materialize_campaigns.sql` & `materialize_assets.sql`
*   **Role**: SQL Transformation & Materialization
*   **Description**: Joins BigQuery metadata tables with `dbm_performance` report metrics to produce `final_campaign_performance` and `final_assets_performance` datasets for Looker Studio dashboards.
