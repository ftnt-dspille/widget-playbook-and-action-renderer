#!/usr/bin/env node
"use strict";
const path = require("path");
const { packageWidget } = require("./packager");

const widgetDir = path.resolve(__dirname, "..", "widget");
const outputDir = path.resolve(__dirname, "..", "dist");

packageWidget(widgetDir, outputDir)
  .then((r) => {
    console.log(`packaged ${r.archiveName} (${r.fileCount} files, ${r.size} bytes)`);
    console.log(r.archivePath);
  })
  .catch((e) => {
    console.error(`package failed: ${e.message}`);
    process.exit(1);
  });
