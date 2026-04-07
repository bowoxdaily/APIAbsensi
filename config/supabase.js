const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || 'attlogs';

function getSupabaseConfig() {
  return {
    url: SUPABASE_URL,
    key: SUPABASE_SERVICE_ROLE_KEY,
    table: SUPABASE_TABLE,
  };
}

function hasSupabaseConfig() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function getSupabaseClient() {
  if (!hasSupabaseConfig()) {
    return null;
  }

  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

module.exports = {
  getSupabaseClient,
  getSupabaseConfig,
  hasSupabaseConfig,
};
