#!/usr/bin/env node
// Pushes or pulls the Pagehouse SQLite database to/from Supabase PostgreSQL.
// Usage:
//   node --env-file-if-exists=.env scripts/supabase-sync.mjs push
//   node --env-file-if-exists=.env scripts/supabase-sync.mjs pull
import { db } from '../src/pagehouse.js';
import '../src/pagehouse-delivery.js';
import '../src/pagehouse-payments.js';
import '../src/pagehouse-requests.js';
import '../src/pagehouse-email.js';
import '../src/pagehouse-library.js';
import { supabaseConfigured, pushDatabaseToSupabase, pullDatabaseFromSupabase } from '../src/supabase.js';

const direction = (process.argv[2] || 'push').toLowerCase();

if (!supabaseConfigured()) {
  console.error('Error: Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env before running supabase-sync.');
  process.exit(1);
}

if (direction === 'pull') {
  const res = await pullDatabaseFromSupabase(db);
  console.log('Pulled from Supabase:', JSON.stringify(res, null, 2));
} else {
  const res = await pushDatabaseToSupabase(db);
  console.log('Pushed to Supabase:', JSON.stringify(res, null, 2));
}
