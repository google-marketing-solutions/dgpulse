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

const baseUrl = "https://youtube.googleapis.com/youtube/v3/videos";
const key = process.env.YOUTUBE_API_KEY;

async function getSingleVideoAspectRatio(videoId) {
  const url = `${baseUrl}?part=player&id=${videoId}&maxWidth=500&key=${key}`;
  return new Promise((resolve, reject) => {
    console.log("Calling YouTube for video:", videoId);
    request(url, (error, res, body) => {
      if (error) {
        return reject(error);
      }
      if (res.statusCode === 200) {
        const item = JSON.parse(body).items[0];
        if (!item) {
          console.log(`No item for YouTube video: ${videoId}`);
          return resolve(0);
        } else {
          const aspectRatio = getAspectRatioFromYouTubeVideoItem(item);
          return resolve(aspectRatio);
        }
      } else {
        return reject(new Error(`Unexpected status code ${res.statusCode}`));
      }
    });
  });
}

function getAspectRatioFromYouTubeVideoItem(item) {
  return (item.player.embedWidth / item.player.embedHeight).toFixed(2);
}

module.exports = {
  getSingleVideoAspectRatio,
  getAspectRatioFromYouTubeVideoItem,
};
