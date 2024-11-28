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

const fs = require('fs');
const tmp = require('tmp');
const json2csv = require("json-2-csv");
const functions = require("@google-cloud/functions-framework");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleAIFileManager } = require("@google/generative-ai/server");

const bq = require("./bq");

const GOOGLE_GENERATIVEAI_API_KEY = process.env.GEMINI_API_KEY;

// Configurable constants:
const personaInstructions = `
  You are a Google Ads Campaign Performance specialist.
  `;

const formattingInstructions = `
  Give me a single paragraph summarizing what I should do including the top accounts I should act on.
  If you did not receive a file, please let me know.
  Your answer should contain only plain text and around 500 characters.
  `;

const promptsByTableName = {
  campaign_data : `
    The file attached contains a list of Google Ads Demand Gen campaigns and respective budget spend.

    Best practices for Demand Gen campaigns are:
    1. Limit bid changes to +/- 15% during the Learning Period (until 50+ conversions are collected)
    2. As a minimum baseline, we recommend that advertisers support their budget with at least $100 per day at the campaign level to make sure your campaign has enough budget to compete in Google's auctions.

    Which accounts do you think I should start actioning immediately on?
    `
};


functions.http("aiBubblesGET", async (req, res) => {
  const campaignData = await bq.getCampaignData();
  await getRespectivePromptResponse(campaignData, 'campaign_data');
  res.send("Finished");
});

async function getRespectivePromptResponse(data, table) {
  try {
    // store in temp CSV
    const csv = json2csv.json2csv(data);
    const tmpFile = tmp.fileSync(); 
    fs.writeFileSync(tmpFile.name, csv);
    
    // upload to Google AI Storage
    const uploadResult = await uploadFileToGoogleAiStorage(tmpFile.name, table);

    // Talk to Gemini
    const geminiTextResponse = await getGeminiResponseFromCSV(uploadResult, table);
    console.log('geminiTextResponse:', geminiTextResponse);
    await bq.insertIntoInsights([{ insights: geminiTextResponse, table }]);
    
  } catch (error) {
    console.error('Error:', error);
  }
}

async function uploadFileToGoogleAiStorage(csvName, table) {
  const fileManager = new GoogleAIFileManager(GOOGLE_GENERATIVEAI_API_KEY);
  const uploadResult = await fileManager.uploadFile(csvName, {
    mimeType: "text/plain",
    displayName: table,
  });
  console.log(
    `Uploaded CSV file ${uploadResult.file.displayName} as: ${uploadResult.file.uri}`
  );
  return uploadResult;
}

async function getGeminiResponseFromCSV(uploadResult, table) {
  const genAI = new GoogleGenerativeAI(GOOGLE_GENERATIVEAI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
  const result = await model.generateContent([
    personaInstructions + promptsByTableName[table] + formattingInstructions,
    {
      fileData: {
        fileUri: uploadResult.file.uri,
        mimeType: uploadResult.file.mimeType,
      },
    },
  ]);
  return result.response.text();
}