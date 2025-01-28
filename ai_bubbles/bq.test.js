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

describe("getInsertQueryForInsights", () => {
  test(`GIVEN 2 data objects
        WHEN function is called with them
        THEN it should return a string
            with exactly 2 INSERT queries
            to the insights table`, () => {
    //Arrange: GIVEN
    const data = [
      {
        insights: "test1",
        table: "anything1",
        headline: "headline1"
      },
      {
        insights: "test2",
        table: "anything2",
        headline: "headline2"
      }
    ]

    //Act: WHEN
    const result =
      impl.getInsertQueryForInsights(data)

    //Assert: THEN
    expect(result.match(/\.insights/g).length).toBe(2)
    expect(result.match(/INSERT/g).length).toBe(2)
  })

  test(`GIVEN 2 data objects
        WHEN function is called with them
        THEN it should return a string
            with exactly 2 INSERT queries
            to the insights table`, () => {
    //Arrange: GIVEN
    const data = [
      {
        insights: "test1"
        // "table" prop missing
      }
    ]

    //Act: WHEN
    const result = () => impl.getInsertQueryForInsights(data);

    //Assert: THEN
    expect(result).toThrow('missing data for insert');
  })

  test(`GIVEN 2 data objects
        WHEN function is called with them
        THEN it should return a string
            with exactly 2 INSERT queries
            to the insights table`, () => {
    //Arrange: GIVEN
    const data = [
      {
        table: "test1"
        // "insights" prop missing
      }
    ]

    //Act: WHEN
    const result = () => impl.getInsertQueryForInsights(data);

    //Assert: THEN
    expect(result).toThrow('missing data for insert');
  })

})
