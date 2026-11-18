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
const crypto = require("node:crypto");

// TODO: make baseCurrency a parameter during installation
const DEFAULT_BASE_CURRENCY = "usd";

// Official European Central Bank (ECB) daily reference FX feed over HTTPS.
const DEFAULT_ECB_XML_URL =
  "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";

const FETCH_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MiB safety cap
const SHA384_HEX_REGEX = /^[a-fA-F0-9]{96}$/;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function assertSafeHttpsUrl(rawUrl, allowUnpinned = false) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid exchange-rate feed URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Exchange-rate feed URL must use https:.");
  }
  if (!allowUnpinned && /@latest(?:\/|$)/i.test(parsed.pathname)) {
    throw new Error(
      "Refusing unpinned @latest exchange-rate URL; pin an immutable version and set EXCHANGE_RATES_JSON_SHA384."
    );
  }
  return parsed.toString();
}

function verifySha384(buffer, expectedHex) {
  if (typeof expectedHex !== "string" || !SHA384_HEX_REGEX.test(expectedHex)) {
    throw new Error(
      "EXCHANGE_RATES_JSON_SHA384 must be a 96-character hex SHA-384 digest."
    );
  }
  const actualDigest = crypto.createHash("sha384").update(buffer).digest();
  const expectedDigest = Buffer.from(expectedHex.toLowerCase(), "hex");
  if (
    actualDigest.length !== expectedDigest.length ||
    !crypto.timingSafeEqual(actualDigest, expectedDigest)
  ) {
    throw new Error("Exchange-rate feed SHA-384 checksum mismatch.");
  }
}

async function readBoundedBuffer(response, maxBytes = MAX_RESPONSE_BYTES) {
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > maxBytes) {
    throw new Error(
      `Exchange-rate response exceeded ${maxBytes} byte safety limit.`
    );
  }
  return Buffer.from(arrayBuffer);
}

function parseEcbXmlToBaseRates(xmlText, baseCurrency = DEFAULT_BASE_CURRENCY) {
  if (typeof xmlText !== "string" || xmlText.length === 0) {
    throw new Error("Empty ECB XML response.");
  }
  const normalizedBase = baseCurrency.toLowerCase();
  if (!/^[a-z]{3}$/.test(normalizedBase)) {
    throw new Error(`Invalid base currency: ${baseCurrency}`);
  }

  const timeMatch = xmlText.match(
    /<Cube\s+time\s*=\s*['"](\d{4}-\d{2}-\d{2})['"]\s*>/
  );
  if (!timeMatch || !ISO_DATE_REGEX.test(timeMatch[1])) {
    throw new Error("ECB XML feed missing valid <Cube time='YYYY-MM-DD'> tag.");
  }
  const date = timeMatch[1];

  const eurRates = Object.create(null);
  eurRates.eur = 1;

  const cubeTagRegex = /<Cube\b([^>]*?)\/?>/g;
  let match;
  while ((match = cubeTagRegex.exec(xmlText)) !== null) {
    const attrs = match[1];
    const currencyMatch = attrs.match(
      /\bcurrency\s*=\s*['"]([A-Za-z]{3})['"]/
    );
    const rateMatch = attrs.match(
      /\brate\s*=\s*['"]([0-9]+(?:\.[0-9]+)?)['"]/
    );
    if (!currencyMatch || !rateMatch) {
      continue;
    }
    const code = currencyMatch[1].toLowerCase();
    const numericRate = Number(rateMatch[1]);
    if (!Number.isFinite(numericRate) || numericRate <= 0) {
      throw new Error(`Invalid rate in ECB XML for currency ${code}.`);
    }
    eurRates[code] = numericRate;
  }

  const basePerEur = eurRates[normalizedBase];
  if (typeof basePerEur !== "number" || !Number.isFinite(basePerEur) || basePerEur <= 0) {
    throw new Error(
      `Base currency '${normalizedBase}' not present in ECB reference feed.`
    );
  }

  const convertedRates = {};
  for (const [code, eurRate] of Object.entries(eurRates)) {
    convertedRates[code] = code === normalizedBase ? 1 : eurRate / basePerEur;
  }

  return {
    date,
    [normalizedBase]: convertedRates,
  };
}

async function getExchangeRatesFromAPI(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const baseCurrency = (
    options.baseCurrency ||
    process.env.EXCHANGE_RATES_BASE_CURRENCY ||
    DEFAULT_BASE_CURRENCY
  ).toLowerCase();
  const pinnedJsonUrl =
    options.pinnedJsonUrl !== undefined
      ? options.pinnedJsonUrl
      : process.env.EXCHANGE_RATES_JSON_URL;
  const expectedSha384 =
    options.expectedSha384 !== undefined
      ? options.expectedSha384
      : process.env.EXCHANGE_RATES_JSON_SHA384;

  if (pinnedJsonUrl) {
    const validatedUrl = assertSafeHttpsUrl(pinnedJsonUrl, false);
    console.log("Calling pinned JSON Exchange Rate feed");
    const response = await fetchImpl(validatedUrl, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `Exchange-rate feed returned HTTP ${response.status}.`
      );
    }
    const rawBuffer = await readBoundedBuffer(response);
    verifySha384(rawBuffer, expectedSha384);
    return JSON.parse(rawBuffer.toString("utf8"));
  }

  const ecbUrl = assertSafeHttpsUrl(
    options.ecbXmlUrl || process.env.EXCHANGE_RATES_ECB_URL || DEFAULT_ECB_XML_URL,
    true
  );
  console.log("Calling official ECB Exchange Rate feed");
  const response = await fetchImpl(ecbUrl, {
    method: "GET",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`ECB exchange-rate feed returned HTTP ${response.status}.`);
  }
  const rawBuffer = await readBoundedBuffer(response);
  return parseEcbXmlToBaseRates(rawBuffer.toString("utf8"), baseCurrency);
}

module.exports = {
  getExchangeRatesFromAPI,
  parseEcbXmlToBaseRates,
  verifySha384,
};
