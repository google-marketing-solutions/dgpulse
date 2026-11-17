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
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  getExchangeRatesFromAPI,
  parseEcbXmlToBaseRates,
} = require("./exchangeApi");

const SAMPLE_ECB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <Cube>
    <Cube time='2026-11-09'>
      <Cube currency='USD' rate='1.0800'/>
      <Cube currency='GBP' rate='0.8400'/>
      <Cube currency='JPY' rate='162.00'/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

test("parseEcbXmlToBaseRates converts EUR reference rates into USD-base rates", () => {
  const result = parseEcbXmlToBaseRates(SAMPLE_ECB_XML, "usd");
  assert.equal(result.date, "2026-11-09");
  assert.equal(result.usd.usd, 1);
  assert.ok(Math.abs(result.usd.eur - 1 / 1.08) < 1e-9);
  assert.ok(Math.abs(result.usd.gbp - 0.84 / 1.08) < 1e-9);
  assert.ok(Math.abs(result.usd.jpy - 162.0 / 1.08) < 1e-9);
});

test("getExchangeRatesFromAPI fetches official ECB feed by default", async () => {
  let requestedUrl = null;
  const mockFetch = async (url) => {
    requestedUrl = url;
    return new Response(SAMPLE_ECB_XML, { status: 200 });
  };

  const result = await getExchangeRatesFromAPI({
    fetchImpl: mockFetch,
    pinnedJsonUrl: "",
  });

  assert.equal(
    requestedUrl,
    "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"
  );
  assert.equal(result.date, "2026-11-09");
  assert.equal(result.usd.usd, 1);
  assert.equal(result.usd.jpy, 150);
});

test("getExchangeRatesFromAPI verifies SHA-384 checksum on pinned JSON feed and rejects @latest or bad hashes", async () => {
  const body = JSON.stringify({
    date: "2026-11-09",
    usd: { usd: 1, aed: 3.6725 },
  });
  const validSha384 = crypto
    .createHash("sha384")
    .update(Buffer.from(body, "utf8"))
    .digest("hex");

  const mockFetch = async () => new Response(body, { status: 200 });

  const verified = await getExchangeRatesFromAPI({
    fetchImpl: mockFetch,
    pinnedJsonUrl:
      "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@2026.11.9/v1/currencies/usd.json",
    expectedSha384: validSha384,
  });
  assert.deepEqual(verified, {
    date: "2026-11-09",
    usd: { usd: 1, aed: 3.6725 },
  });

  await assert.rejects(
    () =>
      getExchangeRatesFromAPI({
        fetchImpl: mockFetch,
        pinnedJsonUrl:
          "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
        expectedSha384: validSha384,
      }),
    /Refusing unpinned @latest/i
  );

  await assert.rejects(
    () =>
      getExchangeRatesFromAPI({
        fetchImpl: mockFetch,
        pinnedJsonUrl:
          "http://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@2026.11.9/v1/currencies/usd.json",
        expectedSha384: validSha384,
      }),
    /must use https:/i
  );

  await assert.rejects(
    () =>
      getExchangeRatesFromAPI({
        fetchImpl: mockFetch,
        pinnedJsonUrl:
          "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@2026.11.9/v1/currencies/usd.json",
        expectedSha384: "0".repeat(96),
      }),
    /SHA-384 checksum mismatch/i
  );
});
