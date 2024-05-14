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

const helpers = require("./helpers");
const yt = require("./yt");

describe("getVideoAspectRatioCounts", () => {
  test(`GIVEN multiple assets from AdGroupAds in the same account/campaign
                with several videos of square aspect ratio
            WHEN function is called
            THEN it should return an object for that account/campaign
                with the respective count of square videos
                and other ratio counts held as 0`, () => {
    //Arrange: Given
    const data = [
      {
        accountId: 1,
        campaignId: 2,
        videoAspectRatio: 1.0,
      },
      {
        accountId: 1,
        campaignId: 2,
        videoAspectRatio: 1.0,
      },
    ];
    //Act: WHEN
    const result = helpers.getVideoAspectRatioCounts(data);

    //Assert: Then
    expect(result["1_2"].square_video_count).toBe(2);
  });

  test(`GIVEN multiple assets from AdGroupAds in the same account/campaign
                with several videos in different aspect ratios
            WHEN function is called
            THEN it should return an object for that account/campaign
                with the respective count of each type`, () => {
    //Arrange: Given
    const data = [
      {
        accountId: 1,
        campaignId: 2,
        videoAspectRatio: 1.5,
      },
      {
        accountId: 1,
        campaignId: 2,
        videoAspectRatio: 1.0,
      },
      {
        accountId: 1,
        campaignId: 2,
        videoAspectRatio: 0.5,
      },
    ];
    //Act: WHEN
    const result = helpers.getVideoAspectRatioCounts(data);

    //Assert: Then
    expect(result["1_2"].landscape_video_count).toBe(1);
    expect(result["1_2"].square_video_count).toBe(1);
    expect(result["1_2"].portrait_video_count).toBe(1);
  });
});

describe("getAssetsFromAdGroupAds", () => {
  test(`GIVEN 3 AdGroupAds containing campaign_id, account_id
                and asset ids nexted within "dvra_videos"
            WHEN function is called
            THEN it should return a flattened 3 objects collection
                of campaign_id, account_id and asset_id`, () => {
    //Arrange: Given
    const data = [
      {
        account_id: 1,
        campaign_id: 2,
        dvra_videos: ["bla/bla/bla/123"],
      },
      {
        account_id: 1,
        campaign_id: 2,
        dvra_videos: ["bla/bla/bla/123", "yo/yo/yo/456"],
      },
    ];
    //Act: WHEN
    const result = helpers.getAssetsFromAdGroupAds(data);

    //Assert: Then
    expect(result.length).toBe(3);

    expect(result[0].accountId).toBe(1);
    expect(result[0].campaignId).toBe(2);
    expect(result[0].assetId).toBe("123");

    expect(result[1].accountId).toBe(1);
    expect(result[1].campaignId).toBe(2);
    expect(result[1].assetId).toBe("123");

    expect(result[2].accountId).toBe(1);
    expect(result[2].campaignId).toBe(2);
    expect(result[2].assetId).toBe("456");
  });
});

describe("setVideoAspectRatioCounts", () => {
  test(`GIVEN a list of the final BQ records presented in Looker Studio
                AND the combined video counts aggregated
            WHEN function is called
            THEN it should apply the correct video counts aggregates
                to each account_campaign combination`, () => {
    //Arrange: Given
    const campaignsAssetsCount = [
      {
        account_id: 1,
        campaign_id: 2,
        landscape_video_count: 0,
        square_video_count: 0,
        portrait_video_count: 0,
      },
      {
        account_id: 3,
        campaign_id: 4,
        landscape_video_count: 0,
        square_video_count: 0,
        portrait_video_count: 0,
      },
    ];

    const countsByAccountCampaign = {
      "1_2": {
        landscape_video_count: 3,
        square_video_count: 0,
        portrait_video_count: 4,
      },
    };

    //Act: WHEN
    const result = helpers.setVideoAspectRatioCounts(
      campaignsAssetsCount,
      countsByAccountCampaign,
    );

    //Assert: Then
    expect(result.length).toBe(2);

    expect(result[0].landscape_video_count).toBe(3);
    expect(result[0].square_video_count).toBe(0);
    expect(result[0].portrait_video_count).toBe(4);

    expect(result[1].landscape_video_count).toBe(0);
    expect(result[1].square_video_count).toBe(0);
    expect(result[1].portrait_video_count).toBe(0);
  });

  test(`GIVEN a campaignsAssetsCount record contains an image and a video
            WHEN function is called
            THEN it should set has_image_plus_video to true`, () => {
    //Arrange: Given
    const campaignsAssetsCount = [
      {
        account_id: 1,
        campaign_id: 2,
        dmaa_square_mkt_imgs_count: 1,
        portrait_video_count: 0,
      },
    ];

    const countsByAccountCampaign = {
      "1_2": {
        landscape_video_count: 3,
        square_video_count: 0,
        portrait_video_count: 4,
      },
    };

    //Act: WHEN
    const result = helpers.setVideoAspectRatioCounts(
      campaignsAssetsCount,
      countsByAccountCampaign,
    );

    //Assert: Then
    expect(result[0].has_image_plus_video).toBe(true);
  });
});

describe("getAssetFromAdGroupAdsWithVideoRatio", () => {
  beforeEach(() => {
    jest.spyOn(yt, "getSingleVideoAspectRatio").mockReturnValue({});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test(`GIVEN assets are provided
            AND some do not have any video_id
          WHEN function is called
          THEN youtube call should only happen for the ones with video_id
        `, async () => {
    //Arrange: Given
    const assetFromAdGroupAds = [
      { assetId: 1 },
      { assetId: 2 },
      { assetId: 3 },
    ];
    const videoAssets = [
      { asset_id: 1, video_id: "vid1" },
      { asset_id: 3, video_id: "vid2" },
    ];
    //Act: WHEN
    await helpers.getAssetFromAdGroupAdsWithVideoRatio(
      assetFromAdGroupAds,
      videoAssets,
    );

    //Assert: Then
    expect(yt.getSingleVideoAspectRatio).toHaveBeenCalledTimes(2);
  });

  test(`GIVEN assets are provided
            AND some have repeated video_id
          WHEN function is called
          THEN youtube call should only happen for the unique ones
        `, async () => {
    //Arrange: Given
    const assetFromAdGroupAds = [
      { assetId: 1 },
      { assetId: 2 },
      { assetId: 3 },
    ];
    const videoAssets = [
      { asset_id: 1, video_id: "repeated" },
      { asset_id: 2, video_id: "repeated" },
      { asset_id: 3, video_id: "vid2" },
    ];
    //Act: WHEN
    await helpers.getAssetFromAdGroupAdsWithVideoRatio(
      assetFromAdGroupAds,
      videoAssets,
    );

    //Assert: Then
    expect(yt.getSingleVideoAspectRatio).toHaveBeenCalledTimes(2);
  });
});
