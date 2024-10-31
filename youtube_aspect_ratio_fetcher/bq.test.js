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

const impl = require("./bq");

describe("getUpdateQueryForCampaignsAssetsCount", () => {
  test(`GIVEN 2 campaignsAssetsCount objects
            WHEN function is called with them
            THEN it should return a string
                with exactly 2 UPDATE queries
                to the campaigns_assets_count table`, () => {
    //Arrange: GIVEN
    const campaignsAssetsCount = [
      {
        account_id: 1,
        campaign_id: 2,
        landscape_video_count: 0,
        square_video_count: 0,
        portrait_video_count: 0
      },
      {
        account_id: 3,
        campaign_id: 4,
        landscape_video_count: 0,
        square_video_count: 0,
        portrait_video_count: 0
      }
    ]

    //Act: WHEN
    const result =
      impl.getUpdateQueryForCampaignsAssetsCount(campaignsAssetsCount)

    //Assert: THEN
    expect(result.indexOf(".campaigns_assets_count") > 1).toBe(true)
    expect(result.match(/UPDATE/g).length).toBe(2)
  })

  test(`GIVEN a campaignsAssetsCount object with video counts
            WHEN function is called with it
            THEN it should return a string
                with exactly the expected respective counts`, () => {
    //Arrange: GIVEN
    const campaignsAssetsCount = [
      {
        account_id: 1,
        campaign_id: 2,
        landscape_video_count: 44,
        square_video_count: 55,
        portrait_video_count: 66
      }
    ]

    //Act: WHEN
    const result =
      impl.getUpdateQueryForCampaignsAssetsCount(campaignsAssetsCount)

    //Assert: Then
    expect(result.indexOf("landscape_video_count = 44") > 1).toBe(true)
    expect(result.indexOf("square_video_count = 55") > 1).toBe(true)
    expect(result.indexOf("portrait_video_count = 66") > 1).toBe(true)
    expect(result.indexOf("account_id = 1") > 1).toBe(true)
    expect(result.indexOf("campaign_id = 2") > 1).toBe(true)
  })
})




describe("getUpdateQueryForAssetAspectRatio", () => {
  test(`GIVEN 2 assets are provided objects
            WHEN function is called with them
            THEN it should return a string
                with exactly 2 UPDATE queries
                to the assets_performance table`, () => {
    //Arrange: GIVEN
    const assetFromAdGroupAdsWithVideoRatio = [
      {
        asset_id: 1,
        video_aspect_ratio: 1.0
      },
      {
        asset_id: 2,
        video_aspect_ratio: 0.5
      }
    ]

    //Act: WHEN
    const result =
      impl.getUpdateQueryForAssetAspectRatio(assetFromAdGroupAdsWithVideoRatio)

    console.log(result)

    //Assert: THEN
    expect(result.indexOf(".assets_performance") > 1).toBe(true)
    expect(result.match(/assets_performance/g).length).toBe(2)
    expect(result.match(/UPDATE/g).length).toBe(2)
  })

})
