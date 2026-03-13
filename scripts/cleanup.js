#!/usr/bin/env node

// scripts/cleanup.js
'use strict';

const { cleanupTemp } = require('../downloader');
const { cleanup: cacheCleanup } = require('../cacheManager');
const { cookieOps } = require('../db');
require('dotenv').config();

async function run() {
  console.log('🧹 Starting cleanup process...');
  
  try {
    // Clean temp files
    const hours = parseInt(process.env.TEMP_RETENTION_HOURS) || 1;
    const tempDeleted = cleanupTemp(hours);
    console.log(`✅ Temp cleanup: ${tempDeleted} files removed`);

    // Clean cache
    const cacheResult = await cacheCleanup();
    console.log(`✅ Cache cleanup: ${cacheResult?.dbDeleted || 0} DB entries, ${cacheResult?.fileDeleted || 0} files removed`);

    // Check expired cookies
    const expiredCookies = cookieOps.checkExpired();
    if (expiredCookies > 0) {
      console.log(`✅ Marked ${expiredCookies} expired cookies`);
    }

    console.log('✅ Cleanup completed successfully!');
  } catch (err) {
    console.error('❌ Cleanup failed:', err.message);
    process.exit(1);
  }
}

run();
