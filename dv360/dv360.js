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
    // Determine if clientId is an object (keys.installed) or individual strings
    let cid, csec;
    if (typeof clientId === 'object' && clientId !== null) {
      cid = clientId.client_id;
      csec = clientId.client_secret;
    } else {
      cid = clientId;
      csec = clientSecret;
    }

    this.oauth2Client = new google.auth.OAuth2(cid, csec, 'http://localhost');

    this.oauth2Client.setCredentials({
      refresh_token: refreshToken
    });

    this.dv360 = google.displayvideo({
      version: 'v4',
      auth: this.oauth2Client
    });
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
      const response = await this.dv360.advertisers.list({
        partnerId: partnerId,
        pageToken: nextPageToken,
        pageSize: 100
      });

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
      const response = await this.dv360.advertisers.list({
        partnerId: partnerId,
        pageToken: nextPageToken,
        pageSize: 100
      });

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
      const response = await this.dv360.advertisers.campaigns.list({
        advertiserId: advertiserId,
        pageToken: nextPageToken,
        pageSize: 100
      });

      if (response.data.campaigns) {
        campaigns = campaigns.concat(response.data.campaigns);
      }

      nextPageToken = response.data.nextPageToken;
    } while (nextPageToken);

    return campaigns;
  }
}

module.exports = DV360Client;
