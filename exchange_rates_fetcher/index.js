//  Copyright 2024 Google LLC
//
//  Licensed under the Apache License, Version 2.0 (the "License");
//  you may not use this file except in compliance with the License.
//  You may obtain a copy of the License at
//
//    https://www.apache.org/licenses/LICENSE-2.0
//
//  Unless required by applicable law or agreed to in writing, software
//  distributed under the License is distributed on an "AS IS" BASIS,
//  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//  See the License for the specific language governing permissions and
//  limitations under the License.

const functions = require("@google-cloud/functions-framework");
const exchangeApi = require("./exchangeApi");
const bq = require("./bq");

functions.http("exchangeRatesGET", async (req, res) => {
  const exchangeRates = await exchangeApi.getExchangeRatesFromAPI();
  await bq.deleteExchangeRates();
  const insertQueryForExchangeRates = bq.insertExchangeRates(exchangeRates);
  res.send(
    "BigQuery INSERTs queued for execution and should complete in seconds."
  );
});
