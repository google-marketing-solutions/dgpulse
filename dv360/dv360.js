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
    const response = await this.executeWithBackoff(() =>
      this.dv360.advertisers.get({ advertiserId: advertiserId })
    );
    return response.data;
  }

  /**
   * Fetches all 1st and 3rd party audience lists for a given advertiser.
   * Used to check for active CRM / 1PD and Google Analytics linked audiences.
   * @param {string} advertiserId
   * @returns {Promise<Object[]>}
   */
  async getFirstAndThirdPartyAudiences(advertiserId) {
    let audiences = [];
    let nextPageToken = null;
    try {
      do {
        const response = await this.executeWithBackoff(() =>
          this.dv360.firstAndThirdPartyAudiences.list({
            advertiserId: advertiserId,
            pageToken: nextPageToken,
            pageSize: 100
          })
        );
        if (response.data.firstAndThirdPartyAudiences) {
          audiences = audiences.concat(response.data.firstAndThirdPartyAudiences);
        }
        nextPageToken = response.data.nextPageToken;
      } while (nextPageToken);
    } catch (e) {
      console.warn(`Warning fetching audiences for advertiser ${advertiserId}:`, e.message);
    }
    return audiences;
  }

  /**
   * Fetches all Floodlight activities under a Floodlight group.
   * Used to check for Enhanced Conversions and web tag implementations.
   * @param {string} floodlightGroupId
   * @param {string} partnerId
   * @returns {Promise<Object[]>}
   */
  async getFloodlightActivities(floodlightGroupId, partnerId) {
    let activities = [];
    let nextPageToken = null;
    try {
      do {
        const response = await this.executeWithBackoff(() =>
          this.dv360.floodlightGroups.floodlightActivities.list({
            floodlightGroupId: floodlightGroupId,
            partnerId: partnerId,
            pageToken: nextPageToken,
            pageSize: 100
          })
        );
        if (response.data.floodlightActivities) {
          activities = activities.concat(response.data.floodlightActivities);
        }
        nextPageToken = response.data.nextPageToken;
      } while (nextPageToken);
    } catch (e) {
      console.warn(`Warning fetching floodlight activities for group ${floodlightGroupId}:`, e.message);
    }
    return activities;
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
   * Creates or retrieves an existing daily DBM report query for a partner.
   * @param {string} partnerId
   * @returns {Promise<{queryId: string, isNew: boolean}>}
   */
  async createOrGetPerformanceReportQuery(partnerId) {
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
      'METRIC_VIDEO_COMPLETION_RATE',
      // Pacing and constraint signals. io_goal_pacing_pct, lost_is_budget and
      // lost_is_rank are exposed by all three performance materializations and
      // were fed hardcoded zeros until now.
      //
      // The lost impression share pair is the real answer to "is this campaign
      // limited by budget". The dashboard currently infers that from paused
      // entity status, which is a proxy for a signal that was available the
      // whole time.
      'METRIC_PERCENTAGE_FROM_CURRENT_IO_GOAL',
      'METRIC_TRUEVIEW_LOST_IS_BUDGET',
      'METRIC_TRUEVIEW_LOST_IS_RANK'
    ];

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
          const mismatch =
            foundRange !== dataRange ? `data range is ${foundRange}, expected ${dataRange}` :
            !sameStringSet(params.groupBys, groupBys) ? `groupBys differ (found ${(params.groupBys || []).length}, expected ${groupBys.length})` :
            !sameStringSet(params.metrics, metrics) ? `metrics differ (found ${(params.metrics || []).length}, expected ${metrics.length})` :
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
   * Measured on partner 6631618296 over 7 days, scoped to its 52 Demand Gen
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
