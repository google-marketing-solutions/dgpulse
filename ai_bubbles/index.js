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
const functions = require("@google-cloud/functions-framework");

const bq = require("./bq");
const gemini = require("./gemini");

functions.http("aiBubblesGET", async (req, res) => {

  const inserts = [];
  // campaign_data is the table for the "Bid and Bugdet" in the UI:
  inserts.push(
    await gemini.getInsightsAndHeadlineForTable('campaign_data'));
  // campaign_assets_count represents "Creative Asset Coverage" in the UI:
  inserts.push(
    await gemini.getInsightsAndHeadlineForTable('campaigns_assets_count'));

  await bq.insertIntoInsights(inserts);

  res.send("Finished");
});
