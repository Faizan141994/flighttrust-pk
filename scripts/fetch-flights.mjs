#!/usr/bin/env node
// FlightTrust Pakistan — data updater
// Calls Aviationstack once per airline, merges results into data/flights.json.
// Runs inside GitHub Actions so the API key stays secret and every visitor
// shares one cached file (no per-visitor API calls).
//
// Env vars:
//   AVIATIONSTACK_KEY    (required) your Aviationstack access key — set as a GitHub Secret
//   MAX_CALLS_PER_MONTH  (optional) hard budget guard, default 92 (free plan = 100)
//   KEEP_DAYS            (optional) how many days of history to keep, default 120
//   AVIATIONSTACK_BASE   (optional) API base URL, default https://api.aviationstack.com/v1
//   OUTPUT_FILE          (optional) default data/flights.json

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const KEY = process.env.AVIATIONSTACK_KEY;
const BASE = (process.env.AVIATIONSTACK_BASE || 'https://api.apilayer.net/aviationstack/v1').replace(/\/$/, '');
const MAX_CALLS = Number(process.env.MAX_CALLS_PER_MONTH || 92);
const KEEP_DAYS = Number(process.env.KEEP_DAYS || 120);
const OUT = process.env.OUTPUT_FILE || 'data/flights.json';

// PIA, AirSial, AirBlue, SereneAir
const AIRLINES = ['PK', 'PF', 'PA', 'ER'];
// Higher = more final. A later, more-final record replaces an earlier one.
const FINALITY = { cancelled: 3, landed: 3, diverted: 3, incident: 3, active: 2, scheduled: 1 };
// Errors where retrying the other airlines is pointless.
const FATAL = new Set(['usage_limit_reached', 'invalid_access_key', 'missing_access_key', 'inactive_user']);

function minutesBetween(a, b) {
  if (!a || !b) return null;
  const d = (Date.parse(a) - Date.parse(b)) / 60000;
  return Number.isFinite(d) ? Math.round(d) : null;
}

// Shrink one Aviationstack record to what the website needs.
export function normalize(r) {
  const f = r.flight || {}, dep = r.departure || {}, arr = r.arrival || {}, al = r.airline || {};
  if (f.codeshared) return null; // skip partner-marketed codeshares
  const code = String(al.iata || '').toUpperCase();
  if (!AIRLINES.includes(code)) return null;
  const fl = String(f.iata || (f.number ? code + f.number : '')).toUpperCase();
  const d = r.flight_date;
  if (!d || !fl) return null;

  const s = String(r.flight_status || 'unknown').toLowerCase();
  const departed = !!dep.actual || s === 'landed' || s === 'active';
  // Departure delay in minutes (on-time is measured at departure).
  let dl = dep.delay ?? minutesBetween(dep.actual, dep.scheduled);
  if (dl == null && s === 'landed') dl = arr.delay ?? null;
  if (dl == null && departed) dl = 0;
  if (dl != null) dl = Math.max(0, Math.round(dl));

  return {
    d,                                 // flight date YYYY-MM-DD
    a: code,                           // airline IATA
    f: fl,                             // flight number e.g. PK301
    dep: dep.iata || null,
    arr: arr.iata || null,
    st: dep.scheduled || null,         // scheduled departure (airport local time)
    s,                                 // status
    dl: s === 'cancelled' ? null : dl, // departure delay, minutes
    x: departed,                       // has departed / operated
  };
}

export function merge(map, n) {
  const k = `${n.d}|${n.f}`;
  const old = map.get(k);
  if (!old || (FINALITY[n.s] || 0) >= (FINALITY[old.s] || 0)) {
    if (old && n.dl == null && old.dl != null && n.s !== 'cancelled') n.dl = old.dl;
    map.set(k, n);
  }
}

async function callApi(code, base) {
  const url = `${base}/flights?access_key=${encodeURIComponent(KEY)}&airline_iata=${code}&limit=100`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  if (body && body.error) {
    const e = new Error(body.error.message || body.error.type || 'API error');
    e.type = body.error.type || body.error.code;
    throw e;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Array.isArray(body?.data) ? body.data : [];
}

async function loadDb() {
  try {
    const db = JSON.parse(await readFile(OUT, 'utf8'));
    return { meta: db.meta || {}, flights: Array.isArray(db.flights) ? db.flights : [] };
  } catch {
    return { meta: {}, flights: [] };
  }
}

async function main() {
  if (!KEY) {
    console.error('AVIATIONSTACK_KEY is not set. Add it under repo Settings → Secrets and variables → Actions.');
    process.exit(1);
  }

  const db = await loadDb();
  const map = new Map();
  db.flights.forEach(f => map.set(`${f.d}|${f.f}`, f));

  const month = new Date().toISOString().slice(0, 7);
  const calls = { ...(db.meta.calls || {}) };
  let used = calls[month] || 0;
  const errors = [];
  let fetched = 0;

  for (const code of AIRLINES) {
    if (used >= MAX_CALLS) {
      errors.push(`Monthly budget reached (${used}/${MAX_CALLS}) — skipped ${code}`);
      continue;
    }
    try {
      let rows;
      used++;
      try {
        rows = await callApi(code, BASE);
      } catch (e) {
        // Some free keys are HTTP-only; retry once over HTTP (server-side, so no mixed-content issue).
        if (e.type === 'https_access_restricted' && BASE.startsWith('https:') && used < MAX_CALLS) {
          used++;
          rows = await callApi(code, BASE.replace(/^https:/, 'http:'));
        } else throw e;
      }
      let kept = 0;
      for (const r of rows) {
        const n = normalize(r);
        if (n) { merge(map, n); kept++; }
      }
      fetched += kept;
      console.log(`${code}: ${rows.length} rows from API, ${kept} kept`);
    } catch (e) {
      errors.push(`${code}: ${e.message}`);
      console.error(`${code}: ${e.type || ''} ${e.message}`);
      if (FATAL.has(e.type)) break;
    }
  }

  // Keep only the last KEEP_DAYS days.
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  const flights = [...map.values()]
    .filter(f => f.d >= cutoff)
    .sort((a, b) => (b.d.localeCompare(a.d)) || String(b.st).localeCompare(String(a.st)));

  calls[month] = used;
  // Keep only the last 3 months of call counters.
  Object.keys(calls).sort().slice(0, -3).forEach(k => delete calls[k]);

  const now = new Date().toISOString();
  const out = {
    meta: {
      source: 'aviationstack',
      updated_at: fetched > 0 ? now : (db.meta.updated_at || null),
      last_run_at: now,
      last_run_errors: errors,
      calls,
      budget: MAX_CALLS,
      flight_count: flights.length,
    },
    flights,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out));
  console.log(`Saved ${flights.length} flights · API calls this month: ${used}/${MAX_CALLS}`);

  if (fetched === 0 && errors.length) process.exit(1); // flag the run as failed in GitHub
}

if (import.meta.url === `file://${process.argv[1]}`) main();
