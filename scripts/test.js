#!/usr/bin/env node

// scripts/test.js
'use strict';

const axios = require('axios');
require('dotenv').config();

const API_URL = `http://localhost:${process.env.PORT || 3002}`;
const API_KEY = process.env.API_KEY;

async function test() {
  console.log('🧪 Starting API tests...\n');

  const headers = API_KEY ? { 'X-API-Key': API_KEY } : {};

  // Test 1: Health check
  try {
    const health = await axios.get(`${API_URL}/health`, { headers });
    console.log('✅ Health check:', health.data.status);
  } catch (err) {
    console.error('❌ Health check failed:', err.message);
  }

  // Test 2: YouTube URL extract
  try {
    const extract = await axios.post(`${API_URL}/api/extract`, {
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    }, { headers });
    console.log('✅ Extract test:', extract.data.title?.substring(0, 50));
  } catch (err) {
    console.error('❌ Extract test failed:', err.message);
  }

  // Test 3: Preview
  try {
    const preview = await axios.get(`${API_URL}/api/preview`, {
      params: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
      headers
    });
    console.log('✅ Preview test:', preview.data.platform);
  } catch (err) {
    console.error('❌ Preview test failed:', err.message);
  }

  // Test 4: Stats
  try {
    const stats = await axios.get(`${API_URL}/api/stats`, { headers });
    console.log('✅ Stats test:', stats.data.total_downloads);
  } catch (err) {
    console.error('❌ Stats test failed:', err.message);
  }

  console.log('\n✅ Tests completed!');
}

test();
