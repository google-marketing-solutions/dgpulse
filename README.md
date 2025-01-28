# DemandGen-Pulse

In this README, you'll find:

- [Problem Statement](#problem-statement)
- [Solution](#solution)
- [Installation](#installation)
- [Prerequisites](#prerequisites)
- [Deliverable (Implementation)](#deliverable-implementation)
- [Architecture](#architecture)
- [Troubleshooting / Q&A](#troubleshooting)
- [Community Support](#community-support)
- [Disclaimer](#disclaimer)

## Problem Statement

Reporting for Demand Gen campaigns is cumbersome and advertisers need a simple
way to see an overview of their accounts and get a clear picture of their
campaigns and assets' performance.

## Solution

DG-Pulse is a best practice dashboard that provides a centralized monitoring of
DemandGen campaigns' performance and the assets uploaded. Built in Looker
Studio, It helps clearly identify if the campaigns and assets comply with the
best practice guidelines and gives actionable insights to enhance asset groups'
and feed quality.

Moreover, assets' performance is displayed and conveniently presented so
advertisers can refresh poorly performing assets.

## Deliverable (Implementation)

A Looker Studio dashboard based on your Google Ads and You Tube data. After
joining [this group](https://groups.google.com/g/dgpulse/),
[click here](https://lookerstudio.google.com/c/u/0/reporting/7ae6081d-c69a-4f29-ad02-f9c1aa16a052/page/i5YsC)
to see it in action.

[![DG-Pulse](https://services.google.com/fh/files/misc/dgpulse-animated-preview.gif)](https://lookerstudio.google.com/c/u/0/reporting/7ae6081d-c69a-4f29-ad02-f9c1aa16a052/page/i5YsC)

- LookerStudio dashboard based on your Google Ads and You Tube data.

## Prerequisites

1. Join [this group](https://groups.google.com/g/dgpulse/)

1. Obtain a Developer token

   a. This can be found in [Google Ads](https://ads.google.com) on the MCC level

   b. Go to Tools & Settings > Setup > API Center. If you do not see a developer
   token there, please complete the details and request one.

   c. By default, your access level is 'Test Account'; please apply for 'Basic
   access' if you don't have it. Follow
   [these instructions](https://developers.google.com/google-ads/api/docs/access-levels)

1. Create a new Google Cloud Project on the
   [Google Cloud Console](https://console.cloud.google.com/), **make sure it is
   connected to a billing account**

### Installation

To do your first installation, click on the blue Deploy button and follow the
instructions:

[![Click to deploy DG-Pulse](https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSCDIyJjIDWlJHd_x6RAaKczT5_9yc_IC3voZoSUgPwZ9Qn2gQRI3-e_Ra9UR2zEgMVMBM&usqp=CAU)](https://console.cloud.google.com/?cloudshell=true&cloudshell_git_repo=https://github.com/google-marketing-solutions/dgpulse&cloudshell_tutorial=walkthrough.md)

### Upgrade

If you have already installed it before, in order to upgrade to the latest
version of the code, execute (copy to the Google Cloud shell and press enter)
the following commands:

```
cd dgpulse
```

```
./install-or-upgrade.sh
```

Notice that this will **not** change the Looker Studio template. Only the code.
In order to get the latest version of the template, go to this
[link](https://lookerstudio.google.com/c/u/0/reporting/7ae6081d-c69a-4f29-ad02-f9c1aa16a052/page/i5YsC),
make a copy of it and point the data sources to your own GCP's BigQuery.

## Architecture

### What happens during installation

![What happens during installation](https://services.google.com/fh/files/misc/dgpulse-arch-1.jpeg)

### What Google Cloud components are deployed automatically

![What Google Cloud components are deployed automatically](https://services.google.com/fh/files/misc/dgpulse-arch-2.png)

### In depth: Gaarf → Storage

![In depth: Gaarf → Storage](https://services.google.com/fh/files/misc/dgpulse-arch-3-1.png)

### In depth: Gaarf → Scheduler + Workflow

![In depth: Gaarf → Scheduler + Workflow](https://services.google.com/fh/files/misc/dgpulse-arch-4.png)

### In depth: Gaarf → Run

![In depth: Gaarf → Run](https://services.google.com/fh/files/misc/dgpulse-arch-5.png)

### In depth: Gaarf → BigQuery

![In depth: Gaarf → BigQuery](https://services.google.com/fh/files/misc/dgpulse-arch-6.png)
![In depth: Gaarf → BigQuery](https://services.google.com/fh/files/misc/dgpulse-arch-6_1.png)

### What happens daily post installation

![What happens daily post installation](https://services.google.com/fh/files/misc/dgpulse-arch-7.jpeg)
https://services.google.com/fh/files/misc/dgpulse-arch-7.jpeg

## Troubleshooting

### What technical skills do I need to deploy the dashboard?

You do not need any technical skills to deploy the dashboard as it’s fully
driven by clicks and “copy and paste” commands. However, you do need the Owner
level permission in the Google Cloud project you’re deploying it to.

### What Google Cloud components will be added to my project?

- Storage
- Scheduler
- Workflows
- Run
- BigQuery (Datasets and Data Transfer)

### The deployment was not successful, what do I do?

If the deployment was unsuccessful please follow these steps to try and
troubleshoot:

1. Check that all credentials in the google-ads.yaml are correct:
   - In The Google Cloud Platform, under the project you deployed DG-Pulse too,
     Click the “Activate Cloud Shell” icon:
     ![“Activate Cloud Shell](https://services.google.com/fh/files/misc/pmaximizer-impl-img1.png)
   - Click the “Open Editor” icon:
     ![Open Editor](https://services.google.com/fh/files/misc/pmaximizer-impl-img2.png)
   - In the File System, find the dgpulse directory.
   - In the dgpulse directory, find the google-ads.yaml file and click on it.
   - Review the credentials in the google-ads.yaml file. Make sure that they are
     correct, and that there are no quotation marks before any credential.
   - Check that the login_customer_id is all digits, with no dashes (i.e:
     123456789 and not 123-456-789)
   - If you find a mistake, edit it in place and be sure to save, and follow the
     next steps. If not, please refer to “How do I see logs from my deployment?”
     in the next section.
   - Click the “Open Terminal” icon:
     ![Open Terminal](https://services.google.com/fh/files/misc/pmaximizer-impl-img3.png)
   - In the Cloud shell, copy and paste the green code, and press the Enter key
     when specified:
     - `cd dgpulse` Press Enter
     - `sh upgrade-version.sh` Press Enter
   - After the run finishes (may take 15-30 minutes) Check the dashboard URL to
     see if the deployment succeeded. (you can see instructions on how to find
     the dashboard URL in this document).

### How do I see the logs from my deployment?

- In the Google Cloud Platform, under the project you deployed DG-Pulse too,
  click on the “Search” bar in the central upper part of the screen
- Type “Logs Explorer” in the search bar and click on the following:
  ![Logs Explorer](https://services.google.com/fh/files/misc/pmaximizer-impl-img4.png)

### I lost the dashboard URL in the process, how can I access or find it?

You can find the dashboard_url.txt file in the folder of the cloned repository
or in your GCS bucket. Please see these instructions on how to access the URL
through the cloud shell:

- In The Google Cloud Platform, under the project you deployed too, Click the
  “Activate Cloud Shell” icon:
  ![Activate Cloud Shell”](https://services.google.com/fh/files/misc/pmaximizer-impl-img5.png)
- In the Cloud shell, copy and paste the green code, and press the Enter key
  when specified:
  - `cd dgpulse` Press Enter
  - `cat dashboard_url.txt` Press Enter

The dashboard URL should then appear in the Shell.

### What access level does my access token must have?

Your Access Token has to have "Basic Access" or "Standard". Level "Test Account"
will not work:

![Access Token Level](https://services.google.com/fh/files/misc/pmaximizer-impl-img6.png)

### How Do I save and share the Finished Dashboard with teammates?

After clicking the dashboard URL for the first time, you will see the
LookerStudio dashboard. In order to save and share it you need to follow these
steps:

- On the upper right side of the screen, click "Save and Share"
- Review the Credentials permissions of the different data sources. If you would
  like to give other colleagues permission to view all parts of the dashboard,
  even if they don’t have permissions to the Google Cloud Project it was created
  in, you need to change the credentials to Owner’s.
- To change the credentials to Owner’s, you need to click Edit on the very most
  right column:

![Edit Views / Owner Credentials](https://services.google.com/fh/files/misc/pmaximizer-impl-img7.png)

- Click on Data Credentials:

![Owner Credentials](https://services.google.com/fh/files/misc/pmaximizer-impl-img8.png)

- Choose Owner’s credentials, and then Update:

![Owner Credentials](https://services.google.com/fh/files/misc/pmaximizer-impl-img9.png)

- Click Done on the upper right.
- Do this for all data sources in the Dashboard.
- Click “Save and Share” again, and “Acknowledge and save”
- Click “Add to Report”.
- On the upper right, Click Share:
  ![Share Dashboard](https://services.google.com/fh/files/misc/pmaximizer-impl-img10.png)
  to share with teammates.

### How much does it cost? It heavily depends on how much data you have and how
often it's used. If you check the Architecture of Components section, there are
5 cloud components: Run, Scheduler, Workflows, Storage and BigQuery. For a large
amount of data (for example thousands of accounts, campaigns and assets), we do
not expect more than 10-15 USD/month in Google Cloud, mainly driven by Big
Query.

### How do I edit the dashboard?

Please find this Looker Studio
[tutorial](https://support.google.com/looker-studio/answer/9171315?hl=en).

### What Oauth credential user type should I choose? Internal or external?

If you’re a google workspace user: Internal If you’re not a google-workspace
user: External. You should be ok to use it in "Test mode" instead of requesting
your app to be approved by Google.

### How do I modify the results I get the dates of the data being pulled / how do I modify the hour the data is getting pulled?

You can modify the answers.json file. In the GCP, open the cloud shell.

### Can I create a dashboard on paused DemandGen campaigns that we ran in the past?

Yes! You can just change the ads_macro.start_date in answers.json file (shown
above) while deploying to a value that covers the dates where the campaigns were
active. By default it sets start_date to 90 days ago.

### Can I deploy it in an existing Cloud Project or do I need to create a new one just for this dashboard?

You can use an existing Project if you want to. However, please remember that
the best practice for clients is to create a new project dedicated to this
solution (or any new solution).

### Which GAQL queries are executed?

Please refer to the folder google_ads_queries.

### if I need to mask my data for demo purposes, what can I do?

For convenience, here's an SQL script you can run after all bigquery tables have
been created:

```
UPDATE `dgpulse_ads_bq.account_conversion_action`
SET
  account_name = CONCAT(
    SUBSTRING(account_name, 1, 2),
    'xxxxx',
    SUBSTRING(account_name,LENGTH(account_name), LENGTH(account_name)))
WHERE account_name IS NOT NULL;


UPDATE `dgpulse_ads_bq.campaign_data`
SET
  account_name = CONCAT(
    SUBSTRING(account_name, 1, 2),
    'xxxxx',
    SUBSTRING(account_name,LENGTH(account_name), LENGTH(account_name))),
  campaign_name = CONCAT(
    SUBSTRING(campaign_name, 1, 2),
    'yyyyyyyyyyy',
    SUBSTRING(campaign_name,LENGTH(campaign_name), LENGTH(campaign_name)))
WHERE account_name IS NOT NULL;


UPDATE `dgpulse_ads_bq.campaigns_assets_count`
SET
  account_name = CONCAT(
    SUBSTRING(account_name, 1, 2),
    'xxxxx',
    SUBSTRING(account_name,LENGTH(account_name), LENGTH(account_name))),
  campaign_name = CONCAT(
    SUBSTRING(campaign_name, 1, 2),
    'yyyyyyyyyyy',
    SUBSTRING(campaign_name,LENGTH(campaign_name), LENGTH(campaign_name)))
WHERE account_name IS NOT NULL;


UPDATE `dgpulse_ads_bq.audience_performance`
SET
  account_name = CONCAT(
    SUBSTRING(account_name, 1, 2),
    'xxxxx',
    SUBSTRING(account_name,LENGTH(account_name), LENGTH(account_name))),
  audience_name = CONCAT(
    SUBSTRING(audience_name, 1, 2),
    'xxxxx',
    SUBSTRING(audience_name,LENGTH(audience_name), LENGTH(audience_name))),
  campaign_name = CONCAT(
    SUBSTRING(campaign_name, 1, 2),
    'yyyyyyyyyyy',
    SUBSTRING(campaign_name,LENGTH(campaign_name), LENGTH(campaign_name)))
WHERE account_name IS NOT NULL;
```

______________________________________________________________________

## Community Support

If you can’t find an answer for your question/a solution to your problem here,
please post your question in our
[public group](https://groups.google.com/g/dgpulse/).

## Disclaimer

\*\* This is not an officially supported Google product.\*\*

Copyright 2024 Google LLC. This solution, including any related sample code or
data, is made available on an “as is,” “as available,” and “with all faults”
basis, solely for illustrative purposes, and without warranty or representation
of any kind. This solution is experimental, unsupported and provided solely for
your convenience. Your use of it is subject to your agreements with Google, as
applicable, and may constitute a beta feature as defined under those agreements.
To the extent that you make any data available to Google in connection with your
use of the solution, you represent and warrant that you have all necessary and
appropriate rights, consents and permissions to permit Google to use and process
that data. By using any portion of this solution, you acknowledge, assume and
accept all risks, known and unknown, associated with its usage, including with
respect to your deployment of any portion of this solution in your systems, or
usage in connection with your business, if at all.
