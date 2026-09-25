/*
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @fileoverview Utility client class to handle interaction with the DV360 API.
 * Manages OAuth2 credentials and provides helper methods for paginated listing of advertisers and campaigns.
 */
const { google } = require('googleapis');

/**
 * Order-insensitive equality for two lists of enum strings.
 *
 * Used to decide whether an already-deployed report query still matches the
 * shape the code wants. Order is ignored deliberately: the API is not
 * documented to preserve the order groupBys were submitted in, and a reuse
 * check that reports a false mismatch is worse than no check at all -- it
 * recreates the query on every single run.
 * @param {!Array<string>|undefined} a
 * @param {!Array<string>|undefined} b
 * @returns {boolean}
 */
function sameStringSet(a, b) {
  const left = a || [];
  const right = b || [];
  if (left.length !== right.length) return false;
  const seen = new Set(left);
  return right.every(x => seen.has(x));
}

/**
 * Rejects if `promise` has not settled within `ms` milliseconds.
 *
 * The googleapis client applies no request deadline of its own. A list call
 * that never responds stays open indefinitely, and the only thing that
 * eventually ends it is the Cloud Run request timeout -- which terminates the
 * container without unwinding the stack, so no catch block runs and nothing is
 * logged. Every write queued after the hung call is lost with no error
 * anywhere. Racing against an explicit deadline converts that silent death
 * into an ordinary rejection that the caller can log and step over.
 *
 * @param {!Promise<T>} promise
 * @param {number} ms
 * @param {string} label Included in the rejection so the caller knows which
 *     request stalled.
 * @returns {!Promise<T>}
 * @template T
 */
function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} exceeded its ${ms}ms deadline`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

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
   * Fetches all insertion orders for a given advertiser.
   * Handles pagination automatically.
   * @param {string} advertiserId
   * @returns {Promise<Object[]>} List of insertion order objects
   */
  async listAllInsertionOrders(advertiserId) {
    let insertionOrders = [];
    let nextPageToken = null;

    do {
      const response = await this.executeWithBackoff(() =>
        this.dv360.advertisers.insertionOrders.list({
          advertiserId: advertiserId,
          pageToken: nextPageToken,
          pageSize: 100
        })
      );

      if (response.data.insertionOrders) {
        insertionOrders = insertionOrders.concat(response.data.insertionOrders);
      }

      nextPageToken = response.data.nextPageToken;
    } while (nextPageToken);

    return insertionOrders;
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
   * Fetches full details for a specific advertiser.
   * @param {string} advertiserId
   * @returns {Promise<Object>} Advertiser object
   */
  async getAdvertiser(advertiserId) {
    const response = await withDeadline(
      this.executeWithBackoff(() =>
        this.dv360.advertisers.get({ advertiserId: advertiserId })
      ),
      30000,
      `advertisers.get for advertiser ${advertiserId}`
    );
    return response.data;
  }

  /**
   * Determines whether an advertiser has CRM / 1PD and Google Analytics linked
   * audiences.
   *
   * Returns the two booleans rather than the audience list, because the list
   * cannot be enumerated in practice. `firstPartyAndPartnerAudiences` exposes
   * the partner-level pool, not a per-advertiser one: a single advertiser under
   * test returned over 125,000 audiences at the maximum page size of 5,000 and
   * was still paginating when its budget expired. Nothing downstream needs the
   * audiences themselves, only these two flags, so each page is scored as it
   * arrives and pagination stops the moment both are known -- in the common
   * case, on the first page.
   *
   * This resource was named `firstAndThirdPartyAudiences` in v2/v3 and renamed
   * in v4. Calling the old name against the v4 client yields `undefined`, which
   * previously surfaced as "advertiser has no audiences" for every advertiser
   * rather than as an error.
   *
   * Pagination is bounded three ways, because an unbounded loop here ran for
   * over 300s and was killed by the Cloud Run request timeout, which terminates
   * the container without running a catch block and so lost every subsequent
   * write silently: an overall deadline, a page cap, and a repeated page token
   * check.
   *
   * `exhaustive` reports whether the scan actually reached the end of the list.
   * A false signal with `exhaustive: false` means "not found in the portion
   * scanned", NOT "absent" -- only an exhaustive scan can prove absence. Given
   * the size of the pool, expect `exhaustive` to be false whenever a signal is
   * false, and treat such a NO as unverified.
   *
   * @param {string} advertiserId
   * @param {number=} deadlineMs Overall budget for the pagination loop.
   * @returns {Promise<{hasCrmAudience: boolean, hasGaAudience: boolean,
   *     scanned: number, pages: number, exhaustive: boolean}>}
   */
  async getAudienceSignals(advertiserId, deadlineMs = 60000) {
    const MAX_PAGES = 50;
    if (!this.dv360.firstPartyAndPartnerAudiences) {
      throw new Error(
        'DV360 client exposes no firstPartyAndPartnerAudiences resource. The ' +
        'googleapis version or the pinned API version is wrong -- audience ' +
        'signals cannot be evaluated.'
      );
    }

    // Valid DV360 v4 enums:
    //   audienceType   CUSTOMER_MATCH_CONTACT_INFO, CUSTOMER_MATCH_DEVICE_ID,
    //                  CUSTOMER_MATCH_USER_ID, ACTIVITY_BASED, FREQUENCY_CAP,
    //                  TAG_BASED, YOUTUBE_USERS, THIRD_PARTY, COMMERCE,
    //                  LINEAR, AGENCY
    //   audienceSource DISPLAY_VIDEO_360, CAMPAIGN_MANAGER, AD_MANAGER,
    //                  SEARCH_ADS_360, YOUTUBE, ADS_DATA_HUB
    // Earlier revisions filtered on AUDIENCE_SOURCE_CUSTOMER_MATCH,
    // AUDIENCE_SOURCE_THIRD_PARTY and AUDIENCE_SOURCE_GOOGLE_ANALYTICS, none of
    // which exist in v4.
    const isCrm = aud =>
      aud.audienceType === 'CUSTOMER_MATCH_CONTACT_INFO' ||
      aud.audienceType === 'CUSTOMER_MATCH_DEVICE_ID' ||
      aud.audienceType === 'CUSTOMER_MATCH_USER_ID' ||
      aud.audienceType === 'THIRD_PARTY';

    // v4 exposes no Google Analytics audience source, so GA-linked audiences
    // can only be identified by name. This is a heuristic, not an API
    // guarantee.
    const isGa = aud => {
      if (aud.audienceSource === 'ADS_DATA_HUB') return true;
      const name = (aud.displayName || '').toLowerCase();
      return name.includes('google analytics') ||
             name.includes('ga4') ||
             name.includes('analytics');
    };

    let hasCrmAudience = false;
    let hasGaAudience = false;
    let scanned = 0;
    let pages = 0;
    let exhaustive = false;
    let nextPageToken = null;
    const startedAt = Date.now();
    const seenTokens = new Set();

    try {
      do {
        const elapsed = Date.now() - startedAt;
        if (elapsed > deadlineMs) {
          console.warn(
            `Audience scan for advertiser ${advertiserId} hit its ` +
            `${deadlineMs}ms budget after ${pages} page(s) and ${scanned} ` +
            `audience(s). Any NO below is unverified.`);
          break;
        }
        if (pages >= MAX_PAGES) {
          console.warn(
            `Audience scan for advertiser ${advertiserId} reached the ` +
            `${MAX_PAGES}-page cap at ${scanned} audience(s). Any NO below ` +
            `is unverified.`);
          break;
        }

        const response = await withDeadline(
          this.executeWithBackoff(() =>
            this.dv360.firstPartyAndPartnerAudiences.list({
              advertiserId: advertiserId,
              pageToken: nextPageToken,
              // The documented maximum, and also the API default. The previous
              // value of 100 meant 36+ sequential pages per advertiser against
              // a pool this size, repeated for every advertiser in the
              // partner, which is what exhausted the 1,500 req/min quota.
              pageSize: 5000
            })
          ),
          // The whole remaining budget, not a fixed slice. At pageSize 5000 a
          // page carries far more data and legitimately takes longer, and a
          // per-page cap that trips yields nothing at all for that page.
          deadlineMs - elapsed,
          `firstPartyAndPartnerAudiences.list page ${pages + 1} for ` +
          `advertiser ${advertiserId}`
        );
        pages++;

        const page = response.data.firstPartyAndPartnerAudiences || [];
        scanned += page.length;
        for (const aud of page) {
          if (!hasCrmAudience && isCrm(aud)) hasCrmAudience = true;
          if (!hasGaAudience && isGa(aud)) hasGaAudience = true;
          if (hasCrmAudience && hasGaAudience) break;
        }

        // Both answers are known; no later page can change them.
        if (hasCrmAudience && hasGaAudience) {
          break;
        }

        nextPageToken = response.data.nextPageToken;
        if (!nextPageToken) {
          exhaustive = true;
          break;
        }
        if (seenTokens.has(nextPageToken)) {
          console.warn(
            `Audience pagination for advertiser ${advertiserId} returned a ` +
            `page token it had already issued; stopping at ${pages} page(s) ` +
            `rather than looping.`);
          break;
        }
        seenTokens.add(nextPageToken);
      } while (nextPageToken);

      console.log(
        `Audience scan for advertiser ${advertiserId}: ${scanned} ` +
        `audience(s) across ${pages} page(s) in ${Date.now() - startedAt}ms ` +
        `(CRM=${hasCrmAudience ? 'YES' : 'NO'}, ` +
        `GA=${hasGaAudience ? 'YES' : 'NO'}, ` +
        `${exhaustive ? 'complete' : 'partial'}).`);
    } catch (e) {
      console.warn(
        `Warning scanning audiences for advertiser ${advertiserId} after ` +
        `${pages} page(s) and ${Date.now() - startedAt}ms:`, e.message);
    }

    return { hasCrmAudience, hasGaAudience, scanned, pages, exhaustive };
  }



  /**
   * Fetches Floodlight group configuration including webTagType and lookback windows.
   * @param {string} floodlightGroupId
   * @param {string} partnerId
   * @returns {Promise<Object|null>}
   */
  async getFloodlightGroup(floodlightGroupId, partnerId) {
    try {
      const response = await this.executeWithBackoff(() =>
        this.dv360.floodlightGroups.get({
          floodlightGroupId: floodlightGroupId,
          partnerId: partnerId
        })
      );
      return response.data;
    } catch (e) {
      console.warn(`Warning fetching floodlight group ${floodlightGroupId}:`, e.message);
      return null;
    }
  }

  /**
   * Creates or retrieves an existing daily DBM report query for a partner,
   * scoped to that partner's Demand Gen insertion orders.
   * @param {string} partnerId
   * @param {!Array<string>=} insertionOrderIds Demand Gen insertion orders to
   *     scope the report to. Omitted or empty degrades to partner scope -- see
   *     the comment on the filters below.
   * @returns {Promise<{queryId: string, isNew: boolean}>}
   */
  async createOrGetPerformanceReportQuery(partnerId, insertionOrderIds) {
    const reportTitle = `DV360 DGPulse Performance Report - Partner ${partnerId}`;
    const dataRange = 'LAST_90_DAYS';

    // Declared before the reuse check so the check and the create call cannot
    // encode different expectations. They previously did: the check compared
    // only the date range, so any edit to these arrays was accepted into the
    // code, ignored by the already-deployed query, and silently never took
    // effect. Post_Click_Conversions and Post_View_Conversions sat hardcoded
    // to 0 downstream for exactly that reason.
    const groupBys = [
      'FILTER_DATE',
      'FILTER_PARTNER',
      'FILTER_ADVERTISER',
      'FILTER_ADVERTISER_CURRENCY',
      'FILTER_MEDIA_PLAN',
      'FILTER_INSERTION_ORDER',
      'FILTER_LINE_ITEM',
      'FILTER_CREATIVE_ID',
      'FILTER_DEVICE_TYPE',
      'FILTER_INVENTORY_SOURCE_NAME'
    ];

    const metrics = [
      'METRIC_IMPRESSIONS',
      'METRIC_CLICKS',
      'METRIC_MEDIA_COST_ADVERTISER',
      'METRIC_MEDIA_COST_USD',
      'METRIC_TOTAL_CONVERSIONS',
      // The click/view split of METRIC_TOTAL_CONVERSIONS.
      //
      // These two enum names are dangerously misleading. Despite reading like
      // counts of clicks and impressions, Bid Manager documents them as
      // "Post-Click Conversions" and "Post-View Conversions" respectively --
      // they are conversion metrics, not traffic metrics. Verified in
      // bid-manager/reference/rest/v2/filters-metrics.
      //
      // Do not remove them as apparent duplicates of METRIC_CLICKS and
      // METRIC_IMPRESSIONS. There is no other way to break total conversions
      // into click- and view-attributed halves: the API exposes no
      // METRIC_POST_CLICK_CONVERSIONS.
      'METRIC_LAST_CLICKS',
      'METRIC_LAST_IMPRESSIONS',
      // CM360 revenue, split the same click/view way. Feeds post_click_revenue
      // and post_view_revenue in the campaign, insertion order and line item
      // materializations.
      'METRIC_CM360_POST_CLICK_REVENUE',
      'METRIC_CM360_POST_VIEW_REVENUE',
      'METRIC_ACTIVE_VIEW_VIEWABLE_IMPRESSIONS',
      'METRIC_ACTIVE_VIEW_MEASURABLE_IMPRESSIONS',
      'METRIC_ACTIVE_VIEW_ELIGIBLE_IMPRESSIONS',
      'METRIC_TRUEVIEW_VIEWS',
      'METRIC_RICH_MEDIA_VIDEO_PLAYS',
      'METRIC_RICH_MEDIA_VIDEO_FIRST_QUARTILE_COMPLETES',
      'METRIC_RICH_MEDIA_VIDEO_MIDPOINTS',
      'METRIC_RICH_MEDIA_VIDEO_THIRD_QUARTILE_COMPLETES',
      'METRIC_RICH_MEDIA_VIDEO_COMPLETIONS',
      'METRIC_VIDEO_COMPLETION_RATE'
      // Deliberately absent. All three were rejected by queries.create when
      // added here, and a rejected create aborts the entire performance sync,
      // not merely the new columns -- these three took the whole report down
      // with them. Do not re-add any of them speculatively; the reasons below
      // were each established by validation testing, and are recorded in full
      // in probe_performance_metrics.js.
      //
      //   METRIC_PERCENTAGE_FROM_CURRENT_IO_GOAL
      //     Valid only at insertion order grain or coarser -- the API is
      //     explicit that FILTER_INSERTION_ORDER must be present, and creative,
      //     device, inventory source and line item are each individually
      //     disqualifying. This report needs all four, so it cannot go here.
      //     It also cannot join the IO pacing report, which is at the right
      //     grain: a factorial over partner breakdown, date range and metric
      //     set showed the metric set was the only factor that mattered, and
      //     it will not share a report with cost metrics. It would need a
      //     third query of its own, for a figure the dashboard already
      //     approximates from spend against flight dates.
      //
      //   METRIC_TRUEVIEW_LOST_IS_BUDGET, METRIC_TRUEVIEW_LOST_IS_RANK
      //     Accepted only under report type YOUTUBE, at line item or ad group
      //     grain; refused under STANDARD everywhere. Obtainable from a
      //     separate YouTube-typed report, which was judged not worth building
      //     -- the dashboard does not show them, and is_limited_by_budget in
      //     materialize_campaigns.sql already answers the same question.
      //
      // All three had their columns removed from the schema, the CSV mapping
      // and the three performance materializations, rather than being left as
      // permanent nulls. If any is ever wanted, the shapes it was accepted at
      // are recorded in probe_performance_metrics.js.
    ];

    // Repeated filter pairs of the same type are OR'd together by Bid Manager,
    // so this scopes the report to the partner's Demand Gen insertion orders.
    //
    // Scoping is not an optimisation here, it is what makes the report
    // downloadable at all. syncDbmPerformanceReport reads the CSV with
    // response.text(), and a partner-wide pull for a large partner exceeded
    // V8's hard 0x1fffffe8-character ceiling on a single string, failing with
    // "Cannot create a string longer than 0x1fffffe8 characters". That is an
    // engine limit, not a heap limit: --max-old-space-size cannot raise it.
    //
    // It costs nothing in data. Every performance materialization already
    // discards non-Demand-Gen rows downstream, and the deduped_dbm filter they
    // share keeps a row when its insertion order is in this same list, so
    // scoping the pull to these insertion orders removes only rows that were
    // going to be thrown away. Note this is an IO-level filter, so the
    // non-Demand-Gen line items inside a Demand Gen insertion order are still
    // returned -- which is exactly what deduped_dbm's first OR branch keeps.
    //
    // An empty list degrades to partner scope rather than failing, because the
    // entity sync that populates line_items has not run yet on a fresh install.
    // That is the bootstrap path: the first pass creates a partner-wide query,
    // and the reuse check below supersedes it on the next pass once the
    // insertion orders are known.
    const ioIds = (insertionOrderIds || []).map(String).filter(Boolean);
    const filters = [{ type: 'FILTER_PARTNER', value: String(partnerId) }];
    for (const ioId of ioIds) {
      filters.push({ type: 'FILTER_INSERTION_ORDER', value: ioId });
    }
    const filterKeys = filters.map(f => `${f.type}:${f.value}`);

    // Held back and deleted only once the replacement exists. The previous
    // order deleted first, which meant a rejected queries.create left the
    // partner with no performance report at all -- that is the main dashboard,
    // not a side panel. Creating first makes a failed upgrade a no-op rather
    // than an outage.
    let staleQueryId = null;

    try {
      const existingQueries = await this.executeWithBackoff(() =>
        this.dbm.queries.list({ pageSize: 100 })
      );
      if (existingQueries.data.queries) {
        const found = existingQueries.data.queries.find(
          q => q.metadata && q.metadata.title === reportTitle
        );
        if (found) {
          const params = found.params || {};
          const foundRange = (found.metadata && found.metadata.dataRange &&
                              found.metadata.dataRange.range) || null;
          // Filters are part of the compared shape, exactly as they are for
          // the audience query. Without this the partner-wide query created on
          // the bootstrap pass would be reused forever -- which is precisely
          // how the partner under test ended up re-downloading an oversized partner-wide CSV on
          // its second pass. It also means a Demand Gen insertion order created
          // after the query is picked up rather than excluded silently.
          // Recreations when the IO set changes are expected, not a symptom.
          const foundFilterKeys =
            (params.filters || []).map(f => `${f.type}:${f.value}`);
          const mismatch =
            foundRange !== dataRange ? `data range is ${foundRange}, expected ${dataRange}` :
            !sameStringSet(params.groupBys, groupBys) ? `groupBys differ (found ${(params.groupBys || []).length}, expected ${groupBys.length})` :
            !sameStringSet(params.metrics, metrics) ? `metrics differ (found ${(params.metrics || []).length}, expected ${metrics.length})` :
            !sameStringSet(foundFilterKeys, filterKeys) ? `filters differ (found ${foundFilterKeys.length}, expected ${filterKeys.length})` :
            null;

          if (!mismatch) {
            console.log(`Found existing DBM performance query ID: ${found.queryId}`);
            return { queryId: found.queryId, isNew: false };
          }

          console.log(`Recreating performance query ${found.queryId} because ${mismatch}...`);
          staleQueryId = found.queryId;
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
        dataRange: { range: dataRange },
        format: 'CSV'
      },
      params: {
        type: 'STANDARD',
        groupBys: groupBys,
        metrics: metrics,
        filters: filters
      },
      schedule: {
        frequency: 'DAILY',
        startDate: startDate,
        endDate: endDate
      }
    };

    console.log(
      `Creating new DBM query for partner ${partnerId}, ` +
      (ioIds.length > 0
        ? `scoped to ${ioIds.length} Demand Gen insertion order(s)...`
        : 'scoped to the whole partner (no Demand Gen insertion orders ' +
          'supplied). This pull can exceed the maximum downloadable CSV size ' +
          'on a large partner; it will be rescoped once the entity sync has ' +
          'run...'));
    const res = await this.executeWithBackoff(() =>
      this.dbm.queries.create({ requestBody: queryObj })
    );
    console.log(`Successfully created DBM query ID: ${res.data.queryId}`);

    // Only now is the old query expendable. If the create above had thrown,
    // this line is never reached and the partner keeps its working report.
    if (staleQueryId) {
      try {
        await this.dbm.queries.delete({ queryId: staleQueryId });
        console.log(`Deleted superseded performance query ${staleQueryId}.`);
      } catch (delErr) {
        console.warn(
          `Created ${res.data.queryId} but could not delete superseded query ` +
          `${staleQueryId}: ${delErr.message}. Remove it by hand -- it will go ` +
          'on running daily and occupies a slot against the pageSize 100 lookup ' +
          'that the other reports use to find themselves.');
      }
    }

    return { queryId: res.data.queryId, isNew: true };
  }

  /**
   * Creates or retrieves an existing daily DBM audience performance query for a partner.
   *
   * This is a YOUTUBE report, not a STANDARD one, and it uses the
   * FILTER_TRUEVIEW_* dimensions rather than the audience list dimensions.
   * That is not a stylistic choice. The Display audience family
   * (FILTER_AUDIENCE_LIST, FILTER_USER_LIST, FILTER_AUDIENCE_LIST_TYPE,
   * includeOnlyTargetedUserLists) belongs to the Audience Performance report,
   * which "isn't available for YouTube & partners line items"
   * (https://support.google.com/displayvideo/answer/2650629). Demand Gen is in
   * that family, so those dimensions are accepted by queries.create, run to
   * completion, and return a CSV containing nothing at all -- the worst
   * possible failure mode, because it looks like a working pipeline.
   *
   * Measured on a production partner over 7 days, scoped to its 52 Demand Gen
   * insertion orders: the audience list shape returned 0 rows in every
   * combination tried, while the identical request with the audience
   * dimensions removed returned 795. The shape below returns 1871 rows in 21s.
   *
   * @param {string} partnerId
   * @param {!Array<string>=} insertionOrderIds Demand Gen insertion orders to
   *     restrict the report to. Omitting it falls back to partner scope, which
   *     is correct but slow -- acceptable only before the entity sync has
   *     populated the line items table.
   * @returns {Promise<{queryId: string, isNew: boolean}>}
   */
  async createOrGetAudienceReportQuery(partnerId, insertionOrderIds) {
    const reportTitle = `DV360 DGPulse Audience Report - Partner ${partnerId}`;
    const dataRange = 'LAST_90_DAYS';

    // Declared once so the reuse check below and the create call cannot drift
    // apart. They previously encoded different expectations, which is only
    // harmless while the query never gets created successfully.
    //
    // Every dimension here was added one at a time against a report that was
    // already returning rows, because Bid Manager's rejection message --
    // "The combination of dimensions, metrics, and filters in your report is
    // invalid" -- never names the offending field. Adding several at once
    // tells you nothing.
    //
    // FILTER_MEDIA_PLAN is rejected outright in this combination, so campaign
    // is recovered downstream in materialize_audiences.sql by joining the
    // insertion order to the insertion_orders entity table. FILTER_LINE_ITEM
    // and FILTER_TRUEVIEW_AD_GROUP were both accepted but are left out: they
    // multiply the row count without adding anything the dashboard shows.
    const groupBys = [
      'FILTER_DATE',
      'FILTER_ADVERTISER',
      // Required whenever a cost metric is present. Without it queries.create
      // fails with the unusually clear "Advertiser Currency must be included
      // as a dimension."
      'FILTER_ADVERTISER_CURRENCY',
      // The YouTube-family equivalents of the audience list dimensions.
      // FILTER_TRUEVIEW_AUDIENCE_SEGMENT emits a taxonomy path such as
      // "/Business Services/Business Financial Services"; the _TYPE dimension
      // classifies it, e.g. "In-market segment".
      'FILTER_TRUEVIEW_AUDIENCE_SEGMENT',
      'FILTER_TRUEVIEW_AUDIENCE_SEGMENT_TYPE',
      'FILTER_INSERTION_ORDER'
    ];

    // No conversion metric can accompany the audience segment dimension. All
    // four candidates were rejected at create time, individually:
    //   METRIC_TRUEVIEW_CONVERSION_MANY_PER_VIEW
    //   METRIC_TRUEVIEW_VIEW_THROUGH_CONVERSION
    //   METRIC_TOTAL_CONVERSIONS
    //   the first two together
    // This is why the audience page carries no Conversions, VTC or CPA column.
    // Do not re-add them expecting the report to simply return zeros; it fails
    // to create, which takes the whole report down rather than one column.
    const metrics = [
      'METRIC_IMPRESSIONS',
      'METRIC_CLICKS',
      'METRIC_MEDIA_COST_ADVERTISER',
      'METRIC_MEDIA_COST_USD'
    ];


    // Repeated filter pairs of the same type are OR'd together by Bid Manager,
    // so this scopes the report to the partner's Demand Gen insertion orders.
    //
    // Scoping is what keeps this report fast. A partner-wide audience query
    // never left the QUEUED state within 10 minutes over a 7-day range, while
    // the IO-scoped equivalent completed in well under two. Trimming
    // dimensions instead was measured and made things *worse*, because
    // generation is a small fraction of the total and the rest is queue time
    // proportional to data scanned.
    //
    // It is also the only thing keeping this report Demand Gen only. Unlike
    // every other table in DGPulse, the audience rows carry no lineItemType to
    // filter on downstream, so an unscoped query would silently mix Display
    // and YouTube inventory into the audience page.
    //
    // An empty list degrades to partner scope rather than failing: the entity
    // sync that populates line_items may not have run yet on a fresh install.
    // The caller logs that case; the reuse check below then supersedes the
    // partner-scoped query as soon as the insertion orders are known.
    const ioIds = (insertionOrderIds || []).map(String).filter(Boolean);
    const filters = [{ type: 'FILTER_PARTNER', value: String(partnerId) }];
    for (const ioId of ioIds) {
      filters.push({ type: 'FILTER_INSERTION_ORDER', value: ioId });
    }
    const filterKeys = filters.map(f => `${f.type}:${f.value}`);

    try {
      const existingQueries = await this.executeWithBackoff(() =>
        this.dbm.queries.list({ pageSize: 100 })
      );
      if (existingQueries.data.queries) {
        const found = existingQueries.data.queries.find(
          q => q.metadata && q.metadata.title === reportTitle
        );
        if (found) {
          const params = found.params || {};
          const foundRange = (found.metadata && found.metadata.dataRange &&
                              found.metadata.dataRange.range) || null;

          // Compare the shape rather than probing for individual bad fields, so
          // that any future edit to the arrays above supersedes the deployed
          // query exactly once instead of silently serving stale dimensions.
          //
          // Filters are part of that shape now that they carry the insertion
          // order list. If they were left out, a Demand Gen insertion order
          // created after the query would be excluded from the report forever,
          // with nothing failing anywhere to indicate it. Recreations are
          // therefore expected whenever the IO set changes, not a symptom.
          const foundFilterKeys =
            (params.filters || []).map(f => `${f.type}:${f.value}`);
          // Report type is checked first and deliberately. The deployed query
          // for any existing installation is a STANDARD one, and a STANDARD
          // query whose dimensions happened to match would be reused and go on
          // returning nothing. Comparing the type is what retires it.
          const mismatch =
            (params.type || 'STANDARD') !== 'YOUTUBE' ? `report type is ${params.type || 'STANDARD'}, expected YOUTUBE` :
            foundRange !== dataRange ? `data range is ${foundRange}, expected ${dataRange}` :
            !sameStringSet(params.groupBys, groupBys) ? `groupBys differ (found: ${(params.groupBys || []).join(', ')})` :
            !sameStringSet(params.metrics, metrics) ? `metrics differ (found: ${(params.metrics || []).join(', ')})` :
            !sameStringSet(foundFilterKeys, filterKeys) ? `filters differ (found ${foundFilterKeys.length}, expected ${filterKeys.length})` :
            null;

          if (!mismatch) {
            console.log(`Found existing DBM Audience query ID: ${found.queryId}`);
            return { queryId: found.queryId, isNew: false };
          }

          // Logged in full because a reuse check that never matches recreates
          // the query on every run, and those accumulate against the pageSize
          // above until the other reports stop finding themselves too.
          console.log(`Recreating audience query ${found.queryId} because ${mismatch}...`);
          try {
            await this.dbm.queries.delete({ queryId: found.queryId });
          } catch (delErr) {
            console.warn('Could not delete old audience query, will create a new one:', delErr.message);
          }
        }
      }
    } catch (e) {
      console.warn('Unable to list existing DBM queries, proceeding to create new query:', e.message);
    }

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
        dataRange: { range: dataRange },
        format: 'CSV'
      },
      params: {
        // YOUTUBE, not STANDARD: the FILTER_TRUEVIEW_* dimensions are only
        // valid in a YouTube report. See the comment on this method.
        type: 'YOUTUBE',
        groupBys: groupBys,
        metrics: metrics,
        filters: filters
      },
      schedule: {
        frequency: 'DAILY',
        startDate: startDate,
        endDate: endDate
      }
    };

    const scope = ioIds.length
      ? `${ioIds.length} Demand Gen insertion order(s)`
      : 'the whole partner (no Demand Gen insertion orders supplied)';
    console.log(`Creating new DBM Audience query for partner ${partnerId}, scoped to ${scope}...`);
    const res = await this.executeWithBackoff(() =>
      this.dbm.queries.create({ requestBody: queryObj })
    );
    console.log(`Successfully created DBM Audience query ID: ${res.data.queryId}`);
    return { queryId: res.data.queryId, isNew: true };
  }

  /**
   * Creates or retrieves an existing full-history IO-level spend query.
   *
   * This is intentionally separate from the granular performance report. Budget
   * pacing must be evaluated over an insertion order's whole budget segment,
   * whereas the performance report is capped at LAST_90_DAYS to keep the
   * creative/device/inventory breakdown a manageable size. By dropping those
   * high-cardinality dimensions here, a long range yields roughly one row per
   * insertion order per day, which stays small even over multi-year flights.
   *
   * The query is deliberately left unscheduled. DV360 rejects any query whose
   * schedule is active and whose range exceeds 90 days:
   *
   *   "A report with an active schedule cannot have a date range longer than
   *    90 days."
   *
   * The 90-day cap is a property of the schedule, not of the range, so an
   * ALL_TIME report is perfectly legal as long as frequency is ONE_TIME.
   * Freshness is instead guaranteed by syncDbmIoPacingReport, which triggers
   * queries.run on every sync and waits for that specific run to finish.
   * @param {string} partnerId
   * @returns {Promise<{queryId: string, isNew: boolean}>}
   */
  async createOrGetIoPacingReportQuery(partnerId) {
    const reportTitle = `DV360 DGPulse IO Pacing Report - Partner ${partnerId}`;

    try {
      const existingQueries = await this.executeWithBackoff(() =>
        this.dbm.queries.list({ pageSize: 100 })
      );
      if (existingQueries.data.queries) {
        const found = existingQueries.data.queries.find(
          q => q.metadata && q.metadata.title === reportTitle
        );
        if (found) {
          const existingRange = found.metadata && found.metadata.dataRange && found.metadata.dataRange.range;
          const existingFrequency = found.schedule && found.schedule.frequency;
          if (existingRange === 'ALL_TIME' && existingFrequency === 'ONE_TIME') {
            console.log(`Found existing DBM IO pacing query ID: ${found.queryId}`);
            return { queryId: found.queryId, isNew: false };
          }
          console.log(
            `Recreating IO pacing query ${found.queryId}: has range ${existingRange} / frequency ${existingFrequency}, ` +
            'expected ALL_TIME / ONE_TIME...'
          );
          try {
            await this.dbm.queries.delete({ queryId: found.queryId });
          } catch (delErr) {
            console.warn('Could not delete old IO pacing query, will create a new one:', delErr.message);
          }
        }
      }
    } catch (e) {
      console.warn('Unable to list existing DBM queries, proceeding to create new query:', e.message);
    }

    const queryObj = {
      metadata: {
        title: reportTitle,
        dataRange: { range: 'ALL_TIME' },
        format: 'CSV'
      },
      params: {
        type: 'STANDARD',
        groupBys: [
          'FILTER_DATE',
          'FILTER_PARTNER',
          'FILTER_ADVERTISER',
          'FILTER_ADVERTISER_CURRENCY',
          'FILTER_INSERTION_ORDER'
        ],
        metrics: [
          'METRIC_IMPRESSIONS',
          'METRIC_CLICKS',
          'METRIC_MEDIA_COST_ADVERTISER',
          'METRIC_MEDIA_COST_USD'
        ],
        filters: [
          { type: 'FILTER_PARTNER', value: String(partnerId) }
        ]
      },
      // ONE_TIME means "only runs when queries.run is called", which is what
      // lifts the 90-day range cap. startDate/endDate are only required for
      // recurring frequencies, so the schedule is otherwise empty.
      schedule: {
        frequency: 'ONE_TIME'
      }
    };

    try {
      console.log(`Creating new DBM IO pacing query for partner ${partnerId} (ALL_TIME, unscheduled)...`);
      const res = await this.executeWithBackoff(() =>
        this.dbm.queries.create({ requestBody: queryObj })
      );
      console.log(`Successfully created DBM IO pacing query ID: ${res.data.queryId}`);
      return { queryId: res.data.queryId, isNew: true };
    } catch (err) {
      // Surface just the API message; the default error dumps the entire
      // request object and buries the reason.
      const apiMessage =
        (err.response && err.response.data && err.response.data.error && err.response.data.error.message) ||
        err.message;
      throw new Error(
        `DV360 rejected the IO pacing query for partner ${partnerId}: ${apiMessage}`
      );
    }
  }

  /**
   * Triggers a query and waits for that specific run to complete.
   *
   * getLatestReportDownloadUrl alone is not sufficient for an unscheduled
   * query: it would happily return the report generated by a previous run, so
   * the data would be frozen at whenever the query was first executed. Keying
   * the wait on the reportId returned by queries.run guarantees the caller only
   * ever reads the results of the run it just requested.
   * @param {string} queryId
   * @param {{maxAttempts?: number, intervalMs?: number}=} options
   * @returns {Promise<string|null>} Download URL for the freshly generated CSV
   */
  async runQueryAndWait(queryId, options) {
    const maxAttempts = (options && options.maxAttempts) || 60;
    const intervalMs = (options && options.intervalMs) || 5000;

    const report = await this.runQuery(queryId);
    const reportId = report && report.key && report.key.reportId;
    if (!reportId) {
      console.warn(`queries.run for ${queryId} returned no reportId; falling back to the latest available report.`);
      return this.getLatestReportDownloadUrl(queryId);
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await this.executeWithBackoff(() =>
        this.dbm.queries.reports.get({ queryId: queryId, reportId: reportId })
      );
      const metadata = res.data && res.data.metadata;
      const state = metadata && metadata.status && metadata.status.state;

      if (state === 'DONE') {
        console.log(`Report ${reportId} for query ${queryId} completed.`);
        return metadata.googleCloudStoragePath || null;
      }
      if (state === 'FAILED') {
        const failure = (metadata.status && metadata.status.failure && metadata.status.failure.errorCode) || 'unknown error';
        throw new Error(`DV360 report ${reportId} for query ${queryId} failed: ${failure}`);
      }

      console.log(`Waiting for report ${reportId} (query ${queryId}), state ${state} (attempt ${attempt}/${maxAttempts})...`);
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    console.warn(`Report ${reportId} for query ${queryId} did not finish within the wait window.`);
    return null;
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
   * Retrieves reports for a query and returns the latest completed report's download URL.
   * @param {string} queryId
   * @returns {Promise<string|null>} Download URL for latest CSV
   */
  async getLatestReportDownloadUrl(queryId) {
    const reportsRes = await this.executeWithBackoff(() =>
      this.dbm.queries.reports.list({ queryId: queryId, pageSize: 20 })
    );
    if (!reportsRes.data.reports || reportsRes.data.reports.length === 0) {
      return null;
    }
    const completedReports = (reportsRes.data.reports || [])
      .filter(r => r.metadata && r.metadata.status && r.metadata.status.state === 'DONE' && r.metadata.googleCloudStoragePath)
      .sort((a, b) => {
        const timeA = Number((a.metadata && a.metadata.reportDataEndTimeMs) || (a.key && a.key.reportId) || 0);
        const timeB = Number((b.metadata && b.metadata.reportDataEndTimeMs) || (b.key && b.key.reportId) || 0);
        return timeB - timeA;
      });

    if (completedReports.length > 0) {
      return completedReports[0].metadata.googleCloudStoragePath;
    }
    return null;
  }
}

module.exports = DV360Client;
