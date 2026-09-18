/* ============================================================
 * DEMS — Fabric Gateway Backend  (VERSION 3.0)
 *   v2.0 features: IPFS off-chain storage integration
 *   v3.0 adds: multi-officer identity support
 *
 * v3.0 loads every enrolled named-officer identity (from both
 * Org1 and Org2), exposes them via GET /api/officers, and signs
 * each RegisterEvidence transaction as the officer chosen in the
 * request. Officers in Org2 are routed through the Org2 peer so
 * that Org2MSP genuinely appears as the on-chain submitter.
 *
 * This makes evidence custody attributable to a real, named,
 * cryptographically-verified officer — e.g. Org1MSP::juma.ismail.
 *
 * Requires: enroll-officers.sh has been run, evidence_2.0
 *           chaincode, and a running IPFS daemon.
 * ============================================================ */

'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');

// ------------------------------------------------------------
// Configuration
// ------------------------------------------------------------
const isProd = process.env.NODE_ENV === 'production';
const CFG = {
  port:        process.env.PORT || 3000,
  channel:     process.env.CHANNEL  || 'evidence',
  chaincode:   process.env.CHAINCODE|| 'evidence',
  // test-network organizations root
  orgsPath:    process.env.ORGS_PATH ||
    path.resolve(__dirname, '..', '..', 'fabric-samples', 'test-network', 'organizations'),
  ipfsApi:     process.env.IPFS_API || 'http://127.0.0.1:5001',
  ipfsGateway: process.env.IPFS_GATEWAY || 'http://127.0.0.1:8088',
  // Production hardening. CORS_ORIGIN unset = same-origin only (cors()
  // with no allowed origin echoes none back); set it to the real deployed
  // frontend origin(s), comma-separated, once there is one.
  corsOrigins: (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean),
  // Gates the dev-only Network & Ledger admin panels (InitLedger button,
  // EvidenceContract operations reference table) and the unfiltered
  // ?all=true view over benchmark/test records. OFF unless explicitly set.
  devTools:    process.env.DEV_TOOLS === 'true',
  // Gates the network/infrastructure disclosure panels (sidebar network
  // card detail, Dashboard "Network Topology" card) — channel name,
  // orderer config, chaincode version, endorsing orgs. Requires BOTH this
  // flag AND the viewing officer having role=admin (enforced server-side
  // via requireAdmin on /api/system-info, not just hidden client-side).
  // OFF by default; regular users always see only a minimal connected/
  // offline indicator regardless of this flag.
  showInfra:   process.env.SHOW_INFRA === 'true',
  // Evidence/case IDs to hide from the production views (Dashboard,
  // Registry, Case Register) — Caliper benchmark runs and manual test
  // records, not real evidence. Comma-separated; matched as prefixes
  // against evidenceId, and exact/prefix against caseId.
  excludeEvidencePrefixes: (process.env.EXCLUDE_EVIDENCE_PREFIXES || 'BENCH-,TEST-')
    .split(',').map(s => s.trim()).filter(Boolean),
  excludeCaseIds: (process.env.EXCLUDE_CASE_IDS ||
    'CASE-E2E-001,CASE-2026-XSSTEST,CASE-2026-LIVEUI,CASE-2026-002,CASE-2026-009,CASE-2026-222')
    .split(',').map(s => s.trim()).filter(Boolean),
  // Prefix matching alone missed IDs where the marker isn't at the start
  // (e.g. "EV-2026-CACHETEST" doesn't start with "TEST-"). This catches
  // the marker anywhere in evidenceId or caseId, case-insensitive.
  excludeEvidenceMarkers: (process.env.EXCLUDE_EVIDENCE_MARKERS ||
    'TEST,CACHETEST,XSSTEST,LIVEUI')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
};

// Per-organisation connection details
const ORGS = {
  Org1MSP: {
    mspId:        'Org1MSP',
    domain:       'org1.example.com',
    peerEndpoint: 'localhost:7051',
    peerHostAlias:'peer0.org1.example.com',
  },
  Org2MSP: {
    mspId:        'Org2MSP',
    domain:       'org2.example.com',
    peerEndpoint: 'localhost:9051',
    peerHostAlias:'peer0.org2.example.com',
  },
};

function firstFile(dir) {
  if (!fs.existsSync(dir))
    throw new Error(`identity folder missing: ${dir}`);
  // pick the first real file, ignoring hidden entries and sub-directories
  const files = fs.readdirSync(dir).filter(f => {
    if (f.startsWith('.')) return false;
    return fs.statSync(path.join(dir, f)).isFile();
  });
  if (files.length === 0)
    throw new Error(`no certificate/key file found in: ${dir}`);
  return path.join(dir, files[0]);
}

function peerOrgPath(domain) {
  return path.join(CFG.orgsPath, 'peerOrganizations', domain);
}

// ------------------------------------------------------------
// Officer discovery — scan each org's users/ folder for enrolled
// named identities (anything that is not the default User1/Admin).
// ------------------------------------------------------------
function discoverOfficers() {
  const officers = [];
  for (const org of Object.values(ORGS)) {
    const usersDir = path.join(peerOrgPath(org.domain), 'users');
    if (!fs.existsSync(usersDir)) continue;
    for (const entry of fs.readdirSync(usersDir)) {
      // entry looks like  juma.ismail@org1.example.com
      const username = entry.split('@')[0];
      if (username === 'User1' || username === 'Admin') continue;
      const mspDir = path.join(usersDir, entry, 'msp');
      if (!fs.existsSync(path.join(mspDir, 'signcerts'))) continue;
      officers.push({
        id:       `${org.mspId}::${username}`,
        username,
        mspId:    org.mspId,
        orgLabel: org.mspId === 'Org1MSP' ? 'Org1' : 'Org2',
        mspDir,
        org,
      });
    }
  }
  return officers;
}

// ------------------------------------------------------------
// Build a Fabric Gateway connection for a specific officer.
// ------------------------------------------------------------
function newGrpcConnection(org) {
  const tlsCertPath = path.join(peerOrgPath(org.domain),
    'peers', org.peerHostAlias, 'tls', 'ca.crt');
  const tlsRootCert = fs.readFileSync(tlsCertPath);
  const creds = grpc.credentials.createSsl(tlsRootCert);
  return new grpc.Client(org.peerEndpoint, creds, {
    'grpc.ssl_target_name_override': org.peerHostAlias,
  });
}

function officerIdentity(officer) {
  const certPath = firstFile(path.join(officer.mspDir, 'signcerts'));
  return { mspId: officer.mspId, credentials: fs.readFileSync(certPath) };
}

function officerSigner(officer) {
  const keyPath = firstFile(path.join(officer.mspDir, 'keystore'));
  return signers.newPrivateKeySigner(crypto.createPrivateKey(fs.readFileSync(keyPath)));
}

// connection cache — one gateway per officer, opened on first use
const gateways = {};   // officerId -> { gateway, client, contract }

function getContract(officer) {
  if (gateways[officer.id]) return gateways[officer.id].contract;
  const client = newGrpcConnection(officer.org);
  const gateway = connect({
    client,
    identity: officerIdentity(officer),
    signer:   officerSigner(officer),
    evaluateOptions:    () => ({ deadline: Date.now() + 5000 }),
    endorseOptions:     () => ({ deadline: Date.now() + 15000 }),
    submitOptions:      () => ({ deadline: Date.now() + 5000 }),
    commitStatusOptions:() => ({ deadline: Date.now() + 60000 }),
  });
  const contract = gateway.getNetwork(CFG.channel).getContract(CFG.chaincode);
  gateways[officer.id] = { gateway, client, contract };
  return contract;
}

// ------------------------------------------------------------
// Officer registry
// ------------------------------------------------------------
let OFFICERS = [];
let DEFAULT_OFFICER = null;

function loadOfficers() {
  OFFICERS = discoverOfficers();
  DEFAULT_OFFICER = OFFICERS[0] || null;
  if (OFFICERS.length === 0) {
    console.warn('[officers] none found — run enroll-officers.sh first.');
    console.warn('[officers] falling back to User1@org1 identity.');
    // fallback: synthesise a User1 officer so the server still runs
    const org = ORGS.Org1MSP;
    const usersDir = path.join(peerOrgPath(org.domain), 'users');
    const u1 = fs.readdirSync(usersDir).find(d => d.startsWith('User1@'));
    if (u1) {
      const fb = {
        id: 'Org1MSP::user1', username: 'user1', mspId: 'Org1MSP',
        orgLabel: 'Org1', mspDir: path.join(usersDir, u1, 'msp'), org,
      };
      OFFICERS = [fb];
      DEFAULT_OFFICER = fb;
    }
  } else {
    console.log(`[officers] loaded ${OFFICERS.length}:`);
    OFFICERS.forEach(o => console.log(`           ${o.id}`));
  }
}

function resolveOfficer(officerId) {
  if (!officerId) return DEFAULT_OFFICER;
  return OFFICERS.find(o => o.id === officerId) || DEFAULT_OFFICER;
}

const utf8 = new TextDecoder();
const parse = (bytes) => {
  const s = utf8.decode(bytes);
  return s ? JSON.parse(s) : null;
};
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Fabric Gateway endorsement/submit failures (e.g. a chaincode-level
// rejection such as TransferCustody's custodian check) arrive as a
// GatewayError whose readable message is nested in e.details[].message —
// the top-level e.message is just a generic gRPC status like
// "10 ABORTED: failed to endorse transaction". Surface the real reason.
function txErrorMessage(e) {
  if (e && Array.isArray(e.details) && e.details.length) {
    const msgs = [...new Set(e.details.map(d => d.message).filter(Boolean))];
    if (msgs.length) return msgs.join('; ');
  }
  return e.message;
}

// Logs the failure server-side (route handlers never did this before — a
// production incident had no trail at all) without changing what the
// client sees; txErrorMessage() already keeps the client-facing message
// free of stack traces.
function logRouteError(route, e) {
  console.error(`[api] ${route} failed:`, e && e.stack ? e.stack : e);
}

// ------------------------------------------------------------
// Evidence cache + pagination/filtering (added for production scale —
// GetAllEvidence has no native pagination, so every list/search/dashboard
// request used to re-scan the whole channel and ship the full ledger to
// the browser. This bounds peer load to one full fetch per TTL window
// (deduped across concurrent requests) and bounds browser load to one
// page at a time. See EXCLUDE_EVIDENCE_PREFIXES / EXCLUDE_CASE_IDS for the
// benchmark/test-record filter, and DEV_TOOLS for the unfiltered escape
// hatch used only by the admin/dev view.
// ------------------------------------------------------------
const EVIDENCE_CACHE_TTL_MS = 5000;
let evidenceCache = { data: null, fetchedAt: 0, pending: null };

async function getAllEvidenceCached() {
  const now = Date.now();
  if (evidenceCache.data && (now - evidenceCache.fetchedAt) < EVIDENCE_CACHE_TTL_MS) {
    return evidenceCache.data;
  }
  if (evidenceCache.pending) return evidenceCache.pending;
  evidenceCache.pending = (async () => {
    const result = await getContract(DEFAULT_OFFICER).evaluateTransaction('GetAllEvidence');
    const data = parse(result) || [];
    evidenceCache = { data, fetchedAt: Date.now(), pending: null };
    return data;
  })();
  try {
    return await evidenceCache.pending;
  } catch (e) {
    evidenceCache = { data: null, fetchedAt: 0, pending: null };
    throw e;
  }
}
// Called right after a successful RegisterEvidence/TransferCustody submit
// so the next read reflects it immediately instead of waiting out the TTL.
function invalidateEvidenceCache() {
  evidenceCache = { data: null, fetchedAt: 0, pending: null };
}

function isTestRecord(e) {
  if (CFG.excludeEvidencePrefixes.some(p => e.evidenceId && e.evidenceId.startsWith(p))) return true;
  if (CFG.excludeCaseIds.includes(e.caseId)) return true;
  if (CFG.excludeEvidenceMarkers.length) {
    const evId = (e.evidenceId || '').toLowerCase();
    const caseId = (e.caseId || '').toLowerCase();
    if (CFG.excludeEvidenceMarkers.some(m => evId.includes(m) || caseId.includes(m))) return true;
  }
  return false;
}

function paginate(items, page, limit) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(200, Math.max(1, parseInt(limit, 10) || 25));
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / l));
  const start = (p - 1) * l;
  return { items: items.slice(start, start + l), total, page: p, limit: l, totalPages };
}

// Same self-consistency check the chaincode's VerifyIntegrity performs
// (recomputing H(evidenceId|submittedAt) and comparing to the stored
// hash) — done here once per cache refresh instead of once per evidence
// item per dashboard view.
function metadataIntact(e) {
  return sha256(Buffer.from(e.evidenceId + '|' + e.submittedAt)) === e.hash;
}

// ------------------------------------------------------------
// Authentication (v4)
//   - officer credentials from officers.auth.json (salted SHA-256)
//   - login issues an in-memory session token bound to identityId
//   - RegisterEvidence is signed ONLY as the logged-in officer
// PRODUCTION NOTE: use a slow KDF (bcrypt/scrypt/Argon2) + a secrets
//   manager, and integrate with the org directory (LDAP/OIDC).
// ------------------------------------------------------------
const AUTH_FILE = path.join(__dirname, 'officers.auth.json');
let CREDENTIALS = {};
function loadCredentials() {
  try {
    CREDENTIALS = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    console.log(`[auth]   loaded ${Object.keys(CREDENTIALS).length} officer credential(s)`);
  } catch (e) {
    CREDENTIALS = {};
    console.warn('[auth]   no officers.auth.json — run: node make-credentials.js');
  }
}
const hashPw = (password, salt) =>
  crypto.createHash('sha256').update(salt + ':' + password).digest('hex');

const SESSIONS = new Map(); // token -> { username, identityId, displayName, expires }
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function createSession(cred, username) {
  const token = crypto.randomBytes(24).toString('hex');
  SESSIONS.set(token, {
    username, identityId: cred.identityId,
    displayName: cred.displayName || username,
    role: cred.role || 'officer',
    expires: Date.now() + SESSION_TTL_MS,
  });
  return token;
}
function getSession(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const s = SESSIONS.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) { SESSIONS.delete(token); return null; }
  return s;
}
function requireAuth(req, res, next) {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'not authenticated' });
  req.session = s;
  next();
}
// Enforced server-side, not just hidden in the frontend nav — a route
// gated only by hiding its UI is still reachable by anyone with a valid
// session token.
function requireAdmin(req, res, next) {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'admin role required' });
  next();
}

// ------------------------------------------------------------
// IPFS helpers (unchanged from v2)
// ------------------------------------------------------------
// `ipfs add --pin` stores and pins the artefact in the block store, but
// the Files tab in the IPFS Web UI (127.0.0.1:5001/webui) only browses
// MFS — a separate named-folder layer — not the block/pin store. Without
// this, every upload is genuinely stored and pinned but invisible there,
// which reads as "did this actually go to IPFS?" during a demo. Best-effort
// and non-fatal: MFS visibility is cosmetic, never blocks the real upload.
async function ipfsMfsLink(cid, filename) {
  try {
    await fetch(`${CFG.ipfsApi}/api/v0/files/mkdir?arg=/evidence&parents=true`, { method: 'POST' });
    const safe = String(filename || 'artefact').replace(/[^\w.\-]/g, '_');
    const mfsPath = `/evidence/${cid.slice(0, 10)}-${safe}`;
    await fetch(`${CFG.ipfsApi}/api/v0/files/cp?arg=${encodeURIComponent('/ipfs/' + cid)}`
      + `&arg=${encodeURIComponent(mfsPath)}`, { method: 'POST' });
  } catch (_) { /* cosmetic only — never fail the upload over this */ }
}
async function ipfsAdd(buffer, filename) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), filename || 'artefact');
  const res = await fetch(`${CFG.ipfsApi}/api/v0/add?pin=true&cid-version=1`, {
    method: 'POST', body: form });
  if (!res.ok) throw new Error(`IPFS add failed: HTTP ${res.status}`);
  const lines = (await res.text()).trim().split('\n');
  const hash = JSON.parse(lines[lines.length - 1]).Hash;
  await ipfsMfsLink(hash, filename);
  return hash;
}
async function ipfsCat(cid) {
  const res = await fetch(`${CFG.ipfsApi}/api/v0/cat?arg=${encodeURIComponent(cid)}`,
    { method: 'POST' });
  if (!res.ok) throw new Error(`IPFS cat failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
async function ipfsVersion() {
  const res = await fetch(`${CFG.ipfsApi}/api/v0/version`, { method: 'POST' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ============================================================
// REST API
// ============================================================
const app = express();
app.disable('x-powered-by');
app.use(helmet({
  // this app is served over plain HTTP by design (TLS terminates at a
  // reverse proxy in front, per deployment doc) — CSP/HSTS belong at that
  // layer where the real origin and cert are known, not hardcoded here
  contentSecurityPolicy: false,
  hsts: false,
}));
app.use(cors(
  CFG.corsOrigins.length
    ? { origin: CFG.corsOrigins, credentials: true }
    : { origin: false } // no CORS_ORIGIN configured: same-origin only, no cross-origin API access
));
app.use(express.json({ limit: '1mb' }));
app.use('/api/ipfs/upload', express.raw({ type: '*/*', limit: '25mb' }));

// Runtime config for the frontend. There's no build step for a static
// HTML/JS app, so this is the equivalent of NEXT_PUBLIC_* env injection:
// the API base URL becomes read-only, driven by the backend's own env,
// instead of a free-text field the user could repoint. Served before the
// static handler so it's always fresh, never cached as a static asset.
app.get('/config.js', (req, res) => {
  res.type('application/javascript').send(
    `window.DEMS_CONFIG = ${JSON.stringify({
      apiBase:   process.env.PUBLIC_API_BASE_URL || '/api',
      devTools:  CFG.devTools,
      showInfra: CFG.showInfra,
      idleTimeoutMs:   parseInt(process.env.IDLE_TIMEOUT_MS, 10)   || 15 * 60 * 1000,
      idleWarningMs:   parseInt(process.env.IDLE_WARNING_MS, 10)   || 60 * 1000,
    })};`
  );
});
app.use(express.static(path.join(__dirname, '..', 'public')));

// Login is the one endpoint an attacker can hit without any prior
// credential — throttle it so password guessing isn't free. Keyed by IP;
// fine for a single-instance deployment behind a reverse proxy that sets
// a real client IP (trust proxy is NOT enabled here — see deployment doc).
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts — try again later.' },
});

// --- POST /api/login  → authenticate an officer --------------
app.post('/api/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'username and password required' });
  const cred = CREDENTIALS[username];
  if (!cred || hashPw(password, cred.salt) !== cred.hash)
    return res.status(401).json({ error: 'invalid username or password' });
  // the officer must also have an enrolled identity on the network
  const officer = OFFICERS.find(o => o.id === cred.identityId);
  if (!officer)
    return res.status(403).json({ error: `no enrolled identity for ${cred.identityId}` });
  const token = createSession(cred, username);
  res.json({
    ok: true, token,
    officer: { username, identityId: cred.identityId,
               displayName: cred.displayName || username,
               orgLabel: officer.orgLabel,
               role: cred.role || 'officer' },
  });
});

// --- POST /api/logout  → end the session ---------------------
app.post('/api/logout', (req, res) => {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token) SESSIONS.delete(token);
  res.json({ ok: true });
});

// --- GET /api/me  → who is logged in -------------------------
app.get('/api/me', requireAuth, (req, res) => {
  res.json({
    username: req.session.username,
    identityId: req.session.identityId,
    displayName: req.session.displayName,
    role: req.session.role,
  });
});

// --- GET /api/officers  → list selectable officers -----------
app.get('/api/officers', requireAuth, (req, res) => {
  res.json(OFFICERS.map(o => ({
    id: o.id, username: o.username, mspId: o.mspId, orgLabel: o.orgLabel,
    displayName: (CREDENTIALS[o.username] && CREDENTIALS[o.username].displayName) || o.username,
  })));
});

// --- POST /api/init  → InitLedger (as default officer) -------
app.post('/api/init', requireAuth, async (req, res) => {
  try {
    const officer = resolveOfficer(req.body.officerId);
    await getContract(officer).submitTransaction('InitLedger');
    invalidateEvidenceCache();
    res.json({ ok: true, message: 'InitLedger committed', by: officer.id });
  } catch (e) { logRouteError('POST /api/init', e); res.status(500).json({ error: txErrorMessage(e) }); }
});

// --- POST /api/ipfs/upload  → add + pin artefact to IPFS -----
app.post('/api/ipfs/upload', requireAuth, async (req, res) => {
  try {
    const buffer = req.body;
    if (!buffer || !buffer.length)
      return res.status(400).json({ error: 'empty upload body' });
    const filename = req.headers['x-filename'] || 'artefact';
    const cid = await ipfsAdd(buffer, filename);
    res.json({ ok: true, cid, contentHash: sha256(buffer), size: buffer.length,
               gateway: `${CFG.ipfsGateway}/ipfs/${cid}` });
  } catch (e) { logRouteError('POST /api/ipfs/upload', e); res.status(500).json({ error: txErrorMessage(e) }); }
});

// --- GET /api/ipfs/:cid  → retrieve artefact -----------------
app.get('/api/ipfs/:cid', requireAuth, async (req, res) => {
  try {
    const data = await ipfsCat(req.params.cid);
    res.set('Content-Type', 'application/octet-stream');
    res.send(data);
  } catch (e) { res.status(404).json({ error: e.message }); }
});

// Identifier shape shared by evidenceId/caseId: matches every ID already
// on the ledger (BENCH-..., CASE-2026-001, EV-2026-LIVEUI-TEST, ...) while
// still rejecting anything absurd. Presence-only checks used to be the
// entire validation story.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function validateEvidenceInput({ evidenceId, caseId, type, description }) {
  if (!evidenceId || !caseId || !type || !description) return 'Missing required fields';
  if (!ID_RE.test(evidenceId)) return 'evidenceId: 1-64 chars, letters/digits/./_/- only';
  if (!ID_RE.test(caseId)) return 'caseId: 1-64 chars, letters/digits/./_/- only';
  if (type.length > 64) return 'type must be 64 characters or fewer';
  if (description.length > 4000) return 'description must be 4000 characters or fewer';
  return null;
}

// --- POST /api/evidence  → RegisterEvidence as the LOGGED-IN officer
// Authentication is enforced: the transaction is signed with the
// certificate of the officer in the session, NOT a client-supplied id.
app.post('/api/evidence', requireAuth, async (req, res) => {
  try {
    const { evidenceId, caseId, type, description,
            ipfsCid, contentHash } = req.body || {};
    const validationError = validateEvidenceInput({ evidenceId, caseId, type, description });
    if (validationError) return res.status(400).json({ error: validationError });
    // the officer is determined by the session — cannot be spoofed by the client
    const officer = OFFICERS.find(o => o.id === req.session.identityId);
    if (!officer) return res.status(403).json({ error: 'session identity not enrolled' });
    await getContract(officer).submitTransaction('RegisterEvidence',
      evidenceId, caseId, type, description, ipfsCid || '', contentHash || '');
    invalidateEvidenceCache();
    res.json({ ok: true, evidenceId, registeredBy: officer.id });
  } catch (e) { logRouteError('POST /api/evidence', e); res.status(500).json({ error: txErrorMessage(e) }); }
});

// --- POST /api/evidence/:id/transfer → TransferCustody --------
// Only the current custodian (the caller's session identity) may
// hand an item off; the chaincode itself enforces this.
// The chaincode's TransferCustody takes newStatus as a raw, completely
// unvalidated string (EvidenceStatus(newStatus) is a plain cast, not an
// enum check) — a garbage value would silently corrupt both the on-chain
// record and this app's derived case Active/Closed logic (which keys off
// an exact 'Sealed' match). Enforced here since the chaincode doesn't.
const VALID_STATUSES = new Set(['', 'Registered', 'InAnalysis', 'Verified', 'Sealed']);
// Reason is required at this API layer, even though the chaincode's
// original TransferCustody (still callable, still unchanged) doesn't
// demand one — NIST SP 800-86 / ISO 27037 / SWGDE all require the reason
// for a custody handoff, not just who/when/to-whom, so the application's
// transfer flow now always records one via TransferCustodyWithReason.
app.post('/api/evidence/:id/transfer', requireAuth, async (req, res) => {
  try {
    const { newCustodianId, newStatus, reason } = req.body || {};
    if (!newCustodianId)
      return res.status(400).json({ error: 'newCustodianId required' });
    if (newStatus && !VALID_STATUSES.has(newStatus))
      return res.status(400).json({ error: `invalid status '${newStatus}' — `
        + `expected one of: Registered, InAnalysis, Verified, Sealed` });
    if (!reason || !reason.trim())
      return res.status(400).json({ error: 'reason is required for a custody transfer' });
    if (reason.length > 500)
      return res.status(400).json({ error: 'reason must be 500 characters or fewer' });
    const officer = OFFICERS.find(o => o.id === req.session.identityId);
    if (!officer) return res.status(403).json({ error: 'session identity not enrolled' });
    await getContract(officer).submitTransaction('TransferCustodyWithReason',
      req.params.id, newCustodianId, newStatus || '', reason.trim());
    invalidateEvidenceCache();
    res.json({ ok: true, evidenceId: req.params.id,
               newCustodian: newCustodianId, newStatus: newStatus || null, reason: reason.trim() });
  } catch (e) { logRouteError('POST /api/evidence/:id/transfer', e); res.status(500).json({ error: txErrorMessage(e) }); }
});

// --- GET /api/evidence  → paginated, filtered, searchable view over
//     GetAllEvidence. Query params:
//       page, limit   — 1-based page and page size (max 200)
//       q             — case-insensitive substring match on evidenceId/
//                       caseId/type, applied server-side (was client-side
//                       over the full fetched list before)
//       caseId        — exact match, used by the Case Detail view to list
//                       just one case's items without a separate endpoint
//       all=true      — bypass filtering AND pagination entirely; only
//                       honoured when DEV_TOOLS is on, otherwise ignored
app.get('/api/evidence', requireAuth, async (req, res) => {
  try {
    const raw = await getAllEvidenceCached();
    const wantAll = req.query.all === 'true' && CFG.devTools;
    let items = wantAll ? raw : raw.filter(e => !isTestRecord(e));
    if (req.query.caseId) items = items.filter(e => e.caseId === req.query.caseId);
    if (req.query.q) {
      const q = String(req.query.q).toLowerCase();
      items = items.filter(e =>
        (e.evidenceId || '').toLowerCase().includes(q) ||
        (e.caseId || '').toLowerCase().includes(q) ||
        (e.evidenceType || '').toLowerCase().includes(q));
    }
    if (wantAll) return res.json({ items, total: items.length, page: 1, limit: items.length, totalPages: 1 });
    res.json(paginate(items, req.query.page, req.query.limit));
  } catch (e) { logRouteError('GET /api/evidence', e); res.status(500).json({ error: txErrorMessage(e) }); }
});

// --- GET /api/cases  → cases derived from GetAllEvidence, paginated ---
// There is no separate case record on-chain; a case is a grouping of
// evidence by caseId. Computed from the same cached full list so grouping
// is always correct (an item's true case membership can't be known from a
// partial page), but the RESULT is paginated so the browser never
// receives an unbounded case list either.
app.get('/api/cases', requireAuth, async (req, res) => {
  try {
    const raw = await getAllEvidenceCached();
    const filtered = raw.filter(e => !isTestRecord(e));
    const byCase = new Map();
    for (const e of filtered) {
      if (!byCase.has(e.caseId)) byCase.set(e.caseId, []);
      byCase.get(e.caseId).push(e);
    }
    let cases = [...byCase.entries()].map(([caseId, evs]) => {
      const lastActivity = evs.reduce((max, e) => (e.submittedAt || '') > max ? e.submittedAt : max, '');
      return {
        caseId, count: evs.length,
        sealedCount: evs.filter(e => e.status === 'Sealed').length,
        active: !evs.every(e => e.status === 'Sealed'),
        lastActivity,
      };
    });
    if (req.query.q) {
      const q = String(req.query.q).toLowerCase();
      cases = cases.filter(c => c.caseId.toLowerCase().includes(q));
    }
    cases.sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));
    res.json(paginate(cases, req.query.page, req.query.limit));
  } catch (e) { logRouteError('GET /api/cases', e); res.status(500).json({ error: txErrorMessage(e) }); }
});

// --- GET /api/stats  → cheap Dashboard aggregate ---------------
// Everything the Dashboard needs in one bounded response: it used to
// fetch the entire ledger into the browser just to compute these numbers.
// Integrity verification is the same self-consistency check
// VerifyIntegrity performs (see metadataIntact()) — computed once here
// per cache refresh rather than once per item per dashboard view.
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const raw = await getAllEvidenceCached();
    const items = raw.filter(e => !isTestRecord(e));
    const byCase = new Map();
    for (const e of items) {
      if (!byCase.has(e.caseId)) byCase.set(e.caseId, []);
      byCase.get(e.caseId).push(e);
    }
    const cases = [...byCase.values()];
    const activeCases = cases.filter(evs => !evs.every(e => e.status === 'Sealed')).length;
    const verified = items.filter(metadataIntact).length;
    const recent = [...items]
      .sort((a, b) => (b.submittedAt || '').localeCompare(a.submittedAt || ''))
      .slice(0, 5);
    res.json({
      totalEvidence: items.length,
      totalCases: cases.length,
      activeCases,
      verified,
      verifiedPct: items.length ? Math.round(verified / items.length * 100) : 0,
      recent,
    });
  } catch (e) { logRouteError('GET /api/stats', e); res.status(500).json({ error: txErrorMessage(e) }); }
});

// --- GET /api/stats/txcount → exact ledger transaction count ---
// Deliberately NOT part of /api/stats or computed automatically: an exact
// count needs one GetEvidenceHistory chain call per evidence item (history
// isn't part of GetAllEvidence, so there's no cheap local equivalent the
// way metadataIntact() is for integrity). Explicit, on-demand, throttled.
app.get('/api/stats/txcount', requireAuth, async (req, res) => {
  try {
    const raw = await getAllEvidenceCached();
    const items = raw.filter(e => !isTestRecord(e));
    const contract = getContract(DEFAULT_OFFICER);
    let txns = 0;
    const CONCURRENCY = 20;
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const e = items[next++];
        try {
          const h = await contract.evaluateTransaction('GetEvidenceHistory', e.evidenceId);
          txns += (parse(h) || []).length;
        } catch (_) { /* skip a record that fails, don't fail the whole sweep */ }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
    res.json({ txns, computedAt: new Date().toISOString(), scannedItems: items.length });
  } catch (e) { logRouteError('GET /api/stats/txcount', e); res.status(500).json({ error: txErrorMessage(e) }); }
});

// --- GET /api/evidence/:id  → GetEvidence --------------------
app.get('/api/evidence/:id', requireAuth, async (req, res) => {
  try {
    const result = await getContract(DEFAULT_OFFICER)
      .evaluateTransaction('GetEvidence', req.params.id);
    res.json(parse(result));
  } catch (e) { res.status(404).json({ error: e.message }); }
});

// --- GET /api/evidence/:id/verify → full integrity check -----
app.get('/api/evidence/:id/verify', requireAuth, async (req, res) => {
  try {
    const result = await getContract(DEFAULT_OFFICER)
      .evaluateTransaction('VerifyIntegrity', req.params.id);
    const chain = parse(result);

    let offChain = { checked: false };
    if (chain && chain.hasOffChainData) {
      try {
        const artefact = await ipfsCat(chain.ipfsCid);
        const recomputed = sha256(artefact);
        offChain = {
          checked: true, ipfsCid: chain.ipfsCid,
          storedContentHash: chain.contentHash,
          recomputedContentHash: recomputed,
          artefactIntact: recomputed === chain.contentHash,
          size: artefact.length,
        };
      } catch (e) {
        offChain = { checked: true, error: 'IPFS retrieval failed: ' + e.message };
      }
    }
    res.json({
      evidenceId: chain.evidenceId,
      metadata: { intact: chain.metadataIntact,
                  storedHash: chain.storedHash,
                  recomputedHash: chain.recomputedHash },
      offChain,
      fullyVerified: chain.metadataIntact &&
        (!chain.hasOffChainData || (offChain.checked && offChain.artefactIntact === true)),
    });
  } catch (e) { logRouteError('GET /api/evidence/:id/verify', e); res.status(500).json({ error: txErrorMessage(e) }); }
});

// --- GET /api/evidence/:id/history  → GetEvidenceHistory -----
app.get('/api/evidence/:id/history', requireAuth, async (req, res) => {
  try {
    const result = await getContract(DEFAULT_OFFICER)
      .evaluateTransaction('GetEvidenceHistory', req.params.id);
    res.json(parse(result) || []);
  } catch (e) { logRouteError('GET /api/evidence/:id/history', e); res.status(500).json({ error: txErrorMessage(e) }); }
});

// --- health ----------------------------------------------------
// Public (monitoring/load-balancer friendly) — deliberately minimal.
// This used to also return the channel name, chaincode name, and the
// full list of enrolled officer identities to ANY unauthenticated
// caller — infrastructure and identity disclosure with zero access
// control, even though the equivalent /api/officers is properly gated.
// Regular users' minimal "connected/offline" indicator only ever needs
// the boolean, not the detail.
app.get('/api/health', async (req, res) => {
  let ipfs = false;
  try { await ipfsVersion(); ipfs = true; } catch (_) {}
  res.json({ ok: true, ipfsConnected: ipfs });
});

// Admin-only — the actual infrastructure detail (channel, chaincode,
// orderer/network info the frontend already knows statically, officer
// identities, IPFS version). Gated on both the session's role AND
// SHOW_INFRA being on, enforced here server-side — not just a panel
// hidden in the nav that any authenticated request could still reach.
app.get('/api/system-info', requireAuth, requireAdmin, async (req, res) => {
  if (!CFG.showInfra) return res.status(404).json({ error: 'not enabled' });
  let ipfs = false, ipfsVer = null;
  try { ipfsVer = await ipfsVersion(); ipfs = true; } catch (_) {}
  res.json({
    channel: CFG.channel, chaincode: CFG.chaincode,
    officers: OFFICERS.map(o => o.id),
    ipfsConnected: ipfs,
    ipfsVersion: ipfsVer ? ipfsVer.Version : null,
  });
});

// ------------------------------------------------------------
// Boot
// ------------------------------------------------------------
(async () => {
  loadOfficers();
  loadCredentials();
  if (!DEFAULT_OFFICER) {
    console.error('[fatal] no usable identity found. Run enroll-officers.sh,');
    console.error('        or check ORGS_PATH points at the organizations folder.');
    process.exit(1);
  }
  // verify the default officer can actually reach Fabric
  try {
    getContract(DEFAULT_OFFICER);
    console.log(`[fabric] connected — channel=${CFG.channel} chaincode=${CFG.chaincode}`);
  } catch (e) {
    console.error('[fabric] connection failed:', e.message);
    process.exit(1);
  }
  try {
    const v = await ipfsVersion();
    console.log(`[ipfs]   connected — Kubo version ${v.Version}`);
  } catch (e) {
    console.warn('[ipfs]   NOT connected — start it with: ipfs daemon');
  }
  app.listen(CFG.port, () =>
    console.log(`[dems]   backend listening on http://localhost:${CFG.port}`));
})().catch(err => {
  console.error('[fatal]', err.message);
  process.exit(1);
});

process.on('SIGINT', () => {
  for (const g of Object.values(gateways)) {
    try { g.gateway.close(); g.client.close(); } catch (_) {}
  }
  process.exit(0);
});
