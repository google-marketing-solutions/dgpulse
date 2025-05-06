/*
 * Copyright 2025 Google LLC
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
var request = require("request");

// TODO: make baseCurrency a parameter during installation
const baseCurrency = "usd";

const baseUrl =
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies";

async function getExchangeRatesFromAPI() {
  const url = `${baseUrl}/${baseCurrency}.json`;
  return new Promise(function (resolve, reject) {
    console.log("Calling Exchange Rate API");
    request(url, function (error, res, body) {
      if (!error && res.statusCode === 200) {
        if (error) reject(error);
        const exchangeRatesResponseBody = JSON.parse(body);
        resolve(exchangeRatesResponseBody);
      } else {
        reject(error);
      }
    });
  });
}

module.exports = {
  getExchangeRatesFromAPI,
};
