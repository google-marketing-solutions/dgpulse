/**
 * @fileoverview Scalable YouTube Aspect Ratio Fetcher for DV360 Demand Gen ads.
 * Lift-and-shift adapted from dgpulse/youtube_aspect_ratio_fetcher.
 * 
 * Fetches embed player dimensions from YouTube Data API v3 and calculates exact aspect ratio:
 * - aspectRatio < 1.0 -> Portrait / Vertical (9:16 Shorts)
 * - aspectRatio = 1.0 -> Square (1:1)
 * - aspectRatio > 1.0 -> Landscape / Horizontal (16:9)
 */
const https = require('https');
const fs = require('fs');
const { Storage } = require('@google-cloud/storage');

const storage = new Storage();

let cachedApiKey = process.env.YOUTUBE_API_KEY || null;

/**
 * Discovers the YouTube API key from env, local file, or GCS bucket.
 * @param {string} [bucketName]
 * @returns {Promise<string|null>}
 */
async function getYouTubeApiKey(bucketName) {
  if (cachedApiKey) return cachedApiKey;

  if (process.env.YOUTUBE_API_KEY) {
    cachedApiKey = process.env.YOUTUBE_API_KEY;
    return cachedApiKey;
  }

  // Check local .env or key file
  if (fs.existsSync('youtube_api_key.txt')) {
    try {
      cachedApiKey = fs.readFileSync('youtube_api_key.txt', 'utf8').trim();
      return cachedApiKey;
    } catch (e) {}
  }

  // Check GCS bucket
  const bucket = bucketName || process.env.BUCKET_NAME;
  if (bucket) {
    try {
      const [exists] = await storage.bucket(bucket).file('youtube_api_key.txt').exists();
      if (exists) {
        const [content] = await storage.bucket(bucket).file('youtube_api_key.txt').download();
        cachedApiKey = content.toString().trim();
        return cachedApiKey;
      }
    } catch (e) {}
  }

  return null;
}

/**
 * Calls YouTube Data API v3 videos.list for up to 50 video IDs in a single batch request.
 * @param {string[]} videoIds
 * @param {string} apiKey
 * @returns {Promise<Map<string, number>>} Map of videoId -> aspectRatio
 */
async function fetchBatchVideoAspectRatios(videoIds, apiKey) {
  const resultMap = new Map();
  if (!videoIds || videoIds.length === 0 || !apiKey) return resultMap;

  // Batch into chunks of 50 (YouTube API maximum per request)
  for (let i = 0; i < videoIds.length; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    const idParam = chunk.map(encodeURIComponent).join(',');
    const url = `https://youtube.googleapis.com/youtube/v3/videos?part=player&id=${idParam}&maxWidth=500&key=${encodeURIComponent(apiKey)}`;

    try {
      const body = await new Promise((resolve, reject) => {
        https.get(url, (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            if (res.statusCode === 200) {
              resolve(data);
            } else {
              reject(new Error(`YouTube API returned status ${res.statusCode}: ${data}`));
            }
          });
        }).on('error', reject);
      });

      const parsed = JSON.parse(body);
      if (parsed.items && Array.isArray(parsed.items)) {
        for (const item of parsed.items) {
          if (item.id && item.player && item.player.embedWidth && item.player.embedHeight) {
            const ratio = Number((item.player.embedWidth / item.player.embedHeight).toFixed(2));
            resultMap.set(item.id, ratio);
          }
        }
      }
    } catch (err) {
      console.warn(`Warning fetching batch aspect ratios for [${chunk.join(', ')}]:`, err.message);
    }
  }

  return resultMap;
}

/**
 * Resolves aspect ratios for an array of video IDs.
 * Utilizes BigQuery video_aspect_ratio table as a cache to prevent redundant API calls.
 * 
 * @param {string[]} videoIds
 * @param {Object} bigquery - @google-cloud/bigquery instance
 * @param {string} datasetId
 * @param {string} [bucketName]
 * @returns {Promise<Map<string, number>>} Map of videoId -> aspectRatio
 */
async function resolveVideoAspectRatios(videoIds, bigquery, datasetId, bucketName) {
  const resultMap = new Map();
  const uniqueIds = [...new Set(videoIds.filter(Boolean))];
  if (uniqueIds.length === 0) return resultMap;

  // 1. Ensure video_aspect_ratio table exists
  try {
    await bigquery.query({
      query: `CREATE TABLE IF NOT EXISTS \`${datasetId}.video_aspect_ratio\` (
                video_id STRING,
                aspect_ratio FLOAT64,
                updated_at TIMESTAMP
              )`
    });
  } catch (e) {}

  // 2. Check existing cached aspect ratios from BigQuery
  const idsInQuery = uniqueIds.map(id => `'${id}'`).join(',');
  try {
    const [cachedRows] = await bigquery.query({
      query: `SELECT video_id, aspect_ratio 
              FROM \`${datasetId}.video_aspect_ratio\`
              WHERE video_id IN (${idsInQuery}) AND aspect_ratio IS NOT NULL`
    });

    for (const row of cachedRows) {
      resultMap.set(row.video_id, Number(row.aspect_ratio));
    }
  } catch (e) {
    console.warn('Could not read from video_aspect_ratio cache:', e.message);
  }

  // 3. Identify uncached video IDs
  const uncachedIds = uniqueIds.filter(id => !resultMap.has(id));
  if (uncachedIds.length === 0) {
    return resultMap;
  }

  console.log(`Found ${uncachedIds.length} uncached YouTube video(s) to inspect: ${uncachedIds.join(', ')}`);

  // 4. Discover YouTube API Key and fetch
  const apiKey = await getYouTubeApiKey(bucketName);
  if (!apiKey) {
    console.warn('YOUTUBE_API_KEY not found. Video aspect ratios will default based on fallback.');
    return resultMap;
  }

  const fetchedMap = await fetchBatchVideoAspectRatios(uncachedIds, apiKey);
  const now = new Date().toISOString();
  const rowsToInsert = [];

  for (const [vid, ratio] of fetchedMap.entries()) {
    resultMap.set(vid, ratio);
    rowsToInsert.push({
      video_id: vid,
      aspect_ratio: ratio,
      updated_at: now
    });
  }

  // 5. Cache newly fetched aspect ratios into BigQuery
  if (rowsToInsert.length > 0) {
    try {
      await bigquery.dataset(datasetId).table('video_aspect_ratio').insert(rowsToInsert);
      console.log(`✓ Cached ${rowsToInsert.length} video aspect ratios into ${datasetId}.video_aspect_ratio.`);
    } catch (insertErr) {
      console.warn('Warning caching to video_aspect_ratio table:', insertErr.message);
    }
  }

  return resultMap;
}

module.exports = {
  getYouTubeApiKey,
  fetchBatchVideoAspectRatios,
  resolveVideoAspectRatios
};
