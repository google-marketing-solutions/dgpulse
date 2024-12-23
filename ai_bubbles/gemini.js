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
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleAIFileManager } = require("@google/generative-ai/server");

const bq = require("./bq");

const GOOGLE_GENERATIVEAI_API_KEY = process.env.GEMINI_API_KEY;

// Configurable constants:
const promptsByTableName = {
  campaign_data: {
    insights: {
      roleAndTask: `
      I am a Google Ads Campaign performance specialist working on Demand Gen
      campaigns. I would like you to help me understand which accounts are not
      adopting Demand Gens best practices and need my immediate attention.
      Can you help me identify the top 3 accounts which are not adopting the
      best practices?`,

      contextAndExamples: `
      I have attached a file to help with this analysis 
      with an explanation of what's included.  If you do not receive a file,
      please let me know.
      
      Bid & Budget contains campaign performance data including conversions,
      daily budget and whether a campaign has a lookalike audience.

      Best practices for Demand Gen campaigns are:

      1. Limit bid changes to +/- 15% during the Learning Period (until 50+
      conversions are collected)
      2. As a minimum baseline, we recommend that advertisers support their
      budget with at least $100 per day at the campaign level to make sure
      your campaign has enough budget to compete in Google's auctions.
      3. Include at least one lookalike for each campaign

      Which accounts do you think I should start actioning immediately?
      I am keen to understand which accounts are not adopting these best
      practices and where there are opportunities to optimise. It would be
      great to highlight the best performing account in terms of best practice
      adoption.`,

      requirementsAndInstructions: `
      I would like you to write me summary as follows:
      The summary should be a single paragraph written in enthusiastic and
      concise business language in no more than 400 characters. It should
      include the names of at least 3 accounts I should take action on and
      1 account which has adopted all of the best practices.`
    },
    headline: {
      roleAndTask: `
      Take the summary below and produce a 1 sentence headline:`,
      requirementsAndInstructions: `
      The headline should be written with an attention grabbing headline that a
      senior manager would respond positively to.  It should be concise.`
    }
  },
  campaign_assets_count: {
    insights: {
      roleAndTask: `
      I am a Google Ads Campaign performance specialist working on Demand Gen
      campaigns. I would like you to help me understand which accounts are not
      adopting Demand Gen’s creative best practices in terms of asset coverage.`,

      contextAndExamples: `
      I have attached a file to help with this analysis with an explanation of
      what's included.  If you do not receive a file, please let me know.
      
      The file contains creative asset coverage information as well as a column
      to indicate whether a product feed is included.
      
      The best practice for Demand Gen campaigns is as follows:
      Use Image & Video together for better performance. Including 3 of each
      image format (vertical, horizontal), 3 of each video format (horizontal,
      vertical) and at least three descriptions and 3  headlines in each of
      your ad groups.`,

      requirementsAndInstructions: `
      I would like you to write me summary paragraph  written in enthusiastic
      and concise business language in no more than 400 characters. It should
      include the names of at least 3 accounts I should take action on and 1
      account which has adopted all of the best practices.  What are the 3
      accounts you think I should start actioning immediately? I’m keen to
      understand which accounts are not adopting these best practices and where
      there are opportunities to optimise. It would be great to highlight the
      best performing campaign in terms of asset coverage and why it's
      important for Demand Gen campaigns. Please do not repeat the best
      practices back to me.`
    },
    headline: {
      roleAndTask: `
      You are a Google Ads Campaign performance specialist working on Demand Gen
      campaigns. Take the summary below and produce a 1 sentence headline:`,
      requirementsAndInstructions: `
      The headline should be written with an attention grabbing headline that a
      senior manager would respond positively to. It should be concise.`
    }
  }
};

async function getInsightsAndHeadlineForTable(table) {
  const data = await bq.getCampaignData();
  const uploadResult = await storeCsvForLater(data, table);
  const insights
    = await this.getRespectivePromptResponse(uploadResult, table);
  console.log('insights', insights)
  const headline
    = await this.getRespectivePromptResponse(uploadResult, table, insights);
  return { insights, headline, table };
}

async function getRespectivePromptResponse(uploadResult, table, insights) {
  try {
    // Talk to Gemini
    const geminiTextResponse
      = await getGeminiResponseFromCSV(uploadResult, table, insights);
    console.log('geminiTextResponse:', geminiTextResponse);
    
  } catch (error) {
    console.error('Error:', error);
  }
}

async function storeCsvForLater(data, table) {
  const csv = json2csv.json2csv(data);
  const tmpFile = tmp.fileSync();
  fs.writeFileSync(tmpFile.name, csv);
  const uploadResult = await uploadFileToGoogleAiStorage(tmpFile.name, table);
  return uploadResult;
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

async function getGeminiResponseFromCSV(
  uploadResult, table, insights) {
  const genAI = new GoogleGenerativeAI(GOOGLE_GENERATIVEAI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
  const promptType = insights ? 'headline' : 'insights';
  const prompt = promptsByTableName[table][promptType].roleAndTask
    + (promptsByTableName[table][promptType].contextAndExamples || insights)
    + promptsByTableName[table][promptType].requirementsAndInstructions;
    
  console.log('prompt:' + promptType + " -- "+ prompt)
  
  const result = await model.generateContent([
    prompt,
    {
      fileData: {
        fileUri: uploadResult.file.uri,
        mimeType: uploadResult.file.mimeType,
      },
    },
  ]);
  return result.response.text();
}


module.exports = {
  getInsightsAndHeadlineForTable,
  getRespectivePromptResponse,
  uploadFileToGoogleAiStorage,
  getGeminiResponseFromCSV
};