/**
 * @fileoverview Utility client class to handle interaction with the DV360 API.
 * Manages OAuth2 credentials and provides helper methods for paginated listing of advertisers and campaigns.
 */
const { google } = require('googleapis');

class DV360Client {
  /**
   * @param {string} clientId
   * @param {string} clientSecret
   * @param {string} refreshToken
   */
  constructor(clientId, clientSecret, refreshToken) {
    let cid, csec, redirectUri;
    if (typeof clientId === 'object' && clientId !== null) {
      cid = clientId.client_id;
      csec = clientId.client_secret;
      redirectUri = (clientId.redirect_uris && clientId.redirect_uris[0]) || 'http://localhost:3000';
    } else {
      cid = clientId;
      csec = clientSecret;
      redirectUri = 'http://localhost:3000';
    }

    this.oauth2Client = new google.auth.OAuth2(cid, csec, redirectUri);

    this.oauth2Client.setCredentials({
      refresh_token: refreshToken
    });

    this.dv360 = google.displayvideo({
      version: 'v4',
      auth: this.oauth2Client
    });

    this.dbm = google.doubleclickbidmanager({
      version: 'v2',
      auth: this.oauth2Client
    });
  }

  /**
   * Helper method to execute API requests with exponential backoff on 429/5xx errors.
   * @param {Function} apiCallFn
   * @param {number} maxRetries
   * @returns {Promise<any>}
   */
  async executeWithBackoff(apiCallFn, maxRetries = 5) {
    let delay = 1000;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await apiCallFn();
      } catch (error) {
        const status = error.status || (error.response && error.response.status);
        const isRateLimit = status === 429 || (error.message && error.message.includes('429'));
        const isServerError = status >= 500 && status < 600;

        if ((isRateLimit || isServerError) && attempt < maxRetries) {
          console.warn(`API call rate limited/failed (status ${status}). Retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2;
        } else {
          throw error;
        }
      }
    }
  }

  /**
   * Fetches all advertiser IDs for a given partner.
   * Handles pagination automatically.
   * @param {string} partnerId
   * @returns {Promise<string[]>} List of advertiser IDs
   */
  async listAllAdvertiserIds(partnerId) {
    let advertiserIds = [];
    let nextPageToken = null;

    do {
      const response = await this.executeWithBackoff(() =>
        this.dv360.advertisers.list({
          partnerId: partnerId,
          pageToken: nextPageToken,
          pageSize: 100
        })
      );

      if (response.data.advertisers) {
        const ids = response.data.advertisers.map(adv => adv.advertiserId);
        advertiserIds = advertiserIds.concat(ids);
      }

      nextPageToken = response.data.nextPageToken;
    } while (nextPageToken);

    return advertiserIds;
  }

  /**
   * Fetches all advertiser objects for a given partner.
   * Handles pagination automatically.
   * @param {string} partnerId
   * @returns {Promise<Object[]>} List of advertiser objects
   */
  async listAllAdvertisers(partnerId) {
    let advertisers = [];
    let nextPageToken = null;

    do {
      const response = await this.executeWithBackoff(() =>
        this.dv360.advertisers.list({
          partnerId: partnerId,
          pageToken: nextPageToken,
          pageSize: 100
        })
      );

      if (response.data.advertisers) {
        advertisers = advertisers.concat(response.data.advertisers);
      }

      nextPageToken = response.data.nextPageToken;
    } while (nextPageToken);

    return advertisers;
  }

  /**
   * Fetches all campaigns for a given advertiser.
   * Handles pagination automatically.
   * @param {string} advertiserId
   * @returns {Promise<Object[]>} List of campaign objects
   */
  async listAllCampaigns(advertiserId) {
    let campaigns = [];
    let nextPageToken = null;

    do {
      const response = await this.executeWithBackoff(() =>
        this.dv360.advertisers.campaigns.list({
          advertiserId: advertiserId,
          pageToken: nextPageToken,
          pageSize: 100
        })
      );

      if (response.data.campaigns) {
        campaigns = campaigns.concat(response.data.campaigns);
      }

      nextPageToken = response.data.nextPageToken;
    } while (nextPageToken);

    return campaigns;
  }

  /**
   * Fetches all line items for a given advertiser.
   * Handles pagination automatically.
   * @param {string} advertiserId
   * @returns {Promise<Object[]>} List of line item objects
   */
  async listAllLineItems(advertiserId) {
    let lineItems = [];
    let nextPageToken = null;

    do {
      const response = await this.executeWithBackoff(() =>
        this.dv360.advertisers.lineItems.list({
          advertiserId: advertiserId,
          pageToken: nextPageToken,
          pageSize: 100
        })
      );

      if (response.data.lineItems) {
        lineItems = lineItems.concat(response.data.lineItems);
      }

      nextPageToken = response.data.nextPageToken;
    } while (nextPageToken);

    return lineItems;
  }

  /**
   * Fetches all creatives for a given advertiser.
   * Handles pagination automatically.
   * @param {string} advertiserId
   * @returns {Promise<Object[]>} List of creative objects
   */
  async listAllCreatives(advertiserId) {
    let creatives = [];
    let nextPageToken = null;

    do {
      const response = await this.executeWithBackoff(() =>
        this.dv360.advertisers.creatives.list({
          advertiserId: advertiserId,
          pageToken: nextPageToken,
          pageSize: 100
        })
      );

      if (response.data.creatives) {
        creatives = creatives.concat(response.data.creatives);
      }

      nextPageToken = response.data.nextPageToken;
    } while (nextPageToken);

    return creatives;
  }

  /**
   * Creates or retrieves an existing daily DBM report query for a partner.
   * @param {string} partnerId
   * @returns {Promise<{queryId: string, isNew: boolean}>}
   */
  async createOrGetPerformanceReportQuery(partnerId) {
    const reportTitle = `DV360 DGPulse Performance Report - Partner ${partnerId}`;

    try {
      const existingQueries = await this.executeWithBackoff(() =>
        this.dbm.queries.list({ pageSize: 100 })
      );
      if (existingQueries.data.queries) {
        const found = existingQueries.data.queries.find(
          q => q.metadata && q.metadata.title === reportTitle
        );
        if (found) {
          console.log(`Found existing DBM query ID: ${found.queryId}`);
          return { queryId: found.queryId, isNew: false };
        }
      }
    } catch (e) {
      console.warn('Unable to list existing DBM queries, proceeding to create new query:', e.message);
    }

    // DBM API v2 requires explicit startDate and endDate for recurring 'DAILY' queries.
    // Setting endDate to Dec 31st, 5 years into the future creates a perpetual schedule
    // so the data sync runs continuously without expiring or requiring manual renewal.
    const now = new Date();
    const startDate = {
      year: now.getUTCFullYear(),
      month: now.getUTCMonth() + 1,
      day: now.getUTCDate()
    };
    const endDate = {
      year: now.getUTCFullYear() + 5,
      month: 12,
      day: 31
    };

    const queryObj = {
      metadata: {
        title: reportTitle,
        dataRange: { range: 'LAST_30_DAYS' },
        format: 'CSV'
      },
      params: {
        type: 'STANDARD',
        groupBys: [
          'FILTER_DATE',
          'FILTER_PARTNER',
          'FILTER_ADVERTISER',
          'FILTER_MEDIA_PLAN',
          'FILTER_CREATIVE_ID'
        ],
        metrics: [
          'METRIC_IMPRESSIONS',
          'METRIC_CLICKS',
          'METRIC_MEDIA_COST_ADVERTISER',
          'METRIC_TOTAL_CONVERSIONS'
        ],
        filters: [
          { type: 'FILTER_PARTNER', value: String(partnerId) }
        ]
      },
      schedule: {
        frequency: 'DAILY',
        startDate: startDate,
        endDate: endDate
      }
    };

    console.log(`Creating new DBM query for partner ${partnerId}...`);
    const res = await this.executeWithBackoff(() =>
      this.dbm.queries.create({ requestBody: queryObj })
    );
    console.log(`Successfully created DBM query ID: ${res.data.queryId}`);
    return { queryId: res.data.queryId, isNew: true };
  }

  /**
   * Triggers execution of a DBM query.
   * @param {string} queryId
   * @returns {Promise<Object>} Report object
   */
  async runQuery(queryId) {
    console.log(`Running DBM query ${queryId}...`);
    const res = await this.executeWithBackoff(() =>
      this.dbm.queries.run({ queryId: queryId })
    );
    return res.data;
  }

  /**
   * Retrieves reports for a query and returns the latest report's download URL.
   * @param {string} queryId
   * @returns {Promise<string|null>} Download URL for latest CSV
   */
  async getLatestReportDownloadUrl(queryId) {
    const reportsRes = await this.executeWithBackoff(() =>
      this.dbm.queries.reports.list({ queryId: queryId, pageSize: 10 })
    );
    if (!reportsRes.data.reports || reportsRes.data.reports.length === 0) {
      return null;
    }
    const latestReport = reportsRes.data.reports[0];
    if (latestReport.metadata && latestReport.metadata.googleCloudStoragePath) {
      return latestReport.metadata.googleCloudStoragePath;
    }
    return null;
  }
}

module.exports = DV360Client;
