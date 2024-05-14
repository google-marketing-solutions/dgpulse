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

const impl = require("./yt")

describe("getAspectRatioFromYouTubeVideoItem", () => {
  test(`GIVEN youtube responds with a video with equal weight and height
            WHEN function is called
            THEN it should return 1.00
            (eventually representing "square")`, () => {
    //Arrange: Given
    const item = {
      player: {
        embedWidth: 500,
        embedHeight: 500
      }
    }
    //Act: WHEN
    const result = impl.getAspectRatioFromYouTubeVideoItem(item)

    //Assert: Then
    expect(result).toBe("1.00")
  })

  test(`GIVEN youtube responds with a video with wide dimensions
            WHEN function is called
            THEN it should return 0.50
            (eventually representing "portrait")`, () => {
    //Arrange: Given
    const item = {
      player: {
        embedWidth: 250,
        embedHeight: 500
      }
    }
    //Act: WHEN
    const result = impl.getAspectRatioFromYouTubeVideoItem(item)

    //Assert: Then
    expect(result).toBe("0.50")
  })

  test(`GIVEN youtube responds with a video with tall dimensions
            WHEN function is called
            THEN it should return 2.00
            (eventually representing "landscape")`, () => {
    //Arrange: Given
    const item = {
      player: {
        embedWidth: 500,
        embedHeight: 250
      }
    }
    //Act: WHEN
    const result = impl.getAspectRatioFromYouTubeVideoItem(item)

    //Assert: Then
    expect(result).toBe("2.00")
  })
})
