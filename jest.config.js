"use strict";

module.exports = {
  testEnvironment: "jsdom",
  testEnvironmentOptions: {
    url: "http://localhost/actionRendererWidget-dev/",
  },
  testMatch: ["<rootDir>/tests/**/*.test.js"],
};
