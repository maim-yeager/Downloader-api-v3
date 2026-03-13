#!/usr/bin/env node

// scripts/backup.js
'use strict';

const { backupDatabase, backupCookies, cleanupOldBackups } = require('../backup');
require('dotenv').config();

async function run() {
  console.log('🔄 Starting backup process...');
  
  try {
    // Backup database
    const dbBackup = await backupDatabase();
    if (dbBackup) {
      console.log(`✅ Database backed up: ${dbBackup}`);
    }

    // Backup cookies
    const cookieBackup = await backupCookies();
    if (cookieBackup) {
      console.log(`✅ Cookies backed up: ${cookieBackup}`);
    }

    // Cleanup old backups
    const days = parseInt(process.env.BACKUP_RETENTION_DAYS) || 7;
    const deleted = cleanupOldBackups(days);
    console.log(`🧹 Cleaned up ${deleted} old backup(s)`);

    console.log('✅ Backup completed successfully!');
  } catch (err) {
    console.error('❌ Backup failed:', err.message);
    process.exit(1);
  }
}

run();
