/// <reference types="vite/client" />
import { createClient } from '@supabase/supabase-js';

// Use Vite's import.meta.env for client-side environment variables,
// falling back to the provided credentials if not set.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://udtagjjjswqarppxjvde.supabase.co';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_u1vOt9PYQTDwG7Rni6M8Yw_oOEhMFOO';

export const isSupabaseConfigured = supabaseUrl !== 'https://placeholder.supabase.co';
export const supabase = createClient(supabaseUrl, supabaseAnonKey);
