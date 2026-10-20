// ============================================================================
// 🚀 TCM NFT PREMIUM BACKEND SERVER (Timezone Aware, Cached & Bulletproof)
// ============================================================================

const express = require('express');
const teamBonusIdentity = require('./lib/team-bonus-identity.cjs');
const path = require('path');
require('dotenv').config(); // এটি অবশ্যই একদম প্রথমে থাকবে
const nodemailer = require('nodemailer');

// Render-এর নেটওয়ার্ক সমস্যা এড়াতে জিমেইলের অপ্টিমাইজড কনফিগারেশন
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
    tls: {
        rejectUnauthorized: true // ক্লাউড সার্ভারের সিকিউরিটি ব্লক এড়ানোর জন্য
    },
    family: 4 // Render-এর IPv6 সমস্যা ফিক্স করার জন্য এটি খুবই জরুরি
});
const cors = require('cors');
const admin = require('firebase-admin');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue, FieldPath: r3FieldPath } = require('firebase-admin/firestore');
const moment = require('moment-timezone');
const { redisClient } = require('./utils/redisHelper');
const otplib = require('otplib');

let hdEthers = null, hdTronWeb = null;
try {
    hdEthers = require('ethers');
    const tronModule = require('tronweb');
    hdTronWeb = tronModule.TronWeb || tronModule.default || tronModule;
} catch (error) {
    console.warn('[HD DEPOSIT] Dependencies unavailable. Run npm install to update packages and package-lock.json.');
}

const hdDepositConfig = (() => {
    const phrase = (process.env.HD_MASTER_MNEMONIC || '').trim();
    if (!phrase) {
        console.warn('[HD DEPOSIT] HD_MASTER_MNEMONIC is not configured; signup remains available.');
        return null;
    }
    if (!hdEthers || !hdTronWeb) return null;
    try {
        if (!hdEthers.Mnemonic.isValidMnemonic(phrase)) throw new Error('Invalid mnemonic');
        // Keep only public parent nodes; never persist or expose signing material.
        const bep = hdEthers.HDNodeWallet.fromPhrase(phrase, '', "m/44'/60'/0'/0").neuter();
        const tron = hdEthers.HDNodeWallet.fromPhrase(phrase, '', "m/44'/195'/0'/0").neuter();
        const fingerprint = hdEthers.keccak256(hdEthers.toUtf8Bytes(
            bep.extendedKey + ':' + tron.extendedKey
        ));
        return { bep, tron, fingerprint };
    } catch (error) {
        console.warn('[HD DEPOSIT] Invalid wallet configuration; deposit generation is disabled.');
        return null;
    }
})();

function hdDepositError(status, code, message) {
    return Object.assign(new Error(message), { status, code });
}
function hdDepositConflict() {
    return hdDepositError(409, 'DEPOSIT_WALLET_CONFLICT',
        'Deposit wallet needs administrator review. Please contact support.');
}
function hdDepositIndex(index) {
    return Number.isSafeInteger(index) && index >= 1 && index <= 0x7fffffff;
}
function hdDepositFields(row) {
    return {
        Deposit_Wallet_Index: row.Deposit_Wallet_Index,
        Deposit_BEP20: row.Deposit_BEP20,
        Deposit_TRC20: row.Deposit_TRC20
    };
}
function hdDepositValid(row) {
    if (!hdEthers || !hdTronWeb || !hdDepositIndex(row.Deposit_Wallet_Index)) return false;
    try {
        return typeof row.Deposit_BEP20 === 'string' && row.Deposit_BEP20.length === 42 &&
            hdEthers.getAddress(row.Deposit_BEP20) === row.Deposit_BEP20 &&
            typeof row.Deposit_TRC20 === 'string' && row.Deposit_TRC20.length === 34 &&
            row.Deposit_TRC20.startsWith('T') && hdTronWeb.isAddress(row.Deposit_TRC20);
    } catch (error) { return false; }
}
function hdDepositDerive(index) {
    if (!hdDepositConfig || !hdDepositIndex(index)) {
        throw hdDepositError(503, 'DEPOSIT_NOT_CONFIGURED',
            'Deposit wallets are not configured yet. Please contact support.');
    }
    try {
        const bep = hdDepositConfig.bep.deriveChild(index);
        const tron = hdDepositConfig.tron.deriveChild(index);
        const result = {
            Deposit_Wallet_Index: index,
            Deposit_BEP20: hdEthers.getAddress(bep.address),
            Deposit_TRC20: hdTronWeb.address.fromHex('41' + tron.address.slice(2))
        };
        if (!hdDepositValid(result)) throw new Error('Invalid derived address');
        return result;
    } catch (error) {
        throw hdDepositError(503, 'DEPOSIT_DERIVATION_FAILED',
            'Deposit wallets are temporarily unavailable. Please contact support.');
    }
}
function hdDepositCheckExisting(row, expected) {
    for (const field of ['Deposit_BEP20', 'Deposit_TRC20']) {
        if (row[field] && row[field] !== expected[field]) throw hdDepositConflict();
    }
}
function hdDepositAccount(snapshot) {
    if (!snapshot.exists) {
        throw hdDepositError(404, 'DEPOSIT_ACCOUNT_UNAVAILABLE', 'Account not found.');
    }
    const row = snapshot.data();
    if (row.Status === 'Pending_Deletion') {
        throw hdDepositError(403, 'DEPOSIT_FROZEN_PENDING_DELETION',
            'Account deletion is in progress. Inflows are suspended. Abort deletion to resume transactions.');
    }
    if (row.Account_Deleted === true || row.Status === 'Banned') {
        throw hdDepositError(409, 'DEPOSIT_ACCOUNT_UNAVAILABLE', 'Deposits are unavailable for this account.');
    }
    return row;
}

async function ensureUserDepositWallets(uid) {
    a0Uid(uid);
    const userRef = db.collection('Users').doc(uid);
    const first = hdDepositAccount(await userRef.get());
    if (hdDepositValid(first)) {
        if (hdDepositConfig) hdDepositCheckExisting(first, hdDepositDerive(first.Deposit_Wallet_Index));
        return hdDepositFields(first);
    }
    if (!hdDepositConfig) {
        throw hdDepositError(503, 'DEPOSIT_NOT_CONFIGURED',
            'Deposit wallets are not configured yet. Please contact support.');
    }
    const counterRef = db.collection('System').doc('Wallet_Counter');
    const result = await db.runTransaction(async transaction => {
        const row = hdDepositAccount(await transaction.get(userRef));
        if (hdDepositValid(row)) {
            hdDepositCheckExisting(row, hdDepositDerive(row.Deposit_Wallet_Index));
            return { changed: false, wallets: hdDepositFields(row) };
        }
        const savedIndex = row.Deposit_Wallet_Index;
        const hasIndex = savedIndex !== undefined && savedIndex !== null;
        if (hasIndex && !hdDepositIndex(savedIndex)) throw hdDepositConflict();
        if (!hasIndex && (row.Deposit_BEP20 || row.Deposit_TRC20)) throw hdDepositConflict();

        const counter = await transaction.get(counterRef);
        const state = counter.exists ? counter.data() : { lastIndex: 0 };
        if (!Number.isSafeInteger(state.lastIndex) || state.lastIndex < 0 ||
            state.lastIndex > 0x7fffffff ||
            (state.masterFingerprint && state.masterFingerprint !== hdDepositConfig.fingerprint)) {
            throw hdDepositConflict();
        }
        const index = hasIndex ? savedIndex : state.lastIndex + 1;
        if (!hdDepositIndex(index)) throw hdDepositConflict();
        const allocationRef = counterRef.collection('Allocations').doc(String(index));
        const allocation = await transaction.get(allocationRef);
        if (allocation.exists && allocation.data().UID !== uid) throw hdDepositConflict();

        const wallets = hdDepositDerive(index);
        hdDepositCheckExisting(row, wallets);
        transaction.set(counterRef, {
            lastIndex: Math.max(state.lastIndex, index),
            masterFingerprint: hdDepositConfig.fingerprint
        }, { merge: true });
        transaction.set(allocationRef, { UID: uid }, { merge: true });
        transaction.update(userRef, wallets);
        return { changed: true, wallets };
    });
    if (result.changed) {
        try { await clearUserCache(uid); }
        catch (error) { console.warn('[HD DEPOSIT] Wallet saved; cache invalidation deferred.'); }
    }
    return result.wallets;
}
const authenticator = otplib.authenticator || otplib;
authenticator.options = { secretSize: 10, window: 1 }; 

// 🔥 REDIS HELPER (Global Import)
const { getCache, setCache, clearUserCache: e4BaseClearUserCache } = require('./utils/redisHelper');

async function clearUserCache(uid) {
    try {
        await e4BaseClearUserCache(uid);
    } catch (error) {
        console.warn('[E4 CACHE] Invalidation pending; do not fail a committed action.');
    }
    // Cache invalidation already follows existing actions. Emit a hint, not a financial replay.
    if (typeof uid !== 'string' || !uid) return;
    try {
        await m2RedisCommand(() => redisClient.del(`monthly_quota_${uid}`));
        const prefix = `p2p_history_e4_${encodeURIComponent(uid)}_`;
        for (const key of e4P2PMemory.keys()) {
            if (key.startsWith(prefix) || key === 'uncached:' + uid) e4P2PMemory.delete(key);
        }
        if (global.io) global.io.to(uid).emit('dashboard_invalidated', { uid });
    } catch (error) {
        console.warn('[E4 CACHE] Update notification pending.');
    }
}

// =========================================================
// 🚀 MODULE 0: FIREBASE ADMIN SETUP
// =========================================================
const serviceAccount = require('./serviceAccountKey.json'); 
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const http = require('http'); // 🆕 Socket.io এর জন্য যুক্ত করা হলো
const { Server } = require('socket.io'); // 🆕 Socket.io যুক্ত করা হলো

const app = express();
app.set('trust proxy', 1); // 🔥 FIX: Render Load Balancer-কে বিশ্বাস করার জন্য
const server = http.createServer(app); // 🆕 Express কে HTTP সার্ভারে র‍্যাপ করা হলো
const io = new Server(server, { cors: { origin: "*" } }); // 🆕 Socket.io ইনিশিয়ালাইজেশন
global.io = io;

// ============================================================================
// 🛡️ MEMO 04: ENTERPRISE SECURITY SHIELD (CORS, PAYLOAD & RATE LIMITER)
// ============================================================================

// ১. Payload Size Lock (২ মেগাবাইটের বেশি সাইজের কোনো ম্যালিশিয়াস ডেটা বা ভাইরাস ঢুকতে পারবে না)
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ limit: '2mb', extended: true }));

// ২. CORS Security (Localhost এবং GitHub Pages এর জন্য সিকিউরিটি ওপেন)
// MEMO: TCM-ADM-DEBUG-002
// Enable cross-origin API access and automatic OPTIONS preflight handling.
app.use(cors());

// ৩. Global IP Rate Limiter (DDoS এবং Bot Spamming প্রটেকশন)
const authRateLimiter = require('express-rate-limit')({
    windowMs: 15 * 60 * 1000, // ১৫ মিনিট
    max: 5, // সর্বোচ্চ ৫টি রিকোয়েস্ট
    message: { 
        success: false, 
        message: "⚠️ Security Alert: Too many requests detected from your IP. Please try again after 15 minutes." 
    },
    standardHeaders: true,
    legacyHeaders: false,
});

app.use('/downloads', express.static(path.join(__dirname, 'public/downloads')));

// =========================================================
// 🛡 GLOBAL SECURITY MIDDLEWARE (TCM-05: Auth Bypass Preventer)
// =========================================================
// Account deletion: server-validated Turnstile, purpose-bound OTP and bounded Redis operations.
const r3Crypto = require('node:crypto');
const r3Digest = value => r3Crypto.createHash('sha256').update(String(value)).digest('hex');
const r3Bearer = req => {
    const value = req.headers.authorization;
    return typeof value === 'string' && /^Bearer [^\s]{8,512}$/.test(value) ? value.slice(7) : null;
};
const deletionV1Error = (statusCode, message, code = 'DELETION_VERIFICATION') =>
    Object.assign(new Error(message), { statusCode, code });

async function r3SecurityRedis(command) {
    if (!redisClient || !redisClient.isReady) {
        throw deletionV1Error(503, 'Deletion verification is unavailable. Please try again later.');
    }
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(command),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(deletionV1Error(503,
                    'Deletion verification timed out. Please try again.')), 1000);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function r3SecurityRate(req, action, maximum, seconds) {
    const token = r3Bearer(req);
    if (!token) throw deletionV1Error(401, 'Authentication token required.');
    const hash = r3Digest(token);
    const result = await r3SecurityRedis(() => redisClient.eval(`
        for index, key in ipairs(KEYS) do
            local count = redis.call('INCR', key)
            if count == 1 then redis.call('EXPIRE', key, ARGV[1]) end
            local maximum = tonumber(ARGV[2])
            if index == 1 then maximum = maximum * 10 end
            if count > maximum then return 0 end
        end
        return 1`, {
        keys: ['tcm:del:v1:rate:ip:' + r3Digest(req.ip || 'unknown') + ':' + action,
            'tcm:del:v1:rate:session:' + hash + ':' + action],
        arguments: [String(seconds), String(maximum)]
    }));
    if (Number(result) !== 1) {
        throw deletionV1Error(429, 'Too many deletion attempts. Wait five minutes before trying again.');
    }
    return hash;
}

function deletionV1Config() {
    const siteKey = String(process.env.TCM_TURNSTILE_SITE_KEY || '').trim();
    const secretKey = String(process.env.TCM_TURNSTILE_SECRET_KEY || '').trim();
    const hostnames = String(process.env.TCM_TURNSTILE_HOSTNAMES || '')
        .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
    if (!siteKey || !secretKey || !hostnames.length ||
        hostnames.some(value => !/^[a-z0-9.-]+$/.test(value))) {
        throw deletionV1Error(503, 'Account deletion verification is not configured. Contact support.');
    }
    return { siteKey, secretKey, hostnames };
}

async function deletionV1VerifyTurnstile(req, hash) {
    const config = deletionV1Config();
    const token = req.body?.turnstileToken;
    const nonce = req.body?.verificationNonce;
    if (typeof token !== 'string' || !token || token.length > 2048 ||
        typeof nonce !== 'string' || !/^[a-f0-9]{48}$/.test(nonce)) {
        throw deletionV1Error(400, 'Complete the bot verification before requesting a deletion OTP.');
    }
    const claim = await r3SecurityRedis(() => redisClient.eval(`
        if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
        redis.call('DEL', KEYS[1])
        return 1`, { keys: ['tcm:del:v1:nonce:' + nonce], arguments: [hash] }));
    if (Number(claim) !== 1) {
        throw deletionV1Error(400, 'Verification expired or already used. Verify again.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({ secret: config.secretKey, response: token,
                idempotency_key: r3Crypto.randomUUID() })
        });
        if (!response.ok) throw deletionV1Error(503, 'Bot verification service is unavailable.');
        const result = await response.json();
        if (result.success !== true || result.action !== 'account_delete' || result.cdata !== nonce ||
            !config.hostnames.includes(String(result.hostname || '').toLowerCase())) {
            throw deletionV1Error(400, 'Bot verification failed or expired. Verify again.');
        }
    } catch (error) {
        if (error.statusCode) throw error;
        throw deletionV1Error(503, 'Bot verification could not complete. Please verify again.');
    } finally {
        clearTimeout(timer);
    }
}

function deletionV1OtpDigest(uid, hash, purpose, id, otp) {
    return r3Crypto.createHmac('sha256', tcmAuthResetKey())
        .update(JSON.stringify(['account-deletion-otp-v1', uid, hash, purpose, id, otp])).digest('hex');
}

app.get('/api/user/deletion-config', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const hash = await r3SecurityRate(req, 'config', 12, 300);
        const { siteKey } = deletionV1Config();
        const nonce = r3Crypto.randomBytes(24).toString('hex');
        await r3SecurityRedis(() => redisClient.setEx('tcm:del:v1:nonce:' + nonce, 300, hash));
        res.json({ success: true, siteKey, verificationNonce: nonce });
    } catch (error) {
        res.status(error.statusCode || 503).json({ success: false,
            code: error.code || 'DELETION_VERIFICATION', message: error.message });
    }
});

// Deletion-only throttles run before Firestore authentication. No idle polling is added.
app.use('/api', async (req, res, next) => {
    const routes = {
        '/user/deletion-otp': ['issue-delete', 3],
        '/user/cancel-deletion-otp': ['issue-cancel', 3],
        '/user/request-delete': ['submit-delete', 6],
        '/user/cancel-delete': ['submit-cancel', 6]
    };
    if (req.method !== 'POST' || !routes[req.path]) return next();
    res.set('Cache-Control', 'no-store');
    try {
        const [action, maximum] = routes[req.path];
        req.deletionSessionHash = await r3SecurityRate(req, action, maximum, 300);
        if (req.path === '/user/deletion-otp') {
            await deletionV1VerifyTurnstile(req, req.deletionSessionHash);
        }
        next();
    } catch (error) {
        res.status(error.statusCode || 503).json({ success: false,
            code: error.code || 'DELETION_VERIFICATION', message: error.message });
    }
});

function deletionV3AccessExpired(user) {
    return user?.Status === 'Pending_Deletion' &&
        (!Number.isFinite(user.Delete_At) || user.Delete_At <= Date.now());
}

const verifyToken = async (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'];

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, message: "Unauthorized: Token missing!" });
        }

        const clientToken = authHeader.split(' ')[1];
        
        // 🔥 Smart Fix: UID রিকোয়েস্টে না থাকলেও সরাসরি টোকেন দিয়ে ডাটাবেস চেক করবে
        const userQuery = await db.collection("Users").where("Token", "==", clientToken).limit(1).get();
        
        if (userQuery.empty) {
            return res.status(401).json({ success: false, message: "Session Expired! Please login again." });
        }
        
        // MEMO TCM-ADM-014-S2-A | 2026-10-10 02:30 IST
        const authenticatedUser = userQuery.docs[0];

        const account = authenticatedUser.data();
        const cleanupRead = req.method === 'GET' && req.path === '/user/deletion-clearance';
        const logout = req.method === 'POST' && req.path === '/auth/logout';
        if (deletionV3AccessExpired(account) && !cleanupRead && !logout) {
            return res.status(403).json({ success: false, code: 'ACCOUNT_DELETION_DUE',
                message: 'Account closure is due. Normal access is blocked while settlement and cleanup complete.' });
        }
        if (account.Status === 'Banned' || account.Account_Deleted === true) {
            return res.status(403).json({
                success: false,
                code: 'ACCOUNT_BLOCKED',
                message: 'Account access is blocked.'
            });
        }

        req.authenticatedUid = authenticatedUser.id;
        req.authenticatedUserDoc = authenticatedUser;
        r3SignalDatabaseRecovery();
        next();
    } catch (error) {
        return res.status(500).json({ success: false, message: "Authentication failure." });
    }
};

// =========================================================
// 🛡️ ACTIVATE GLOBAL SECURITY SHIELD (TCM-05 HACKER-PROOFING)
// =========================================================
const publicRoutes = [
    '/signup', 
    '/signup/send-otp', // 🔥 এই লাইনটি যুক্ত করা হলো (যাতে ওটিপি রিকোয়েস্ট ব্লক না হয়)
    '/login',
    '/admin/login',
    '/auth/send-otp', 
    '/forgot-password/send-otp', 
    '/security/send-otp', 
    '/forgot-password/reset',
    '/auth/generate-2fa'
];

app.use('/api', (req, res, next) => {
    // ১. পাবলিক রাউট হলে সরাসরি পাস করবে (যেমন: লগইন, সাইনআপ)
    if (publicRoutes.includes(req.path)) {
        return next();
    }
    // ২. প্রাইভেট রাউট হলে টোকেন মিডলওয়্যার দিয়ে কঠোরভাবে চেক করবে
    return verifyToken(req, res, next);
});

// A0/A1: Legacy REST handlers must operate on the verified caller's identity.
app.use('/api', async (req, res, next) => {
    const getOwners = ['/chat/friends', '/chat/requests', '/chat/messages', '/support/messages', '/reservation/today'];
    const postOwners = {
        '/chat/send-global': 'senderUid', '/chat/send-private': 'senderUid',
        '/chat/delete-message': 'uid', '/friends/send-request': 'senderUid',
        '/friends/accept-request': 'myUid', '/friends/unfriend': 'myUid',
        '/user/upload-avatar': 'uid', '/user/remove-avatar': 'uid',
        '/user/presence': 'uid', '/user/typing': 'uid',
        '/notifications/clear-all': 'uid', '/p2p/read-glow': 'uid',
        '/finance/check-security-lock': 'uid'
    };
    if (!(req.method === 'GET' && getOwners.includes(req.path)) &&
        !(req.method === 'POST' && (postOwners[req.path] || req.path === '/friends/reject-request'))) return next();
    try {
        const uid = req.authenticatedUid;
        if (!uid) return res.status(401).json({ success: false, message: 'Authentication required.' });
        const field = req.method === 'GET' ? 'uid' : postOwners[req.path];
        const supplied = req.method === 'GET' ? req.query.uid : field ? req.body[field] : undefined;
        if ((supplied !== undefined && supplied !== uid) || (req.method === 'GET' && supplied === undefined)) {
            return res.status(403).json({ success: false, message: 'Account ownership mismatch.' });
        }
        if (req.method === 'POST' && field) req.body[field] = uid;
        const actor = req.authenticatedUserDoc.data();
        if (['/chat/send-global', '/chat/send-private', '/friends/send-request'].includes(req.path)) {
            req.body.senderName = String(actor.Name || 'TCM User').slice(0, 120);
            req.body.avatar = typeof actor.Avatar === 'string' ? actor.Avatar : '';
            req.body.senderAvatar = req.body.avatar;
            if (req.path !== '/chat/send-global') a0Uid(req.body.receiverUid);
            if (req.path.startsWith('/chat/')) req.body.message = a0Text(req.body.message, 'message', 4000);
        }
        if (req.path === '/chat/messages') {
            if (!['global', 'private'].includes(req.query.mode)) {
                throw Object.assign(new Error('Invalid conversation mode.'), { status: 400 });
            }
            if (req.query.mode === 'private') a0Uid(req.query.target);
        }
        if (['/friends/accept-request', '/friends/reject-request'].includes(req.path)) {
            f1RequestId(req.body.reqId);
        }
        if (req.path === '/friends/unfriend') a0Uid(req.body.targetUid);
        if (req.path === '/chat/delete-message') {
            const { mode, deleteType, msgIds, receiverUid } = req.body;
            if (!['global', 'private'].includes(mode) || !['me', 'everyone'].includes(deleteType) ||
                !Array.isArray(msgIds) || msgIds.length < 1 || msgIds.length > 50) {
                throw Object.assign(new Error('Invalid message removal request.'), { status: 400 });
            }
            msgIds.forEach(a0Uid);
            if (mode === 'private') a0Uid(receiverUid);
            if (deleteType === 'everyone') {
                const collection = mode === 'global' ? db.collection('Global_Chat') :
                    db.collection('Private_Chats').doc(uid < receiverUid ? `${uid}_${receiverUid}` : `${receiverUid}_${uid}`).collection('Messages');
                const messages = await Promise.all(msgIds.map(id => collection.doc(id).get()));
                for (const message of messages) {
                    if (!message.exists || (message.data().senderUid !== uid &&
                        !(actor.Role === 'Admin' && actor.Status === 'Active'))) {
                        throw Object.assign(new Error('You cannot remove another sender\'s message for everyone.'), { status: 403 });
                    }
                }
            }
        }
        return next();
    } catch (error) { return a0Failure(res, error); }
});

// M1: Bounded administrator readers. Financial mutation handlers are unchanged.
const {
    Filter: m1Filter,
    FieldPath: m1FieldPath,
    AggregateField: m1AggregateField
} = require('firebase-admin/firestore');

const m1ReadCache = new Map();
const m1ReadFlights = new Map();
let m1CacheEpoch = 0;
const m1Streams = new Set();
let m1PendingUnsubscribe = null;
let m1PendingReady = null;
let m1PendingRecords = new Map();
let m1PendingError = null;
let m1PendingVersion = 0;
let m1ObserverGeneration = 0;
let m1BroadcastTimer = null;

function m1RequireAdmin(req, res) {
    const actor = req.authenticatedUserDoc;
    if (!req.authenticatedUid) {
        res.status(401).json({ success: false, message: 'Authentication required.' });
        return false;
    }
    if (!actor || !actor.exists || actor.id !== req.authenticatedUid ||
        actor.data().Role !== 'Admin' || actor.data().Status === 'Banned') {
        res.status(403).json({ success: false, message: 'Active administrator privileges required.' });
        return false;
    }
    res.set('Cache-Control', 'no-store');
    return true;
}

// TCM TESTNET STATUS START: fixed token, read-only RPC, no financial writes.
const nftTestStatusIdentity = Object.freeze({
    contract: '0xc617c917bb594bB14F2A7EaD2d9b650Dd3754673',
    custody: '0x1E7d9Aa6922eb5CC6e91d289a4Bb5b45212cA2f3',
    assetKey: '0x4f0a9a53249638cf49c1c3bfe5fc38004b8bf129e13c0e36f55727143e58bb32',
    buildHash: '0x0a9bc2fde1ca8c68ebeb629807581ffc9d95125e6829ef2f2d62d7e148e118e3',
    deploymentHash: '0x43e5d884bc6275e033797138315d2f53141e68f60aae1a393d8a4600ea92ab03',
    mintHash: '0x74ac1c82cfdd43579edd68644b4c756a3c17b524c3be3b1a1a823f9e2cf2b6a5',
    metadataURI: 'ipfs://bafkreicl7pdm74lzxguy6ncdfplfffn7viqnmactcq4fshzvs67at2xmta'
});
let nftTestStatusCache = null;
let nftTestStatusFlight = null;
let nftTestStatusRetryAt = 0;
const nftTestStatusLimits = new Map();

async function nftTestReadStatus() {
    if (!hdEthers) throw new Error('Verification unavailable.');

    const s = nftTestStatusIdentity;
    const url = new URL(
        process.env.BSC_TESTNET_RPC_URL ||
        'https://bsc-testnet-dataseed.bnbchain.org'
    );
    if (url.protocol !== 'https:') {
        throw new Error('HTTPS testnet RPC required.');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    let sequence = 0;

    const same = (a, b) =>
        typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

    const check = (ok, message) => {
        if (!ok) throw new Error(message);
    };

    async function rpc(method, params = []) {
        const id = ++sequence;
        const response = await fetch(url.href, {
            method: 'POST',
            redirect: 'error',
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id,
                method,
                params
            })
        });

        check(response.ok, 'RPC HTTP failure.');

        const body = await response.json();
        check(
            body.id === id && !body.error && body.result !== undefined,
            'RPC response failure.'
        );
        return body.result;
    }

    try {
        check(
            BigInt(await rpc('eth_chainId')) === 97n,
            'Wrong network.'
        );

        const iface = new hdEthers.Interface([
            'function ownerOf(uint256) view returns (address)',
            'function tokenURI(uint256) view returns (string)',
            'function tokenForAsset(bytes32) view returns (uint256)',
            'function custody() view returns (address)',
            'function minter() view returns (address)',
            'function ALLOWED_CHAIN_ID() view returns (uint256)',
            'function mintOnce(bytes32,string) returns (uint256)',
            'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)',
            'event AssetMinted(bytes32 indexed assetKey,uint256 indexed tokenId,address indexed recipient,string metadataURI)'
        ]);

        const [head, deploy, mint, deployTx, mintTx] = await Promise.all([
            rpc('eth_getBlockByNumber', ['latest', false]),
            rpc('eth_getTransactionReceipt', [s.deploymentHash]),
            rpc('eth_getTransactionReceipt', [s.mintHash]),
            rpc('eth_getTransactionByHash', [s.deploymentHash]),
            rpc('eth_getTransactionByHash', [s.mintHash])
        ]);

        check(
            head && deploy && mint && deployTx && mintTx,
            'Recorded transaction unavailable.'
        );
        check(
            BigInt(deploy.status) === 1n && BigInt(mint.status) === 1n,
            'Transaction failed.'
        );
        check(
            same(deploy.transactionHash, s.deploymentHash) &&
            same(mint.transactionHash, s.mintHash) &&
            same(deployTx.hash, s.deploymentHash) &&
            same(mintTx.hash, s.mintHash),
            'Transaction hash mismatch.'
        );

        const confirmations =
            BigInt(head.number) - BigInt(mint.blockNumber) + 1n;

        check(
            confirmations >= 3n &&
            BigInt(head.number) - BigInt(deploy.blockNumber) + 1n >= 3n,
            'At least three confirmations required.'
        );
        check(
            confirmations <= BigInt(Number.MAX_SAFE_INTEGER),
            'Invalid confirmation count.'
        );

        check(
            deployTx.to === null &&
            same(deploy.contractAddress, s.contract) &&
            same(deployTx.from, s.custody) &&
            BigInt(deployTx.value) === 0n &&
            BigInt(deployTx.chainId) === 97n &&
            BigInt(mintTx.chainId) === 97n &&
            same(mintTx.from, s.custody) &&
            same(mintTx.to, s.contract) &&
            same(mint.to, s.contract) &&
            BigInt(mintTx.value) === 0n,
            'Transaction identity mismatch.'
        );

        const constructorArg =
            hdEthers.AbiCoder.defaultAbiCoder().encode(
                ['address'],
                [s.custody]
            );

        check(
            typeof deployTx.input === 'string' &&
            deployTx.input.length > 66 &&
            same('0x' + deployTx.input.slice(-64), constructorArg) &&
            same(
                hdEthers.keccak256(deployTx.input.slice(0, -64)),
                s.buildHash
            ),
            'Deployment build mismatch.'
        );

        const input = iface.parseTransaction({
            data: mintTx.input,
            value: mintTx.value
        });

        check(
            input &&
            input.name === 'mintOnce' &&
            input.args[0] === s.assetKey &&
            input.args[1] === s.metadataURI,
            'Mint input mismatch.'
        );

        const events = mint.logs
            .filter(log => same(log.address, s.contract))
            .map(log => {
                try {
                    return iface.parseLog(log);
                } catch {
                    return null;
                }
            })
            .filter(Boolean);

        check(
            events.filter(e =>
                e.name === 'Transfer' &&
                e.args[0] === hdEthers.ZeroAddress &&
                same(e.args[1], s.custody) &&
                e.args[2] === 1n
            ).length === 1 &&
            events.filter(e =>
                e.name === 'AssetMinted' &&
                e.args[0] === s.assetKey &&
                e.args[1] === 1n &&
                same(e.args[2], s.custody) &&
                e.args[3] === s.metadataURI
            ).length === 1,
            'Mint events mismatch.'
        );

        const call = async (name, args = []) =>
            iface.decodeFunctionResult(
                name,
                await rpc('eth_call', [
                    {
                        to: s.contract,
                        data: iface.encodeFunctionData(name, args)
                    },
                    head.number
                ])
            )[0];

        const [
            owner, uri, mapped, custody, minter, chain,
            code, deployBlock, mintBlock
        ] = await Promise.all([
            call('ownerOf', [1n]),
            call('tokenURI', [1n]),
            call('tokenForAsset', [s.assetKey]),
            call('custody'),
            call('minter'),
            call('ALLOWED_CHAIN_ID'),
            rpc('eth_getCode', [s.contract, head.number]),
            rpc('eth_getBlockByNumber', [deploy.blockNumber, false]),
            rpc('eth_getBlockByNumber', [mint.blockNumber, false])
        ]);

        check(
            same(owner, s.custody) &&
            same(custody, s.custody) &&
            same(minter, s.custody) &&
            uri === s.metadataURI &&
            mapped === 1n &&
            chain === 97n &&
            typeof code === 'string' &&
            code !== '0x',
            'Token state mismatch.'
        );

        check(
            deployBlock &&
            mintBlock &&
            same(deployBlock.hash, deploy.blockHash) &&
            same(mintBlock.hash, mint.blockHash) &&
            same(deployTx.blockHash, deploy.blockHash) &&
            same(mintTx.blockHash, mint.blockHash),
            'Receipt block mismatch.'
        );

        const [canonicalHead, finalChain] = await Promise.all([
            rpc('eth_getBlockByNumber', [head.number, false]),
            rpc('eth_chainId')
        ]);

        check(
            canonicalHead &&
            same(canonicalHead.hash, head.hash) &&
            BigInt(finalChain) === 97n,
            'Snapshot network or block changed.'
        );

        return {
            status: 'Verified_Testnet_Snapshot',
            checkedAt: new Date().toISOString(),
            chainId: '97',
            contract: s.contract,
            tokenId: '1',
            owner,
            metadataURI: uri,
            mintHash: s.mintHash,
            mintBlockNumber: Number(BigInt(mint.blockNumber)),
            mintBlockHash: mint.blockHash,
            snapshotBlockNumber: Number(BigInt(head.number)),
            snapshotBlockHash: head.hash,
            confirmations: Number(confirmations),
            productionEligible: false
        };
    } finally {
        clearTimeout(timer);
        controller.abort();
    }
}

app.get('/api/admin/nft-testnet/status', async (req, res) => {
    if (!m1RequireAdmin(req, res)) return;

    const now = Date.now();
    for (const [uid, state] of nftTestStatusLimits) {
        if (state.until <= now) nftTestStatusLimits.delete(uid);
    }

    const uid = req.authenticatedUid;
    let limit = nftTestStatusLimits.get(uid);

    if (!limit) {
        if (nftTestStatusLimits.size >= 256) {
            return res.status(429).json({
                success: false,
                message: 'Try again in one minute.'
            });
        }
        limit = { count: 0, until: now + 60000 };
        nftTestStatusLimits.set(uid, limit);
    }

    if (++limit.count > 6) {
        res.set(
            'Retry-After',
            String(Math.max(1, Math.ceil((limit.until - now) / 1000)))
        );
        return res.status(429).json({
            success: false,
            message: 'Limit: six checks per minute. Please wait.'
        });
    }

    try {
        if (nftTestStatusCache && now < nftTestStatusCache.until) {
            return res.json({
                success: true,
                source: 'cache',
                cacheMaxAgeSeconds: 30,
                data: nftTestStatusCache.data
            });
        }

        if (!nftTestStatusFlight) {
            if (now < nftTestStatusRetryAt) {
                return res.status(503).json({
                    success: false,
                    message: 'Verification temporarily unavailable. Retry after five seconds.'
                });
            }

            nftTestStatusFlight = nftTestReadStatus()
                .then(data => {
                    nftTestStatusCache = {
                        data,
                        until: Date.now() + 30000
                    };
                    return data;
                })
                .catch(error => {
                    nftTestStatusCache = null;
                    nftTestStatusRetryAt = Date.now() + 5000;
                    throw error;
                })
                .finally(() => {
                    nftTestStatusFlight = null;
                });
        }

        const data = await nftTestStatusFlight;
        return res.json({
            success: true,
            source: 'rpc',
            cacheMaxAgeSeconds: 30,
            data
        });
    } catch {
        return res.status(503).json({
            success: false,
            message: 'Testnet verification failed or RPC unavailable. No transaction was sent. Retry later.'
        });
    }
});
// TCM TESTNET STATUS END

function m1PageOptions(req) {
    const limit = req.query.limit === undefined ? '25' : req.query.limit;
    const cursor = req.query.cursor === undefined ? '' : req.query.cursor;
    const search = req.query.search === undefined ? '' : req.query.search;
    if (typeof limit !== 'string' || !/^\d{1,2}$/.test(limit) ||
        Number(limit) < 1 || Number(limit) > 25 || typeof cursor !== 'string' ||
        Buffer.byteLength(cursor, 'utf8') > 1500 || cursor.includes('/') || typeof search !== 'string' || search.length > 100) {
        const error = new Error('Invalid page limit, cursor, or search term.');
        error.status = 400;
        throw error;
    }
    return { limit: Number(limit), cursor, search: search.trim().toLowerCase() };
}

async function m1CachedRead(key, loader, ttl = 60000, force = false) {
    if (force) {
        m1CacheEpoch++;
        m1ReadCache.clear();
    }
    const epoch = m1CacheEpoch;
    const cached = m1ReadCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    const flightKey = epoch + ':' + key;
    if (m1ReadFlights.has(flightKey)) return m1ReadFlights.get(flightKey);
    const operation = Promise.resolve().then(loader).then(value => {
        if (epoch === m1CacheEpoch) {
            if (m1ReadCache.size >= 200) m1ReadCache.delete(m1ReadCache.keys().next().value);
            m1ReadCache.set(key, { value, expires: Date.now() + ttl });
        }
        return value;
    }).finally(() => m1ReadFlights.delete(flightKey));
    m1ReadFlights.set(flightKey, operation);
    return operation;
}

function m1Timestamp(value) {
    if (value && typeof value.toMillis === 'function') return value.toMillis();
    if (value && typeof value === 'object') {
        const seconds = Number(value.seconds ?? value._seconds);
        return Number.isFinite(seconds) ? seconds * 1000 : 0;
    }
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function m1TransactionDTO(doc) {
    const data = doc.data();
    const amount = Number(data.Amount ?? data.amount);
    const netAmount = Number(data.Net_Amount ?? amount);
    const health = Number(data.User_Health ?? 100);
    return {
        id: doc.id,
        type: String(data.Type || data.type || '').trim(),
        status: String(data.Status || data.status || '').trim(),
        uid: String(data.UID || data.uid || data.userId || data.senderUid || '').trim(),
        orderId: String(data.Order_ID || data.orderId || 'N/A'),
        amount: Number.isFinite(amount) ? amount : null,
        netAmount: Number.isFinite(netAmount) ? netAmount : null,
        timestamp: m1Timestamp(data.Date || data.timestamp),
        txid: String(data.TXID || data.txid || ''),
        destination: String(data.Destination || ''),
        network: String(data.Network || 'BEP20'),
        health: Number.isFinite(health) ? Math.min(100, Math.max(0, health)) : null,
        adminNote: String(data.Admin_Note || ''),
        adminArchived: data.Admin_Archived === true
    };
}

function m1StatusQuery(values) {
    return db.collection('Transactions').where(m1Filter.or(
        m1Filter.where('Status', 'in', values),
        m1Filter.where('status', 'in', values)
    ));
}

function m1PendingCounts() {
    let deposits = 0;
    let withdrawals = 0;
    for (const row of m1PendingRecords.values()) {
        if (row.status.toLowerCase() !== 'pending') continue;
        if (row.type.toLowerCase() === 'deposit') deposits++;
        if (row.type.toLowerCase() === 'withdraw') withdrawals++;
    }
    return { deposits, withdrawals, total: deposits + withdrawals,
        scope: 'Explicit Status/status values Pending or pending; missing or other-cased status values require reconciliation.' };
}

function m1StopPendingIfUnused() {
    if (m1Streams.size !== 0) return;
    if (m1PendingUnsubscribe) m1PendingUnsubscribe();
    m1ObserverGeneration++;
    m1PendingUnsubscribe = null;
    m1PendingReady = null;
    m1PendingRecords.clear();
    m1PendingError = null;
}

function m1EnsurePendingObserver() {
    if (m1PendingReady) return m1PendingReady;
    const generation = ++m1ObserverGeneration;
    m1PendingReady = new Promise((resolve, reject) => {
        m1PendingUnsubscribe = m1StatusQuery(['Pending', 'pending']).onSnapshot(snapshot => {
            if (generation !== m1ObserverGeneration) return;
            if (snapshot.size > 10000) {
                m1PendingError = new Error('Pending queue exceeds the M1 memory limit. Narrow the query before continuing.');
                reject(m1PendingError);
                m1InvalidateReads();
                return;
            }
            for (const change of snapshot.docChanges()) {
                if (change.type === 'removed') m1PendingRecords.delete(change.doc.id);
                else m1PendingRecords.set(change.doc.id, m1TransactionDTO(change.doc));
            }
            m1PendingError = null;
            m1PendingVersion++;
            resolve();
            m1InvalidateReads();
        }, error => {
            if (generation !== m1ObserverGeneration) return;
            console.warn('M1 Pending observer failed:', error.code || 'unknown', error.message);
            m1PendingError = error;
            reject(error);
            m1InvalidateReads();
        });
    });
    // The HTTP handlers still receive the rejection; avoid an unattended rejection.
    m1PendingReady.catch(() => {});
    return m1PendingReady;
}

function m1InvalidateReads() {
    m1CacheEpoch++;
    m1ReadCache.clear();
    if (m1BroadcastTimer !== null || m1Streams.size === 0) return;
    m1BroadcastTimer = setTimeout(() => {
        m1BroadcastTimer = null;
        for (const stream of m1Streams) stream.send();
    }, 250);
}

// Observe successful committed API responses without changing transaction bodies.
app.use('/api', (req, res, next) => {
    const mutationPrefixes = ['/admin/', '/finance/', '/nft/', '/p2p/transfer', '/staking/', '/claim-stake', '/withdraw'];
    if (req.method !== 'POST' || req.path === '/admin/login' ||
        req.path.startsWith('/admin/support/') || req.path === '/admin/broadcast' ||
        !mutationPrefixes.some(prefix => req.path.startsWith(prefix))) return next();
    let committed = false;
    const originalJson = res.json;
    res.json = function(body) {
        committed = res.statusCode >= 200 && res.statusCode < 300 && body && body.success === true;
        return originalJson.call(this, body);
    };
    res.once('finish', () => {
        if (committed) m1InvalidateReads();
    });
    next();
});

app.get('/api/admin/read-events', async (req, res) => {
    if (!m1RequireAdmin(req, res)) return;
    if (m1Streams.size >= 50) {
        return res.status(503).json({ success: false, message: 'Admin stream capacity reached.' });
    }
    let closed = false;
    let sending = false;
    let dirty = false;
    let heartbeat = null;
    const token = String(req.headers.authorization || '').slice(7);
    const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        m1Streams.delete(stream);
        if (!res.writableEnded) res.end();
        m1StopPendingIfUnused();
    };
    const stream = {
        sendSupport: async (uid, detail) => {
            if (closed || !res.headersSent) return;
            try {
                const actor = await db.collection('Users').doc(req.authenticatedUid).get();
                if (!actor.exists || actor.data().Token !== token || actor.data().Role !== 'Admin' ||
                    actor.data().Status !== 'Active') {
                    res.write('data: ' + JSON.stringify({ kind: 'auth', status: 401 }) + '\n\n');
                    close();
                    return;
                }
                if (closed || res.writableEnded) return;
                if (!res.write('data: ' + JSON.stringify({ kind: 'support', uid, ...detail }) + '\n\n')) close();
            } catch (error) { close(); }
        },
        send: async () => {
            if (closed || !res.headersSent) return;
            if (sending) { dirty = true; return; }
            sending = true;
            try {
                // Revalidate on actual data changes; the heartbeat performs no database read.
                const actor = await db.collection('Users').doc(req.authenticatedUid).get();
                if (!actor.exists || actor.data().Token !== token || actor.data().Role !== 'Admin' ||
                    actor.data().Status === 'Banned') {
                    res.write('data: ' + JSON.stringify({ kind: 'auth', status: 401 }) + '\n\n');
                    close();
                    return;
                }
                if (m1PendingError) {
                    res.write('data: ' + JSON.stringify({ kind: 'unavailable', message: 'Pending reader unavailable.' }) + '\n\n');
                    close();
                    return;
                }
                const message = { kind: 'changed', version: m1PendingVersion, counts: m1PendingCounts() };
                if (!res.write('data: ' + JSON.stringify(message) + '\n\n')) close();
            } catch (error) {
                console.warn('M1 stream failed:', error.code || 'unknown');
                close();
            } finally {
                sending = false;
                if (dirty && !closed) { dirty = false; stream.send(); }
            }
        }
    };
    m1Streams.add(stream);
    req.once('aborted', close);
    res.once('close', close);
    try {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Pending initialization timed out.')), 12000);
            m1EnsurePendingObserver().then(
                () => { clearTimeout(timeout); resolve(); },
                error => { clearTimeout(timeout); reject(error); }
            );
        });
        if (closed) return;
        res.status(200).set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            'X-Accel-Buffering': 'no'
        });
        res.flushHeaders();
        heartbeat = setInterval(() => {
            if (!res.write(': keepalive\n\n')) close();
        }, 20000);
        await stream.send();
    } catch (error) {
        if (!closed && !res.headersSent) res.status(503).json({ success: false, message: 'Pending reader unavailable.' });
        close();
    }
});

function l4Time(value) {
    try {
        const result = typeof value === 'number' ? value
            : value && typeof value.toMillis === 'function' ? value.toMillis()
            : typeof value === 'string' ? Date.parse(value) : NaN;
        return Number.isFinite(result) ? result : null;
    } catch (error) { return null; }
}
function l4Account(user, uid, now = Date.now()) {
    const deleted = user.Account_Deleted === true;
    const deadline = l4Time(user.Deletion_Deadline ?? user.Delete_At);
    let state = 'review';
    if (deleted) state = user.AuthCleanupPending === false ? 'deleted'
        : user.AuthCleanupPending === true ? 'auth-pending' : 'review';
    else if (user.Status === 'Pending_Deletion') {
        state = deadline === null ? 'review' : deadline > now ? 'pending'
            : user.DeletionCleanupCode ? 'cleanup-blocked' : 'cleanup-due';
    } else if (user.Status === 'Active') state = 'active';
    else if (user.Status === 'Banned') state = 'banned';
    return {
        uid, name: String(user.Name || 'Unknown account'), lifecycleState: state,
        accountDeleted: deleted, actionRestricted: deleted || user.Status === 'Pending_Deletion',
        requestedAt: l4Time(user.Deletion_Requested_At), deadline,
        deletedAt: l4Time(user.Deleted_At), authCheckedAt: l4Time(user.AuthCleanupAttemptedAt),
        cleanupCheckedAt: l4Time(user.DeletionCleanupAttemptedAt),
        cleanupCode: String(user.AuthCleanupError || user.DeletionCleanupCode || '').slice(0, 100),
        cleanupReasons: Array.isArray(user.DeletionCleanupReasons)
            ? user.DeletionCleanupReasons.slice(0, 10).map(value => String(value).slice(0, 100)) : []
    };
}
function l4AssertMutable(user) {
    if (user.Account_Deleted === true || user.Status === 'Pending_Deletion') {
        throw Object.assign(new Error('Account closure prevents this administrative action.'),
            { status: 409, httpStatus: 409 });
    }
}
app.get('/api/admin/lifecycle', async (req, res) => {
    if (!a0RequireAdmin(req, res)) return;
    try {
        const page = m1PageOptions(req);
        const state = req.query.state || 'all';
        const uid = typeof req.query.uid === 'string' ? req.query.uid.trim().toUpperCase() : '';
        if (!['all', 'active', 'banned', 'pending', 'cleanup-due', 'cleanup-blocked',
            'auth-pending', 'deleted', 'review'].includes(state) ||
            (uid && !/^[A-Z0-9_-]{1,128}$/.test(uid))) {
            return res.status(400).json({ success: false, message: 'Select a valid status and exact UID.' });
        }
        const users = db.collection('Users');
        let docs, nextCursor = null;
        if (uid) {
            const snapshot = await users.doc(uid).get();
            docs = snapshot.exists ? [snapshot] : [];
        } else {
            let query = users;
            if (['deleted', 'auth-pending'].includes(state)) {
                query = query.where('Account_Deleted', '==', true);
            } else {
                const status = { active: 'Active', banned: 'Banned', pending: 'Pending_Deletion',
                    'cleanup-due': 'Pending_Deletion', 'cleanup-blocked': 'Pending_Deletion' }[state];
                if (status) query = query.where('Status', '==', status);
            }
            query = query.orderBy(m1FieldPath.documentId()).limit(page.limit + 1);
            if (page.cursor) query = query.startAfter(page.cursor);
            const snapshot = await query.get();
            docs = snapshot.docs.slice(0, page.limit);
            if (snapshot.size > page.limit) nextCursor = docs[docs.length - 1].id;
        }
        const now = Date.now();
        const items = docs.map(doc => l4Account(doc.data(), doc.id, now))
            .filter(row => state === 'all' || row.lifecycleState === state);
        let counts = null;
        try {
            counts = await m1CachedRead('lifecycle-counts', async () => {
                const queries = [users, users.where('Status', '==', 'Pending_Deletion'),
                    users.where('Account_Deleted', '==', true),
                    users.where('Account_Deleted', '==', true).where('AuthCleanupPending', '==', true),
                    users.where('Account_Deleted', '==', true).where('AuthCleanupPending', '==', false)];
                const results = await Promise.all(queries.map(query => query.count().get()));
                const values = results.map(snapshot => snapshot.data().count);
                return { total: values[0], pending: values[1], erased: values[2],
                    authPending: values[3], deleted: values[4], checkedAt: Date.now() };
            }, 30000, req.query.refresh === '1');
        } catch (error) {
            console.warn('[LIFECYCLE] Count unavailable:', error.code || 'UNAVAILABLE');
        }
        res.json({ success: true, items, nextCursor, scanned: docs.length, counts,
            checkedAt: now, filterScope: 'scanned-page' });
    } catch (error) {
        res.status(error.status || 503).json({ success: false,
            message: error.status ? error.message : 'Lifecycle reader unavailable. Retry or check server logs.' });
    }
});

app.get('/api/admin/members', async (req, res) => {
    if (!m1RequireAdmin(req, res)) return;
    try {
        const page = m1PageOptions(req);
        const result = await m1CachedRead('members:' + JSON.stringify(page), async () => {
            let query = db.collection('Wallets').orderBy(m1FieldPath.documentId()).limit(page.limit + 1);
            if (page.cursor) query = query.startAfter(page.cursor);
            const snapshot = await query.get();
            const docs = snapshot.docs.slice(0, page.limit);
            const profiles = docs.length ? await db.getAll(...docs.map(doc => db.collection('Users').doc(doc.id))) : [];
            const items = docs.map((doc, index) => {
                const wallet = moneyV7View(doc.data());
                const user = profiles[index].exists ? profiles[index].data() : {};
                return {
                    ...l4Account(user, doc.id),
                    status: profiles[index].exists ? String(user.Status || 'Unknown') : 'Missing_Profile',
                    actionRestricted: !profiles[index].exists || user.Account_Deleted === true || user.Status === 'Pending_Deletion',
                    role: String(user.Role || 'User'),
                    rank: user.Rank ?? 1, profileMissing: !profiles[index].exists,
                    Main_Balance: wallet.Main_Balance ?? null, Locked_Balance: wallet.Locked_Balance ?? null,
                    Total_Deposit: wallet.Total_Deposit ?? null,
                    Total_Withdraw: wallet.Total_Withdraw ?? wallet.Total_Withdrawal ?? null,
                    Debt: wallet.Debt ?? null
                };
            }).filter(row => !page.search || row.uid.toLowerCase().includes(page.search) || row.name.toLowerCase().includes(page.search));
            return {
                success: true, items, scanned: docs.length,
                nextCursor: snapshot.size > page.limit ? docs[docs.length - 1].id : null,
                searchComplete: snapshot.size <= page.limit
            };
        }, 60000, req.query.refresh === '1');
        res.json(result);
    } catch (error) {
        console.warn('M1 directory read failed:', error.code || 'unknown', error.message);
        res.status(error.status || 503).json({ success: false, message: error.status ? error.message : 'Directory read unavailable.' });
    }
});

app.get('/api/admin/terminal-page', async (req, res) => {
    if (!m1RequireAdmin(req, res)) return;
    try {
        const page = m1PageOptions(req);
        const kind = req.query.kind;
        if (!['deposit', 'withdraw', 'archive'].includes(kind)) {
            return res.status(400).json({ success: false, message: 'Invalid terminal page kind.' });
        }
        if (kind !== 'archive') {
            if (!m1PendingReady || m1PendingError) {
                const result = await m1CachedRead('pending-page:' + kind + ':' + JSON.stringify(page), async () => {
                    const canonicalType = kind === 'deposit' ? 'Deposit' : 'Withdraw';
                    let query = m1StatusQuery(['Pending', 'pending']).where(m1Filter.or(
                        m1Filter.where('Type', 'in', [canonicalType, kind]),
                        m1Filter.where('type', 'in', [canonicalType, kind])
                    )).orderBy(m1FieldPath.documentId()).limit(page.limit + 1);
                    if (page.cursor) query = query.startAfter(page.cursor);
                    const snapshot = await query.get();
                    const items = snapshot.docs.slice(0, page.limit).map(m1TransactionDTO)
                        .filter(row => row.status.toLowerCase() === 'pending' && row.type.toLowerCase() === kind);
                    return {
                        success: true, items, version: null, source: 'bounded-query',
                        nextCursor: snapshot.size > page.limit ? snapshot.docs[page.limit - 1].id : null
                    };
                }, 15000, req.query.refresh === '1');
                return res.json(result);
            }
            await m1PendingReady;
            const rows = [...m1PendingRecords.values()].filter(row => row.status.toLowerCase() === 'pending' &&
                row.type.toLowerCase() === kind && (!page.cursor || row.id > page.cursor))
                .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
            const items = rows.slice(0, page.limit);
            return res.json({ success: true, items, counts: m1PendingCounts(), version: m1PendingVersion,
                nextCursor: rows.length > page.limit ? items[items.length - 1].id : null });
        }
        const result = await m1CachedRead('archive:' + JSON.stringify(page), async () => {
            let query = m1StatusQuery(['Rejected', 'Cancelled', 'Locked', 'rejected', 'cancelled', 'locked'])
                .orderBy(m1FieldPath.documentId()).limit(page.limit + 1);
            if (page.cursor) query = query.startAfter(page.cursor);
            const snapshot = await query.get();
            const items = snapshot.docs.slice(0, page.limit).map(m1TransactionDTO)
                .filter(row => !row.adminArchived && ['rejected', 'cancelled', 'locked'].includes(row.status.toLowerCase()));
            return { success: true, items,
                nextCursor: snapshot.size > page.limit ? snapshot.docs[page.limit - 1].id : null };
        }, 60000, req.query.refresh === '1');
        res.json(result);
    } catch (error) {
        console.warn('M1 terminal read failed:', error.code || 'unknown', error.message);
        res.status(error.status || 503).json({ success: false, message: error.status ? error.message : 'Terminal read unavailable.' });
    }
});

app.get('/api/admin/terminal-summary', async (req, res) => {
    if (!m1RequireAdmin(req, res)) return;
    try {
        const summary = await m1CachedRead('summary', async () => {
            const totals = {};
            const types = ['Deposit', 'Withdraw', 'Airdrop'];
            const [members, archive, ...sums] = await Promise.all([
                db.collection('Wallets').count().get(),
                m1StatusQuery(['Rejected', 'Cancelled', 'Locked', 'rejected', 'cancelled', 'locked']).count().get(),
                ...types.map(type => db.collection('Transactions')
                    .where('Status', '==', 'Success').where('Type', '==', type)
                    .aggregate({ total: m1AggregateField.sum('Amount') }).get())
            ]);
            types.forEach((type, index) => { totals[type] = sums[index].data().total; });
            return {
                success: true, members: members.data().count, archive: archive.data().count, totals,
                generatedAt: new Date().toISOString(),
                totalsScope: 'Canonical Status=Success, Type=Deposit/Withdraw/Airdrop, numeric Amount only. Legacy aliases and numeric strings require a separate reconciliation.'
            };
        }, 300000, req.query.refresh === '1');
        res.json(summary);
    } catch (error) {
        console.warn('M1 summary read failed:', error.code || 'unknown', error.message);
        res.status(503).json({ success: false, message: 'Summary unavailable. Check required Firestore indexes.' });
    }
});

// =========================================================
// 🛠️ HELPER ENGINE: Safe Rank Evaluator & Date Parser
// =========================================================

function parseSafeTimestamp(rawDate) {
    try {
        if (!rawDate) return 0;
        if (typeof rawDate === 'object') {
            if (typeof rawDate.toDate === 'function') return rawDate.toDate().getTime();
            if (rawDate.seconds) return rawDate.seconds * 1000;
            if (rawDate._seconds) return rawDate._seconds * 1000;
        }
        if (typeof rawDate === 'number') return rawDate;
        if (typeof rawDate === 'string') {
            let d1 = new Date(rawDate).getTime();
            if (!isNaN(d1)) return d1;
            
            let parts = rawDate.split(' ');
            let dParts = parts[0].split('-');
            if (dParts.length === 3 && dParts[0].length <= 2) {
                let safeDateStr = `${dParts[1]}/${dParts[0]}/${dParts[2]}`;
                if (parts.length > 1) safeDateStr += ' ' + parts.slice(1).join(' ');
                let d2 = new Date(safeDateStr).getTime();
                if (!isNaN(d2)) return d2;
            }
        }
    } catch(e) {}
    return 0;
}

function calculateRankUpdates(uData, wData) {
    if (uData.Account_Deleted === true) return {};
    moneyV7View(wData);
    // ANTI-FALSE DOWNGRADE SHIELD: Skip calculation if Active_Stakes data is missing
    if (wData.Active_Stakes === undefined) {
        return {}; 
    }

    let currentRank = parseInt(uData.Rank || 0);
    let activeStakesTotal = 0n;
    
    if (Array.isArray(wData.Active_Stakes)) {
        wData.Active_Stakes.forEach(stk => {
            if (stk.status === 'Active') {
                activeStakesTotal += moneyV7Amount(stk, 'amount', 'amount_micro', 'active rank principal');
            }
        });
    }
    
    let totalAssets = admS2Balance(wData, 'Main_Balance') + admS2Balance(wData, 'Locked_Balance') + activeStakesTotal;
    let currentPts = parseInt(wData.Points || 0);

    const LEVEL_REQ = { 
        1: { bal: 50, pts: 0 }, 2: { bal: 500, pts: 100 }, 3: { bal: 2000, pts: 200 }, 
        4: { bal: 5000, pts: 400 }, 5: { bal: 10000, pts: 500 }, 6: { bal: 20000, pts: 600 } 
    };
    let result = {};

    // DOWNGRADE LOGIC: No point refund on downgrade
    if (currentRank > 0) {
        let reqBalForCurrentRank = LEVEL_REQ[currentRank] ? LEVEL_REQ[currentRank].bal : 0;
        if (totalAssets < BigInt(reqBalForCurrentRank) * admS2Scale) {
            let newDowngradedRank = 0;
            for (let i = currentRank - 1; i >= 1; i--) {
                if (totalAssets >= BigInt(LEVEL_REQ[i].bal) * admS2Scale) { newDowngradedRank = i; break; }
            }
            result.Rank = newDowngradedRank;
            return result; 
        }
    }

    // UPGRADE LOGIC: Multi-jump enabled with strict cumulative point deduction
    let simulatedRank = currentRank;
    let simulatedPts = currentPts;
    let upgraded = false;

    while (simulatedRank < 6) {
        let nextRank = simulatedRank + 1;
        let reqBal = LEVEL_REQ[nextRank].bal;
        let reqPts = LEVEL_REQ[nextRank].pts;

        if (totalAssets >= BigInt(reqBal) * admS2Scale && simulatedPts >= reqPts) {
            simulatedRank = nextRank;
            if (reqPts > 0) simulatedPts -= reqPts;
            upgraded = true;
        } else {
            break; 
        }
    }

    if (upgraded) {
        result.Rank = simulatedRank;
        result.Points = simulatedPts;
    }

    return result; 
}

// =========================================================
// 🛡️ UNIVERSAL HIGH-SCALE FINTECH ORDER ID GENERATOR
// =========================================================
function generateOrderId(prefix = 'TX') {
    // এশিয়া/কলকাতা টাইমজোন অনুযায়ী তারিখ বের করা
    const now = moment().tz("Asia/Kolkata");
    const datePart = now.format('YYMMDD'); 
    const timeCode = Date.now().toString(36).toUpperCase(); // মিলিসেকেন্ড বেস৩৬
    const salt = Math.random().toString(36).substring(2, 6).toUpperCase(); // ক্রিপ্টো সল্ট
    return `${prefix}-${datePart}-${timeCode}-${salt}`;
}

// 🚀 SECURE 16-DIGIT CARD GENERATOR (BIN 4592 - GLOBAL HELPER)
function generateCardNumber() {
    const bin = '4592';
    const getBlock = () => {
        let blk;
        do {
            blk = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
        } while (blk === '0000');
        return blk;
    };
    return `${bin} ${getBlock()} ${getBlock()} ${getBlock()}`;
}

// =========================================================
// 🗓️ TODAY'S RESERVATION & TRADE HISTORY API
// =========================================================
app.get('/api/reservation/today', async (req, res) => {
    try {
        const { uid } = req.query;
        if (!uid) return res.status(400).json({ success: false, message: "UID is required" });

        const startOfToday = moment().tz("Asia/Kolkata").startOf('day').valueOf();
        const endOfToday = moment().tz("Asia/Kolkata").endOf('day').valueOf();

        const snap = await db.collection("NFT_History") 
            .where("UID", "==", uid)
            .where("timestamp", ">=", startOfToday)
            .where("timestamp", "<=", endOfToday)
            .orderBy("timestamp", "desc")
            .get();

        let todayData = [];
        snap.forEach(doc => todayData.push({ id: doc.id, ...doc.data() }));

        return res.json({ success: true, data: todayData });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

// =========================================================
// 🚀 MODULE 1: AUTHENTICATION, SIGNUP, LOGIN
// =========================================================

// 🔥 Memo 04: authRateLimiter যুক্ত করা হলো সাইনআপ এবং লগইনে
const tcmAuthCrypto = require('node:crypto');
const tcmAuthScrypt = require('node:util').promisify(tcmAuthCrypto.scrypt);
let tcmAuthHashJobs = 0;

function tcmAuthError(status, message) {
    return Object.assign(new Error(message), { status });
}

function tcmAuthPasswordInput(password, isNew = false) {
    if (typeof password !== 'string' || !password || password.length > 1024 ||
        (isNew && password.length < 6)) {
        throw tcmAuthError(400, 'Provide a valid password between 6 and 1024 characters.');
    }
    return password;
}

async function tcmAuthDerive(password, salt) {
    if (tcmAuthHashJobs >= 2) {
        throw tcmAuthError(503, 'Authentication is busy. Please try again shortly.');
    }
    tcmAuthHashJobs++;
    try {
        return await tcmAuthScrypt(password, salt, 64, {
            N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024
        });
    } finally {
        tcmAuthHashJobs--;
    }
}

async function tcmAuthHashPassword(password) {
    tcmAuthPasswordInput(password);
    const salt = tcmAuthCrypto.randomBytes(16).toString('hex');
    const key = await tcmAuthDerive(password, salt);
    return 'scrypt-v1$' + salt + '$' + key.toString('hex');
}

function tcmAuthSafeEqual(left, right) {
    const a = tcmAuthCrypto.createHash('sha256').update(String(left)).digest();
    const b = tcmAuthCrypto.createHash('sha256').update(String(right)).digest();
    return tcmAuthCrypto.timingSafeEqual(a, b);
}

async function tcmAuthVerifyPassword(user, password) {
    tcmAuthPasswordInput(password);
    if (!user) return false;
    if (Object.prototype.hasOwnProperty.call(user, 'PasswordHash')) {
        const match = typeof user.PasswordHash === 'string' &&
            /^scrypt-v1\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(user.PasswordHash);
        if (!match) return false;
        const supplied = await tcmAuthDerive(password, match[1]);
        return tcmAuthCrypto.timingSafeEqual(supplied, Buffer.from(match[2], 'hex'));
    }
    return typeof user.Password === 'string' && user.Password.length > 0 &&
        tcmAuthSafeEqual(password, user.Password);
}

function tcmAuthCredentialStamp(user) {
    return tcmAuthCrypto.createHash('sha256').update(JSON.stringify([
        user.PasswordHash ?? null, user.Password ?? null, user.PasswordVersion ?? null
    ])).digest('hex');
}

function tcmAuthPublicUser(user = {}) {
    const fields = [
        'UID', 'Name', 'Email', 'Phone', 'Country', 'Religion', 'Avatar', 'abdar', 'Profile_Version', 'Profile_Updated_At', 'Rank',
        'Role', 'Status', 'TimeZone', 'Date', 'Sponsor_A', 'Sponsor_B', 'Sponsor_C',
        'Wallet_BEP20', 'Wallet_TRC20', 'Wallet_Bound', 'Security_Date', 'Delete_At',
        'Wallet_BEP20_Display', 'Wallet_TRC20_Display',
        'Deposit_BEP20', 'Deposit_TRC20', 'Deposit_Wallet_Index',
        'counters', 'hasUnreadP2P', 'customId', 'TCM_ID'
    ];
    const result = {};
    for (const field of fields) {
        if (Object.prototype.hasOwnProperty.call(user, field)) result[field] = user[field];
    }
    result['2FA_Bound'] = Object.prototype.hasOwnProperty.call(user, '2FA_Key')
        ? typeof user['2FA_Key'] === 'string' && Boolean(user['2FA_Key'])
        : user['2FA_Bound'] === true;
    return result;
}

async function tcmAuthStartSession(reference, password, administrator = false) {
    const snapshot = await reference.get();
    const user = snapshot.exists ? snapshot.data() : null;
    if (!await tcmAuthVerifyPassword(user, password)) {
        throw tcmAuthError(401, 'Invalid credentials.');
    }
    const stamp = tcmAuthCredentialStamp(user);
    const upgradedHash = user.PasswordHash || await tcmAuthHashPassword(password);
    const token = tcmAuthCrypto.randomBytes(48).toString('hex');
    const result = await db.runTransaction(async transaction => {
        const current = await transaction.get(reference);
        if (!current.exists || tcmAuthCredentialStamp(current.data()) !== stamp) {
            throw tcmAuthError(409, 'Credentials changed. Please sign in again.');
        }
        const fresh = current.data();
        if (deletionV3AccessExpired(fresh)) {
            throw tcmAuthError(403, 'Account closure is due. Contact support if settlement is still pending.');
        }
        if (fresh.Status === 'Banned' || fresh.Account_Deleted === true ||
            (administrator && (fresh.Role !== 'Admin' || fresh.Status !== 'Active'))) {
            throw tcmAuthError(403, 'Account access is blocked or administrator access is unavailable.');
        }
        transaction.update(reference, {
            PasswordHash: upgradedHash,
            Password: FieldValue.delete(),
            Token: token
        });
        return { uid: current.id, user: tcmAuthPublicUser(fresh), token };
    });
    await invalidateDashboardSockets(result.uid, { keepToken: result.token });
    try { await clearUserCache(result.uid); } catch (error) {
        console.warn('[AUTH] Post-login cache invalidation unavailable.');
    }
    return result;
}

function tcmAuthResetKey() {
    const key = process.env.TCM_AUTH_OTP_SECRET;
    if (typeof key !== 'string' || !/^[a-f0-9]{64,}$/i.test(key)) {
        throw tcmAuthError(503, 'Password recovery is temporarily unavailable.');
    }
    return key;
}

function tcmAuthResetDigest(uid, challengeId, otp) {
    return tcmAuthCrypto.createHmac('sha256', tcmAuthResetKey())
        .update(JSON.stringify(['password-reset', uid, challengeId, otp])).digest('hex');
}

function tcmAuthCheckReset(user, uid, otp, now) {
    const proof = user && user.PasswordReset;
    if (!proof || proof.purpose !== 'password-reset' ||
        typeof proof.id !== 'string' || typeof proof.digest !== 'string' ||
        !Number.isFinite(proof.expiresAt) || now >= proof.expiresAt ||
        !Number.isInteger(proof.attempts) || proof.attempts < 0 || proof.attempts >= 5 ||
        proof.passwordVersion !== (user.PasswordVersion || 'legacy')) return false;
    return tcmAuthSafeEqual(proof.digest, tcmAuthResetDigest(uid, proof.id, otp));
}

app.post('/api/signup', authRateLimiter, async (req, res) => {
    try {
        const { name, email, password, phone, phoneRaw, country, religion, sponsor, avatar, timeZone, otp } = req.body;
        const usersRef = db.collection("Users");

        // 🔥 MEMO 06: Verify Redis OTP before proceeding
        if (!otp) return res.status(400).json({ success: false, message: "OTP is required!" });
        const cachedOTP = await getCache(`signup_otp_${email.toLowerCase().trim()}`);
        if (!cachedOTP || String(cachedOTP) !== String(otp)) { // 🔥 FIX: Strict Type Mismatch Fixed
            return res.status(400).json({ success: false, message: "Invalid or Expired OTP! Please request a new one." });
        }

        tcmAuthPasswordInput(password, true);
        const passwordHash = await tcmAuthHashPassword(password);
        const cleanEmail = email.toLowerCase().trim();
        const emailQuery = await usersRef.where("Email", "==", cleanEmail).get();
        if (!emailQuery.empty) return res.status(400).json({ success: false, message: "This Email is already registered!" });

        const phoneQuery = await usersRef.where("Phone", "==", phone).get();
        if (!phoneQuery.empty) return res.status(400).json({ success: false, message: "This Phone Number is already registered!" });

        let sponsor_A = "System", sponsor_B = "System", sponsor_C = "System";
        if (sponsor && sponsor !== "SYSTEM") {
            const sponsorDoc = await usersRef.doc(sponsor).get();
            if (sponsorDoc.exists) {
                const sData = sponsorDoc.data();
                sponsor_A = sponsor; sponsor_B = sData.Sponsor_A || "System"; sponsor_C = sData.Sponsor_B || "System";
            }
        }

        let finalUID = "";
        let isUnique = false;
        const nums = '23456789';
        const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

        while (!isUnique) {
            let nStr = ''; for(let i=0; i<3; i++) nStr += nums.charAt(Math.floor(Math.random() * nums.length));
            let lStr = ''; for(let i=0; i<3; i++) lStr += letters.charAt(Math.floor(Math.random() * letters.length));
            let combined = (nStr + lStr).split('').sort(() => 0.5 - Math.random()).join('');
            finalUID = `TCM${combined}`;
            
            const uidSnap = await usersRef.doc(finalUID).get();
            if (!uidSnap.exists) isUnique = true;
        }

        if (admin.auth) {
            try {
                await admin.auth().createUser({ uid: finalUID, email: cleanEmail, password: password, displayName: name });
            } catch (err) {
                if (err.code === 'auth/email-already-in-use') {
                    try {
                        const existingUser = await admin.auth().getUserByEmail(cleanEmail);
                        await admin.auth().deleteUser(existingUser.uid);
                        await admin.auth().createUser({ uid: finalUID, email: cleanEmail, password: password, displayName: name });
                    } catch (retryErr) {
                        console.log("[AUTH] Failed to clear orphan:", retryErr.message);
                    }
                }
            }
        }
        const sessionToken = tcmAuthCrypto.randomBytes(48).toString('hex');
        const batch = db.batch();

        // Withdrawal wallets are bound by the user; deposit wallets use HD backfill.

        batch.set(usersRef.doc(finalUID), {
            Date: new Date().toISOString(), UID: finalUID, Name: name, Email: cleanEmail,
            PasswordHash: passwordHash, PasswordVersion: tcmAuthCrypto.randomUUID(),
            Phone: phone, Sponsor_A: sponsor_A, Sponsor_B: sponsor_B, Sponsor_C: sponsor_C, Avatar: avatar || "", 
            Wallet_BEP20: "", Wallet_TRC20: "",
            Deposit_BEP20: "", Deposit_TRC20: "", Deposit_Wallet_Index: null, Security_Date: "", "2FA_Key": "", Rank: 0, Status: "Active", 
            OTP: "", Token: sessionToken, Religion: religion, Country: country,
            TimeZone: timeZone || "Asia/Kolkata"
        });

        batch.set(db.collection("Wallets").doc(finalUID), moneyV7NewWallet({
            Monthly_Quota: { version: 1, month: q4Month().key, withdrawals: 0, p2p: 0 },
            UID: finalUID, Main_Balance: 0, Locked_Balance: 0, Debt: 0, Points: 0, Total_Deposit: 0, Total_Withdraw: 0, 
            Total_Earn: 0, Daily_Earn: 0, Total_Team: 0, Daily_Team: 0, Total_Stake: 0, Daily_Stake: 0, 
            Total_Reserve: 0, Daily_Reserve: 0, Total_Airdrop: 0, Daily_Airdrop: 0, Total_Comp: 0, Daily_Comp: 0,
            Lifetime_Stake: 0, // 🔥 FIX: নতুন অ্যাকাউন্ট খোলার সাথে সাথেই লাইফটাইম স্টেক 0 সেট হয়ে যাবে
            Last_Reset_Day: "",
            cards: {
                silver: generateCardNumber(),
                gold: generateCardNumber(),
                platinum: generateCardNumber(),
                diamond: generateCardNumber()
            }
        }));

        await batch.commit();
        
        // Account creation is committed; cache cleanup cannot turn it into a failure.
        await m2RedisCommand(() => redisClient.del(`signup_otp_${cleanEmail}`));
        if (hdDepositConfig) {
            try { await ensureUserDepositWallets(finalUID); }
            catch (error) { console.warn('[HD DEPOSIT] Signup completed; wallet backfill is pending.'); }
        }

        res.status(200).json({ success: true, uid: finalUID, token: sessionToken });
    } catch (error) { res.status(500).json({ success: false, message: "Registration failed." }); }
});

// 🔥 Memo 04: authRateLimiter যুক্ত করা হলো সাইনআপ এবং লগইনে
// MEMO: TCM-AUTH-GREENLIGHT | 2026-10-10 | Asia/Kolkata
// Dedicated admin authentication. Consumer login remains unchanged.
app.post('/api/admin/login', authRateLimiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const { identifier, password } = req.body || {};
        if (typeof identifier !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(identifier.trim())) {
            throw tcmAuthError(400, 'Provide a valid Admin UID and password.');
        }
        tcmAuthPasswordInput(password);
        const users = db.collection('Users');
        const normalizedId = identifier.trim().toUpperCase();
        const direct = await users.doc(normalizedId).get();
        let reference = direct.exists ? direct.ref : null;
        if (!reference) {
            const matches = new Map();
            for (const field of ['customId', 'TCM_ID']) {
                const result = await users.where(field, '==', normalizedId).limit(2).get();
                for (const doc of result.docs) matches.set(doc.id, doc.ref);
            }
            if (matches.size === 1) reference = [...matches.values()][0];
        }
        if (!reference) throw tcmAuthError(401, 'Invalid administrator credentials.');
        const result = await tcmAuthStartSession(reference, password, true);
        res.json({ success: true, uid: result.uid, name: result.user.Name || '',
            token: result.token, role: 'Admin' });
    } catch (error) {
        res.status(error.status || 503).json({ success: false,
            message: error.status ? error.message : 'Administrator authentication is temporarily unavailable.' });
    }
});

// The global /api middleware has already verified the Bearer token.
// ============================================================================
// T8: IMMUTABLE MAIN BALANCE AUDIT. Display history only; never payment authority.
// Each entry links to its predecessor. Reading two entries needs no 20-row query.
// ============================================================================
function t8MainEntry(transaction, uid, wallet, nextMain, type, reference = '') {
    if (nextMain === undefined) return {};
    const beforeMicro = admS2Balance(wallet, 'Main_Balance');
    const afterMicro = admS2Micro(nextMain, 'audit next balance');
    const before = admS2Money(beforeMicro), after = admS2Money(afterMicro);
    const ref = db.collection('Main_Balance_Ledgers').doc(uid).collection('Entries').doc();
    const now = new Date().toISOString();
    const previous = wallet.Main_Ledger_Head || null;
    if (previous !== null && !/^[A-Za-z0-9_-]{1,80}$/.test(previous)) throw new Error('Invalid balance audit pointer.');
    const entry = {
        UID: uid, Type: type, Balance_Old: before, Balance_New: after,
        Balance_Old_micro: beforeMicro.toString(), Balance_New_micro: afterMicro.toString(),
        Balance_Delta_micro: (afterMicro - beforeMicro).toString(),
        Previous: previous, Reference: String(reference).slice(0, 200), Date: now,
        Status: 'Posted', Audit_Version: 2, timestamp: FieldValue.serverTimestamp()
    };
    transaction.create(ref, entry);
    t9RememberAudit(transaction, ref.id, entry);
    return { Main_Ledger_Head: ref.id, Main_Ledger_Started: wallet.Main_Ledger_Started || now };
}

// Referral wallets can occur in more than one hand. Record the combined increment.
function t8TeamEntries(transaction, snapshots, gross, reference, overrides = new Map()) {
    const grouped = new Map();
    for (const [snapshot, rate] of snapshots) {
        if (!snapshot?.exists) continue;
        // Preserve the existing two-decimal commission rounding.
        const amount = parseFloat((gross * rate).toFixed(2));
        const amountMicro = admS2Micro(amount, 'NFT team commission');
        const wallet = overrides.get(snapshot.id) || snapshot.data();
        const item = grouped.get(snapshot.id) || { snapshot, wallet, creditMicro: 0n };
        item.creditMicro += amountMicro;
        grouped.set(snapshot.id, item);
    }
    const updates = new Map();
    for (const { snapshot, wallet, creditMicro } of grouped.values()) {
        const nextMain = admS2Money(admS2Balance(wallet, 'Main_Balance') + creditMicro);
        updates.set(snapshot.id, {
            ...t8MainEntry(transaction, snapshot.id, wallet, nextMain, 'NFT team commission', reference),
            Main_Balance: nextMain,
            Total_Team: admS2Money(admS2Balance(wallet, 'Total_Team') + creditMicro),
            Total_Comp: admS2Money(admS2Balance(wallet, 'Total_Comp') + creditMicro)
        });
    }
    return updates;
}

function moneyV4NFTDailyUpdates(t, walletRef, wallet, credits, dayKey) {
    const updates = buildISTDailyIncomeUpdates(t, walletRef, wallet, credits, dayKey);
    const state = incomeDayStates.get(t).get(walletRef.path);
    for (const field of Object.keys(updates)) {
        if (field === 'Last_Reset_Day') continue;
        const amount = admS2Money(moneyV1ReadLegacy(updates[field], field).micro);
        updates[field] = amount;
        state[field] = amount;
    }
    return updates;
}

function t8ValidHistoryRow(row, uid, id) {
    if (!row || row.UID !== uid || typeof row.id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,80}$/.test(row.id) || (id !== undefined && row.id !== id) ||
        ![1, 2].includes(row.Audit_Version) ||
        (row.Previous !== null && (typeof row.Previous !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(row.Previous)))) return false;
    if (![row.Balance_Old, row.Balance_New].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return false;
    if (row.Audit_Version === 1) return true;
    try {
        const unsigned = /^(?:0|[1-9]\d{0,15})$/;
        const signed = /^(?:0|-?[1-9]\d{0,15})$/;
        if (typeof row.Balance_Old_micro !== 'string' || !unsigned.test(row.Balance_Old_micro) ||
            typeof row.Balance_New_micro !== 'string' || !unsigned.test(row.Balance_New_micro) ||
            typeof row.Balance_Delta_micro !== 'string' || !signed.test(row.Balance_Delta_micro)) return false;
        const before = BigInt(row.Balance_Old_micro), after = BigInt(row.Balance_New_micro);
        const project = (value, micro) => {
            if (micro > BigInt(Number.MAX_SAFE_INTEGER) || value !== Number(micro) / 1000000 || !/^\d+(?:\.\d{1,6})?$/.test(String(value))) return false;
            const [whole, fraction = ''] = String(value).split('.');
            return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0')) === micro;
        };
        return project(row.Balance_Old, before) && project(row.Balance_New, after) &&
            after - before === BigInt(row.Balance_Delta_micro);
    } catch (_) { return false; }
}

function t9ValidSnapshot(row, uid) {
    if (![1, 2].includes(row.Balance_Snapshot_Version) ||
        !['Main_Balance', 'Combined_NFT_Commission', 'No_Main_Balance_Movement'].includes(row.Balance_Scope)) return false;
    const unchanged = row.Balance_Scope === 'No_Main_Balance_Movement';
    if (unchanged ? row.Main_Ledger_Entry_ID !== null :
        typeof row.Main_Ledger_Entry_ID !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(row.Main_Ledger_Entry_ID)) return false;
    if (!t8ValidHistoryRow({ ...row, UID: uid, id: row.Main_Ledger_Entry_ID || 'unchanged', Previous: null,
        Audit_Version: row.Balance_Snapshot_Version }, uid)) return false;
    return !unchanged || (row.Balance_Old === row.Balance_New && row.Balance_Delta_micro === '0');
}
const t9LinkFlights = new Map();
async function t9HistoricalSnapshot(uid, id, value, source) {
    const auditType = t9AuditType(value.Type);
    const reference = value.Type === 'Company Profit Share' ? value.Request_ID :
        value.Type === 'Team Reservation Bonus' ? value.Event_ID :
        ['Airdrop', 'Airdrop Reversal', 'Admin Vault Lock', 'Admin Vault Unlock'].includes(value.Type) ? value.Operation_ID : value.Order_ID;
    const date = Date.parse(value.Date);
    if (!auditType || typeof reference !== 'string' || !reference || reference.length > 200 || !Number.isFinite(date)) return null;
    const key = 't9_link_' + tcmAuthCrypto.createHash('sha256')
        .update(JSON.stringify([uid, source, id, reference, value.Type, value.Date])).digest('hex');
    const valid = row => {
        if (!t8ValidHistoryRow(row, uid) || row.Type !== auditType || row.Reference !== reference) return false;
        const auditDate = Date.parse(row.Date);
        if (!Number.isFinite(auditDate) || Math.abs(auditDate - date) > 300000) return false;
        // Check the amount against an existing audit; never reconstruct a past balance.
        try {
            const delta = row.Audit_Version === 2 ? BigInt(row.Balance_Delta_micro) :
                moneyV1ReadLegacy(row.Balance_New, 'historical balance').micro - moneyV1ReadLegacy(row.Balance_Old, 'historical balance').micro;
            const amount = moneyV1ReadLegacy(value.Amount, 'historical amount').micro;
            if (['P2P Sent', 'Staking Lock', 'NFT Reserve', 'Withdraw', 'Admin Vault Lock'].includes(value.Type)) return delta === -amount;
            if (['P2P Received', 'NFT Sold', 'Staking Reward', 'Team Reservation Bonus', 'Company Profit Share', 'Airdrop', 'Admin Vault Unlock'].includes(value.Type)) return delta === amount;
            if (value.Type === 'NFT Profit' || /^Team Bonus \([ABC]-Hand\)$/.test(value.Type)) return delta >= amount;
            if (value.Type === 'Airdrop Reversal') return delta <= 0n && -delta <= amount;
            return true;
        } catch (_) { return false; }
    };
    const cached = await getCache(key);
    if (cached?.uid === uid && cached.missing === true) return null;
    if (cached?.uid === uid && valid(cached.row)) return t9AuditSnapshot(cached.row, value.Type, 'Linked_Audit');
    let flight = t9LinkFlights.get(key);
    if (!flight) {
        if (t9LinkFlights.size >= 200) return null;
        flight = (async () => {
            try {
                const snapshot = await db.collection('Main_Balance_Ledgers').doc(uid).collection('Entries')
                    .where('Reference', '==', reference).where('Type', '==', auditType).limit(2).get();
                // Two matches are ambiguous, even if only one appears numerically plausible.
                if (snapshot.docs.length !== 1) {
                    try { await setCache(key, { uid, missing: true }, 60); } catch (_) {}
                    return null;
                }
                const doc = snapshot.docs[0], row = { ...doc.data(), id: doc.id };
                if (!valid(row)) return null;
                try { await setCache(key, { uid, row }, 86400); } catch (_) {}
                return t9AuditSnapshot(row, value.Type, 'Linked_Audit');
            } catch (error) {
                const link = String(error.message || '').match(/https:\/\/console\.(?:firebase|cloud)\.google\.com\/[^\s)]+/);
                console.warn('[T9 HISTORY] Audit lookup unavailable:', error.code || 'unknown', link ? link[0] : '');
                return null;
            }
        })().finally(() => t9LinkFlights.delete(key));
        t9LinkFlights.set(key, flight);
    }
    return flight;
}
async function t9HistoryRecord(uid, source, doc) {
    const value = doc.data();
    if (value.UID !== uid) throw new Error('Invalid record owner.');
    const result = { id: doc.id, UID: uid, Type: value.Type || 'Transaction', Date: value.Date || '',
        Status: value.Status || value.status || 'Recorded', Amount: value.Amount ?? null,
        Reference: value.Order_ID || '', Legacy: true, Balance_Source: 'Unavailable',
        Balance_Old: null, Balance_New: null };
    const fields = ['Balance_Old', 'Balance_New', 'Balance_Old_micro', 'Balance_New_micro', 'Balance_Delta_micro',
        'Balance_Snapshot_Version', 'Main_Ledger_Entry_ID', 'Balance_Scope'];
    if (value.Balance_Snapshot_Version !== undefined) {
        if (t9ValidSnapshot(value, uid)) {
            for (const field of fields) if (value[field] !== undefined) result[field] = value[field];
            result.Balance_Source = 'Committed_Record';
        } else result.Balance_Source = 'Invalid_Snapshot';
        return result;
    }
    if ([value.Balance_Old, value.Balance_New].every(amount => typeof amount === 'number' && Number.isFinite(amount) && amount >= 0)) {
        result.Balance_Old = value.Balance_Old; result.Balance_New = value.Balance_New;
        result.Balance_Source = 'Recorded_Fields';
        return result;
    }
    const matched = await t9HistoricalSnapshot(uid, doc.id, value, source);
    if (matched) Object.assign(result, matched);
    return result;
}

const t8EntryFlights = new Map();
app.get('/api/finance/main-ledger', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const uid = req.authenticatedUid;
        if (!uid || (req.query.uid && req.query.uid !== uid)) return res.status(403).json({ success: false, message: 'Account ownership mismatch.' });
        let cursor = req.query.cursor || null;
        const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 20 ||
            (cursor !== null && (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(cursor)))) {
            return res.status(400).json({ success: false, message: 'Invalid history cursor or limit.' });
        }
        const rows = [], seen = new Set();
        while (cursor && rows.length < limit) {
            if (seen.has(cursor)) throw new Error('Balance history cycle detected.');
            seen.add(cursor);
            const id = cursor, key = `t8_entry_${encodeURIComponent(uid)}_${id}`;
            let row = await getCache(key);
            if (!t8ValidHistoryRow(row, uid, id)) {
                let flight = t8EntryFlights.get(key);
                if (!flight) {
                    if (t8EntryFlights.size >= 200) throw new Error('History reader busy.');
                    flight = (async () => {
                        const doc = await db.collection('Main_Balance_Ledgers').doc(uid).collection('Entries').doc(id).get();
                        if (!doc.exists) throw new Error('Balance history entry missing.');
                        const value = doc.data();
                        if (!t8ValidHistoryRow({ ...value, id }, uid, id)) throw new Error('Invalid balance history entry.');
                        const fields = ['UID', 'Type', 'Balance_Old', 'Balance_New',
                            'Previous', 'Reference', 'Date', 'Status', 'Audit_Version'];
                        if (value.Audit_Version === 2) fields.push('Balance_Old_micro', 'Balance_New_micro', 'Balance_Delta_micro');
                        const result = Object.fromEntries(fields.map(field => [field, value[field]]));
                        result.id = id;
                        try { await setCache(key, result, 86400); } catch (_) {}
                        return result;
                    })().finally(() => t8EntryFlights.delete(key));
                    t8EntryFlights.set(key, flight);
                }
                row = await flight;
            }
            rows.push(row); cursor = row.Previous;
        }
        return res.json({ success: true, data: rows, nextCursor: cursor, hasMore: Boolean(cursor) });
    } catch (error) {
        console.warn('[T8 HISTORY]', error.code || 'unavailable');
        return res.status(503).json({ success: false, message: 'Balance history is temporarily unavailable. Retry without submitting a payment.' });
    }
});

// Earlier records remain available. Missing historical balances are never inferred.
app.get('/api/finance/ledger-records', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const uid = req.authenticatedUid, source = req.query.source || 'transactions';
        const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
        if (!uid || (req.query.uid && req.query.uid !== uid)) return res.status(403).json({ success: false, message: 'Account ownership mismatch.' });
        if (!['transactions', 'reservations'].includes(source) || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid history request.');
        let cursor = null;
        if (req.query.cursor) {
            if (typeof req.query.cursor !== 'string' || req.query.cursor.length > 600) throw new Error('Invalid cursor.');
            cursor = JSON.parse(Buffer.from(req.query.cursor, 'base64url').toString('utf8'));
            if (!cursor || typeof cursor.date !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(cursor.date) || cursor.date.length > 40 ||
                typeof cursor.id !== 'string' || !/^[A-Za-z0-9_-]{1,150}$/.test(cursor.id)) throw new Error('Invalid cursor.');
        }
        const version = req.authenticatedUserDoc?.data()?.counters?.txCount ?? 'unknown';
        const key = 't9_records_' + tcmAuthCrypto.createHash('sha256').update(JSON.stringify([uid, source, cursor, limit, version])).digest('hex');
        const cached = await getCache(key);
        if (cached?.uid === uid) return res.json({ success: true, ...cached });
        let query = db.collection(source === 'transactions' ? 'Transactions' : 'NFT_History').where('UID', '==', uid);
        if (source === 'reservations') query = query.where('Type', '==', 'NFT Reserve');
        query = query.orderBy('Date', 'desc').orderBy(m2FieldPath.documentId(), 'desc').limit(limit);
        if (cursor) query = query.startAfter(cursor.date, cursor.id);
        const snapshot = await query.get();
        const data = await Promise.all(snapshot.docs.map(doc => t9HistoryRecord(uid, source, doc)));
        const last = data[data.length - 1];
        const result = { uid, data, nextCursor: last ? Buffer.from(JSON.stringify({ date: last.Date, id: last.id })).toString('base64url') : null,
            hasMore: data.length === limit, version, snapshotSchema: 1 };
        try { await setCache(key, result, 60); } catch (_) {}
        return res.json({ success: true, ...result });
    } catch (error) {
        console.warn('[T8 LEGACY]', error.code || 'invalid-request', error.message);
        return res.status(e4MissingIndex(error) ? 503 : 400).json({ success: false,
            message: e4MissingIndex(error) ? 'History index is not ready. Check the server log for the Firestore index link.' : 'Transaction records could not be loaded.' });
    }
});

app.get('/api/admin/session', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const current = req.authenticatedUserDoc;
        const user = current && current.exists && current.id === req.authenticatedUid
            ? current.data()
            : null;
        const token = (req.headers.authorization || '').slice(7);

        if (!user || user.Token !== token) {
            return res.status(401).json({ success: false, message: 'Session expired. Please sign in again.' });
        }
        if (user.Role !== 'Admin' || user.Status !== 'Active') {
            return res.status(403).json({ success: false, message: 'Active administrator privileges required.' });
        }
        return res.json({
            success: true,
            uid: current.id,
            name: typeof user.Name === 'string' ? user.Name : '',
            role: 'Admin'
        });
    } catch (error) {
        return res.status(503).json({ success: false, message: 'Session verification is temporarily unavailable.' });
    }
});

app.post('/api/login', authRateLimiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const { identifier, password, isEmail } = req.body || {};
        if (typeof identifier !== 'string' || !identifier.trim() || identifier.length > 254) {
            throw tcmAuthError(400, 'Enter your UID or email.');
        }
        tcmAuthPasswordInput(password);
        const users = db.collection('Users');
        const value = identifier.trim();
        let reference;
        if (isEmail || value.includes('@')) {
            const matches = await users.where('Email', '==', value.toLowerCase()).limit(2).get();
            if (matches.size === 1) reference = matches.docs[0].ref;
        } else {
            const normalized = value.toUpperCase();
            if (!/^[A-Z0-9_-]{1,128}$/.test(normalized)) {
                throw tcmAuthError(400, 'Enter a valid account identifier.');
            }
            const direct = await users.doc(normalized).get();
            if (direct.exists) reference = direct.ref;
            else {
                const matches = new Map();
                for (const field of ['customId', 'TCM_ID']) {
                    const result = await users.where(field, '==', normalized).limit(2).get();
                    for (const doc of result.docs) matches.set(doc.id, doc.ref);
                }
                if (matches.size === 1) reference = [...matches.values()][0];
            }
        }
        if (!reference) throw tcmAuthError(401, 'Invalid credentials.');
        const result = await tcmAuthStartSession(reference, password);
        const user = result.user;
        let totalComp = 0;
        try {
            const wallet = await db.collection('Wallets').doc(result.uid).get();
            if (wallet.exists) totalComp = admS2Money(admS2Balance(wallet.data(), 'Total_Comp'));
        } catch (error) {
            console.warn('[AUTH] Login wallet preview unavailable.');
        }
        res.json({
            success: true, uid: result.uid, token: result.token,
            name: user.Name || '', email: user.Email || '',
            Phone: user.Phone || 'N/A', Country: user.Country || 'N/A',
            avatar: user.Avatar || '', timeZone: user.TimeZone || 'Asia/Kolkata', totalComp
        });
    } catch (error) {
        res.status(error.status || 503).json({ success: false,
            message: error.status ? error.message : 'Sign-in is temporarily unavailable.' });
    }
});

// =========================================================
// 🚀 MODULE 1.5: OTP & FORGOT PASSWORD ENGINE (Cache Fixed)
// =========================================================

// 🔥 Smart OTP Limiter: অ্যাকশন-বেসড স্প্যাম প্রটেকশন (১ মিনিটের লক)
// 🔥 Smart OTP Limiter: ৩ বার চেষ্টার পর ৬০ সেকেন্ডের লক
const otpRequestCache = new Map();
const otpLimiter = (req, res, next) => {
    const identifier = (req.body.uid || req.body.email || req.ip) + '_' + req.path; 
    const now = Date.now();
    
    let reqData = otpRequestCache.get(identifier) || { attempts: 0, lockUntil: 0 };

    if (now < reqData.lockUntil) {
        let waitSec = Math.ceil((reqData.lockUntil - now) / 1000);
        return res.status(429).json({ success: false, message: `Limit reached! Please wait ${waitSec} seconds.` });
    }

    reqData.attempts += 1;
    
    if (reqData.attempts >= 3) {
        reqData.lockUntil = now + 60000; // ৩ বারের পর ৬০ সেকেন্ড লক
        reqData.attempts = 0; // লক খোলার পর আবার ৩ বারের সুযোগ
    }
    
    otpRequestCache.set(identifier, reqData);
    next();
};

// 📧 1. Global OTP Engine (For Forgot Pass, 2FA, Wallet Bind)
function tcmSecurityEmail({ name = 'Member', title, action, otp, minutes }) {
    const escape = value => String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
    const recipient = String(name || 'Member').slice(0, 120);
    const expiry = Number.isInteger(minutes) && minutes > 0
        ? 'This code expires in ' + minutes + ' minutes.' : 'Use the latest code you requested.';
    const text = 'Hello ' + recipient + ',\n\nYour ' + action + ' code is ' + otp +
        '.\n' + expiry + '\nNever share this code. TCM staff will not ask for it.\n' +
        'If you did not request this action, do not use or share this code.';
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escape(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;">
        <tr><td align="center" style="padding:24px 12px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:500px;background:#0b1120;border:1px solid #334155;border-radius:14px;">
                <tr><td style="padding:28px 20px 12px;text-align:center;">
                    <p style="margin:0 0 8px;color:#00f5ff;font-size:22px;font-weight:bold;">TCM Security</p>
                    <h1 style="margin:0;color:#f8fafc;font-size:19px;line-height:1.4;">${escape(title)}</h1>
                </td></tr>
                <tr><td style="padding:12px 20px;color:#e2e8f0;font-size:15px;line-height:1.6;overflow-wrap:anywhere;">
                    <p style="margin:0 0 12px;">Hello ${escape(recipient)},</p>
                    <p style="margin:0;">Use this code for ${escape(action)}:</p>
                </td></tr>
                <tr><td align="center" style="padding:8px 20px 20px;">
                    <div style="padding:18px 8px;background:#172334;border:1px solid #334155;border-radius:10px;color:#34d399;font-family:monospace;font-size:30px;font-weight:bold;letter-spacing:5px;white-space:nowrap;">${escape(otp)}</div>
                </td></tr>
                <tr><td style="padding:0 20px 28px;color:#cbd5e1;font-size:13px;line-height:1.6;">
                    <p style="margin:0 0 10px;">${escape(expiry)}</p>
                    <p style="margin:0 0 10px;">Never share this code. TCM staff will not ask for it.</p>
                    <p style="margin:0;">If you did not request this action, do not use or share this code.</p>
                </td></tr>
            </table>
        </td></tr>
    </table>
</body>
</html>`;
    return { text, html };
}

const sendOTPEngine = async (req, res) => {
    try {
        const { uid, email } = req.body;
        let userDoc;

        if (uid) {
            userDoc = await db.collection("Users").doc(uid).get();
        } else if (email) {
            const snapshot = await db.collection("Users").where("Email", "==", email.toLowerCase().trim()).get();
            if (!snapshot.empty) userDoc = snapshot.docs[0];
        }

        if (!userDoc || !userDoc.exists) throw new Error("No account found.");

        const uData = userDoc.data();
        const generatedOTP = Math.floor(100000 + Math.random() * 900000).toString();
        await userDoc.ref.update({ OTP: generatedOTP });

        const mailOptions = {
            from: '"TCM Security" <' + process.env.EMAIL_USER + '>',
            to: uData.Email,
            subject: 'TCM NFT - Security Verification Code',
            ...tcmSecurityEmail({ name: uData.Name, title: 'Security verification',
                action: 'security verification', otp: generatedOTP })
        };
        
        // 🔥 FIX: Asynchronous Email Sending (সার্ভার মেইলের জন্য অপেক্ষা করবে না, সাথে সাথে রেসপন্স দেবে)
        transporter.sendMail(mailOptions).catch(err => console.error("OTP Delivery Error:", err));
        
        res.status(200).json({ success: true, uid: uData.UID, message: "OTP sent successfully!" }); 
    } catch (error) { res.status(400).json({ success: false, message: error.message }); } 
};

// 🛡️ API-তে Rate Limiter এবং ইঞ্জিন যুক্ত করা হলো (HOISTING FIX)
app.post('/api/auth/send-otp', otpLimiter, sendOTPEngine); 
app.post('/api/forgot-password/send-otp', otpLimiter, authRateLimiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        tcmAuthResetKey();
        const { uid, email } = req.body || {};
        let reference;
        if (typeof uid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(uid)) {
            reference = db.collection('Users').doc(uid);
        } else if (typeof email === 'string' && email.length <= 254 && email.includes('@')) {
            const matches = await db.collection('Users')
                .where('Email', '==', email.trim().toLowerCase()).limit(2).get();
            if (matches.size === 1) reference = matches.docs[0].ref;
        } else {
            throw tcmAuthError(400, 'Enter your registered email.');
        }
        if (!reference) throw tcmAuthError(400, 'Unable to start recovery for this account.');
        const otp = String(tcmAuthCrypto.randomInt(100000, 1000000));
        const id = tcmAuthCrypto.randomUUID();
        const issued = await db.runTransaction(async transaction => {
            const snapshot = await transaction.get(reference);
            const user = snapshot.exists ? snapshot.data() : null;
            if (!user || typeof user.Email !== 'string' || !user.Email.includes('@')) {
                throw tcmAuthError(400, 'Unable to start recovery for this account.');
            }
            const now = Date.now();
            const previous = user.PasswordReset;
            if (previous && Number.isFinite(previous.issuedAt) && now - previous.issuedAt < 60000) {
                throw tcmAuthError(429, 'Please wait before requesting another recovery code.');
            }
            transaction.update(reference, {
                PasswordReset: {
                    purpose: 'password-reset', id,
                    digest: tcmAuthResetDigest(snapshot.id, id, otp),
                    issuedAt: now, expiresAt: now + 300000, attempts: 0,
                    passwordVersion: user.PasswordVersion || 'legacy'
                }
            });
            return { uid: snapshot.id, email: user.Email };
        });
        try {
            await transporter.sendMail({
                from: '"TCM Security" <' + process.env.EMAIL_USER + '>',
                to: issued.email,
                subject: 'TCM password recovery code',
                ...tcmSecurityEmail({ title: 'Password recovery',
                    action: 'password reset', otp, minutes: 5 })
            });
        } catch (error) {
            await db.runTransaction(async transaction => {
                const snapshot = await transaction.get(reference);
                if (snapshot.exists && snapshot.data().PasswordReset?.id === id) {
                    transaction.update(reference, { PasswordReset: FieldValue.delete() });
                }
            });
            throw tcmAuthError(503, 'Recovery email could not be sent. Please try again.');
        }
        res.json({ success: true, uid: issued.uid, message: 'Recovery code sent. It expires in 5 minutes.' });
    } catch (error) {
        res.status(error.status || 503).json({ success: false,
            message: error.status ? error.message : 'Recovery is temporarily unavailable.' });
    }
});
app.post('/api/security/send-otp', otpLimiter, sendOTPEngine);

// 📧 2. Pre-Registration OTP System (For New Signups)
app.post('/api/signup/send-otp', otpLimiter, async (req, res) => {
    try {
        const { email, name } = req.body;
        if (!email) throw new Error("Email is required");

        const cleanEmail = email.toLowerCase().trim();
        const emailQuery = await db.collection("Users").where("Email", "==", cleanEmail).get();
        if (!emailQuery.empty) throw new Error("This Email is already registered!");

        const generatedOTP = Math.floor(100000 + Math.random() * 900000).toString();
        await setCache(`signup_otp_${cleanEmail}`, generatedOTP, 300); // 300s = 5 mins

        const mailOptions = {
            from: '"TCM Security" <' + process.env.EMAIL_USER + '>',
            to: cleanEmail,
            subject: 'TCM NFT - Registration Verification Code',
            ...tcmSecurityEmail({ name: name || 'New Citizen', title: 'Registration verification',
                action: 'registration', otp: generatedOTP, minutes: 5 }),
            text: 'Your TCM registration code is ' + generatedOTP + '. It expires in 5 minutes. Do not share this code.',
            headers: { 'X-Priority': '1', 'X-MSMail-Priority': 'High' }
        };

        await transporter.sendMail(mailOptions);
        res.status(200).json({ success: true, message: "Registration OTP sent! Check your email." }); 
    } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});

app.post('/api/forgot-password/reset', authRateLimiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const { uid, enteredOTP, newPass } = req.body || {};
        if (typeof uid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(uid) ||
            typeof enteredOTP !== 'string' || !/^\d{6}$/.test(enteredOTP)) {
            throw tcmAuthError(400, 'Enter a valid recovery code.');
        }
        tcmAuthPasswordInput(newPass, true);
        tcmAuthResetKey();
        const reference = db.collection('Users').doc(uid);
        const preflight = await db.runTransaction(async transaction => {
            const snapshot = await transaction.get(reference);
            const user = snapshot.exists ? snapshot.data() : null;
            const proof = user && user.PasswordReset;
            if (!tcmAuthCheckReset(user, uid, enteredOTP, Date.now())) {
                if (proof && Number.isInteger(proof.attempts) && proof.attempts >= 0 &&
                    proof.attempts < 5 && Number.isFinite(proof.expiresAt) && proof.expiresAt > Date.now()) {
                    transaction.update(reference, { 'PasswordReset.attempts': proof.attempts + 1 });
                }
                return null;
            }
            return { id: proof.id, stamp: tcmAuthCredentialStamp(user) };
        });
        if (!preflight) throw tcmAuthError(400, 'Invalid or expired recovery code. Request a new code if needed.');
        const passwordHash = await tcmAuthHashPassword(newPass);
        const token = tcmAuthCrypto.randomBytes(48).toString('hex');
        const passwordVersion = tcmAuthCrypto.randomUUID();
        await db.runTransaction(async transaction => {
            const snapshot = await transaction.get(reference);
            const user = snapshot.exists ? snapshot.data() : null;
            if (!user || user.PasswordReset?.id !== preflight.id ||
                tcmAuthCredentialStamp(user) !== preflight.stamp ||
                !tcmAuthCheckReset(user, uid, enteredOTP, Date.now())) {
                throw tcmAuthError(409, 'Recovery state changed. Request a new code and try again.');
            }
            transaction.update(reference, {
                PasswordHash: passwordHash, Password: FieldValue.delete(),
                PasswordVersion: passwordVersion, PasswordReset: FieldValue.delete(),
                OTP: '', Token: token
            });
        });
        await invalidateDashboardSockets(uid, { keepToken: token });
        try { await clearUserCache(uid); } catch (error) {
            console.warn('[AUTH] Post-reset cache invalidation unavailable.');
        }
        res.json({ success: true, message: 'Password updated. Sign in with your new password.' });
    } catch (error) {
        res.status(error.status || 503).json({ success: false,
            message: error.status ? error.message : 'Password recovery is temporarily unavailable.' });
    }
});

// =========================================================
// 🚀 MODULE 2: SECURITY ENGINE (BINDING 2FA & WALLET)
// =========================================================
app.post('/api/auth/generate-2fa', async (req, res) => {
    try {
        const secret = authenticator.generateSecret();
        const issuer = encodeURIComponent('TCM NFT');
        const account = encodeURIComponent(req.body.uid);
        res.json({ success: true, secret, otpauth: `otpauth://totp/${issuer}:${account}?secret=${secret}&issuer=${issuer}` });
    } catch(e) { res.status(400).json({ success: false, message: e.message }); }
});

const bind2FAEngine = async (req, res) => {
    try {
        const uid = req.body.uid;
        const otp = req.body.otp || req.body.emailOTP;
        const code = req.body.code || req.body.code2FA;
        const secret = req.body.secret || req.body.secretKey;

        const userRef = db.collection("Users").doc(uid);
        const userSnap = await userRef.get();
        
        if (!userSnap.exists || userSnap.data().OTP !== otp) throw new Error("Invalid or Expired Email OTP!");
        if (!authenticator.verify({ token: code, secret: secret })) throw new Error("Invalid Authenticator Code!");
        
        await userRef.update({ "2FA_Key": secret, OTP: "", Security_Date: FieldValue.serverTimestamp() });
        await clearUserCache(uid); 
        res.json({ success: true, message: "Google 2FA Bound Successfully!" });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
};
app.post('/api/auth/bind-2fa', bind2FAEngine);
app.post('/api/security/bind-2fa', bind2FAEngine); 

const unbind2FAEngine = async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const uid = req.authenticatedUid;
        const { password } = req.body || {};
        const otp = req.body?.otp || req.body?.emailOTP;
        if (!uid || (req.body?.uid !== undefined && req.body.uid !== uid)) {
            throw tcmAuthError(403, 'Account ownership mismatch.');
        }
        if (typeof otp !== 'string' || !/^\d{6}$/.test(otp)) {
            throw tcmAuthError(400, 'Enter a valid email OTP.');
        }
        const reference = db.collection('Users').doc(uid);
        const snapshot = await reference.get();
        const user = snapshot.exists ? snapshot.data() : null;
        if (!await tcmAuthVerifyPassword(user, password)) {
            throw tcmAuthError(401, 'Incorrect password.');
        }
        const stamp = tcmAuthCredentialStamp(user);
        const suppliedToken = (req.headers.authorization || '').slice(7);
        await db.runTransaction(async transaction => {
            const current = await transaction.get(reference);
            const fresh = current.exists ? current.data() : null;
            if (!fresh || fresh.Token !== suppliedToken || tcmAuthCredentialStamp(fresh) !== stamp) {
                throw tcmAuthError(401, 'Session or credentials changed. Sign in again.');
            }
            if (fresh.Status === 'Banned') throw tcmAuthError(403, 'Account access is blocked.');
            if (typeof fresh.OTP !== 'string' || !/^\d{6}$/.test(fresh.OTP) ||
                !tcmAuthSafeEqual(fresh.OTP, otp)) {
                throw tcmAuthError(400, 'Invalid email OTP.');
            }
            transaction.update(reference, {
                '2FA_Key': '', OTP: '', Security_Date: FieldValue.serverTimestamp()
            });
        });
        try { await clearUserCache(uid); } catch (error) {
            console.warn('[AUTH] Post-unbind cache invalidation unavailable.');
        }
        res.json({ success: true, message: 'Google 2FA unbound.' });
    } catch (error) {
        res.status(error.status || 503).json({ success: false,
            message: error.status ? error.message : 'Security update is temporarily unavailable.' });
    }
};
app.post('/api/auth/unbind-2fa', unbind2FAEngine);
app.post('/api/security/unbind-2fa', unbind2FAEngine); 

const c2FeeDefaults = Object.freeze({ wdFeePctBEP20: 7, wdFeePctTRC20: 10, p2pFeePct: 5 });
function c2Error(message, status = 400) {
    return Object.assign(admS2Error(message, status), { statusCode: status });
}
function c2Pct(value) {
    if (!['string', 'number'].includes(typeof value) || !/^\d{1,2}(?:\.\d{1,2})?$/.test(String(value))) {
        throw c2Error('Fee percentages must have at most two decimal places.');
    }
    const n = Number(value);
    if (n < 0.01 || n > 99.99) throw c2Error('Fee percentages must be between 0.01 and 99.99.');
    return n;
}
function c2Fees(treasury) {
    const stored = treasury.Fee_Config;
    if (stored !== undefined && (!stored || typeof stored !== 'object' || Array.isArray(stored))) {
        throw c2Error('Fee configuration requires administrator review.', 503);
    }
    const result = {};
    for (const key of Object.keys(c2FeeDefaults)) result[key] = c2Pct(stored?.[key] === undefined ? c2FeeDefaults[key] : stored[key]);
    const version = treasury.Fee_Config_Version ?? 0;
    if (!Number.isSafeInteger(version) || version < 0) throw c2Error('Invalid fee configuration version.', 503);
    return { ...result, version };
}
function c2Quote(amount, percent) {
    const micro = admS2Micro(amount, 'transaction amount', false);
    const bps = BigInt(Math.round(c2Pct(percent) * 100));
    const feeMicro = (micro * bps + 9999n) / 10000n;
    if (feeMicro >= micro) throw admS2Error('Amount must leave a positive net payout.');
    return { fee: admS2Money(feeMicro), net: admS2Money(micro - feeMicro),
        Fee_Rate_Pct: percent, Fee_micro: feeMicro.toString() };
}
function c2CheckVersion(req, config) {
    if (req.body.feeConfigVersion !== undefined && req.body.feeConfigVersion !== config.version) {
        throw c2Error('Fees changed. Refresh the preview and submit again.', 409);
    }
}
async function c2ReadFees() {
    return db.runTransaction(async t => {
        const ref = db.collection('Admin_Data').doc('TCM_TREASURY');
        const snap = await t.get(ref);
        const row = snap.exists ? snap.data() : {};
        const config = c2Fees(row);
        if (!row.Fee_Config || Object.keys(c2FeeDefaults).some(key => row.Fee_Config[key] === undefined)) {
            const { version, ...fields } = config;
            t.set(ref, { Fee_Config: fields, Fee_Config_Version: version }, { merge: true });
        }
        return config;
    });
}
app.get('/api/finance/fee-config', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { res.json({ success: true, data: await c2ReadFees() }); }
    catch (error) { res.status(503).json({ success: false, message: 'Fee configuration is unavailable.' }); }
});
app.post('/api/admin/fee-config', async (req, res) => {
    try {
        const result = await db.runTransaction(async t => {
            const actor = await admS2ReadAdmin(t, req.authenticatedUid);
            if (actor.Account_Deleted || actor.Status !== 'Active') throw c2Error('Active administrator required.', 403);
            const ref = db.collection('Admin_Data').doc('TCM_TREASURY');
            const snap = await t.get(ref);
            const before = c2Fees(snap.exists ? snap.data() : {});
            if (req.body.expectedVersion !== before.version || before.version >= Number.MAX_SAFE_INTEGER) {
                throw admS2Error('Fee settings changed. Reload before saving.', 409);
            }
            const after = {};
            for (const key of Object.keys(c2FeeDefaults)) after[key] = c2Pct(req.body[key]);
            t.set(ref, { Fee_Config: after, Fee_Config_Version: before.version + 1 }, { merge: true });
            t.set(db.collection('AdminLogs').doc(), { Actor_UID: req.authenticatedUid,
                Action_Type: 'Fee Configuration Updated', Before: before, After: after,
                Date: new Date().toISOString(), timestamp: FieldValue.serverTimestamp() });
            return { ...after, version: before.version + 1 };
        });
        try { io.emit('fee_config_updated', result); } catch (error) {}
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(error.httpStatus || 503).json({ success: false,
            message: error.httpStatus ? error.message : 'Fee update unavailable.' });
    }
});
function c2Address(network, address) {
    if (!hdEthers || !hdTronWeb || !['BEP20', 'TRC20'].includes(network) || typeof address !== 'string') {
        throw admS2Error('Select a supported network and wallet address.');
    }
    try {
        const value = address.trim();
        if (network === 'BEP20') {
            if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error();
            return hdEthers.getAddress(value);
        }
        if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value) || !hdTronWeb.isAddress(value)) throw new Error();
        return hdTronWeb.address.fromHex(hdTronWeb.address.toHex(value));
    } catch (error) { throw admS2Error('Invalid wallet address or checksum.'); }
}
async function c2Destination(t, network, address) {
    const value = c2Address(network, address);
    if (!hdDepositConfig) throw c2Error('Wallet safety configuration is unavailable.', 503);
    const reserved = network === 'BEP20' ? hdDepositConfig.bep.deriveChild(0).address
        : hdTronWeb.address.fromHex('41' + hdDepositConfig.tron.deriveChild(0).address.slice(2));
    const station = d3GasStation(network).address;
    const system = network === 'BEP20'
        ? [hdEthers.ZeroAddress, '0x000000000000000000000000000000000000dEaD', d2BscUsdt, process.env.ADMIN_MASTER_BEP20]
        : ['T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', d2TronUsdt, process.env.ADMIN_MASTER_TRC20];
    const blocked = [reserved, station, ...system.filter(Boolean)].map(item => c2Address(network, item));
    if (blocked.includes(value)) throw admS2Error('Platform, token and burn addresses cannot receive withdrawals.');
    const field = network === 'BEP20' ? 'Deposit_BEP20' : 'Deposit_TRC20';
    const matches = await t.get(db.collection('Users').where(field, '==', value).limit(1));
    if (!matches.empty) throw admS2Error('Platform deposit addresses cannot be bound as withdrawal wallets.');
    return value;
}

let c2MailBusy = false;
async function c2RunMailQueue() {
    if (c2MailBusy || !process.env.EMAIL_USER || !process.env.EMAIL_PASS) return;
    c2MailBusy = true;
    try {
        const queue = await db.collection('Withdrawal_Email_Jobs').where('NextAttemptAt', '<=', Date.now())
            .orderBy('NextAttemptAt').limit(10).get();
        for (const doc of queue.docs) {
            const lease = tcmAuthCrypto.randomUUID();
            const job = await db.runTransaction(async t => {
                const snap = await t.get(doc.ref), row = snap.exists ? snap.data() : null;
                if (!row || !['Pending', 'Retry', 'Sending'].includes(row.State) || row.NextAttemptAt > Date.now()) return null;
                const attempts = (row.Attempts || 0) + 1;
                if (attempts > 5) { t.update(doc.ref, { State: 'Review', NextAttemptAt: FieldValue.delete() }); return null; }
                t.update(doc.ref, { State: 'Sending', Attempts: attempts, Lease: lease, NextAttemptAt: Date.now() + 180000 });
                return { ...row, Attempts: attempts };
            });
            if (!job) continue;
            let state = 'Sent';
            try {
                const user = await db.collection('Users').doc(job.UID).get();
                const profile = user.exists ? user.data() : {};
                if (profile.Account_Deleted || profile.Status === 'Banned' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.Email || '')) {
                    state = 'Suppressed';
                } else {
                    const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
                    const destination = String(job.Destination || '');
                    const details = [
                        ['Order', job.Order_ID], ['Network', job.Network], ['Requested', job.Amount + ' USDT'],
                        ['Fee', job.Fee + ' USDT'], ['Net payout', job.Net_Amount + ' USDT'],
                        ['Destination', destination.slice(0, 6) + '...' + destination.slice(-4)]
                    ];
                    const intro = 'Your withdrawal request has been approved. Approval does not confirm blockchain delivery.';
                    const thanks = 'Thank you for being part of TCM. We appreciate your trust. You can follow the payout status in your dashboard.';
                    await transporter.sendMail({ from: { name: 'TCM Notifications', address: process.env.EMAIL_USER },
                        to: profile.Email, subject: 'Your TCM withdrawal request is approved',
                        messageId: '<tcm-withdrawal-' + doc.id + '@' + process.env.EMAIL_USER.split('@')[1] + '>',
                        text: intro + '\n\n' + details.map(([key, value]) => key + ': ' + value).join('\n') + '\n\n' + thanks,
                        html: '<p>' + escape(intro) + '</p><table>' + details.map(([key, value]) =>
                            '<tr><th align="left">' + escape(key) + '</th><td>' + escape(value) + '</td></tr>').join('') +
                            '</table><p>' + escape(thanks) + '</p>' });
                }
            } catch (error) { state = job.Attempts >= 5 ? 'Review' : 'Retry'; }
            await db.runTransaction(async t => {
                const snap = await t.get(doc.ref);
                if (!snap.exists || snap.data().Lease !== lease) return;
                t.update(doc.ref, { State: state, Lease: FieldValue.delete(),
                    NextAttemptAt: state === 'Retry' ? Date.now() + Math.min(3600000, 60000 * 2 ** job.Attempts) : FieldValue.delete(),
                    Updated_At: FieldValue.serverTimestamp() });
            });
        }
    } catch (error) { console.warn('[WITHDRAWAL EMAIL] Queue deferred; financial records unchanged.'); }
    finally { c2MailBusy = false; }
}
const c2MailTimer = setInterval(() => { void c2RunMailQueue(); }, 60000);
c2MailTimer.unref?.();

const bindWalletEngine = async (req, res) => {
    try {
        const uid = req.authenticatedUid;
        if (!uid || (req.body.uid !== undefined && req.body.uid !== uid)) throw admS2Error('Account ownership mismatch.', 403);
        const network = req.body.network || req.body.net;
        const otp = req.body.otp || req.body.emailOTP;
        const code = req.body.code || req.body.code2FA;
        if (typeof otp !== 'string' || !/^\d{6}$/.test(otp) || !/^\d{6}$/.test(String(code || ''))) {
            throw admS2Error('Valid email OTP and 2FA code are required.');
        }
        const address = await db.runTransaction(async t => {
            const ref = db.collection('Users').doc(uid);
            const snap = await t.get(ref), user = snap.exists ? snap.data() : null;
            if (!user || user.Status !== 'Active' || user.Account_Deleted ||
                user.Token !== String(req.headers.authorization || '').slice(7)) throw admS2Error('Account unavailable.', 403);
            if (!user['2FA_Key'] || !authenticator.verify({ token: String(code), secret: user['2FA_Key'] })) throw admS2Error('Invalid 2FA code.');
            if (user.OTP !== otp) throw admS2Error('Invalid email OTP.');
            const destination = await c2Destination(t, network, req.body.address);
            t.update(ref, { [network === 'BEP20' ? 'Wallet_BEP20' : 'Wallet_TRC20']: destination,
                [network === 'BEP20' ? 'Wallet_BEP20_Display' : 'Wallet_TRC20_Display']: req.body.address.trim(),
                OTP: '', Security_Date: FieldValue.serverTimestamp() });
            return destination;
        });
        await clearUserCache(uid);
        res.json({ success: true, address, displayAddress: req.body.address.trim(),
            message: 'Wallet bound successfully. 72-hour security lock active.' });
    } catch (error) { res.status(error.httpStatus || 503).json({ success: false,
        message: error.httpStatus ? error.message : 'Wallet binding unavailable.' }); }
};
app.post('/api/auth/bind-wallet', bindWalletEngine);
app.post('/api/security/bind-wallet', bindWalletEngine); 

// =========================================================
// 🚀 MODULE 3: FINANCE ENGINE (🔥 NEGATIVE EXPLOIT FIXED & CLEANED)
// =========================================================
app.post('/api/finance/check-security-lock', async (req, res) => {
    try {
        const { uid } = req.body;
        const uSnap = await db.collection("Users").doc(uid).get();
        const uData = uSnap.data();
        
        if (uData.Security_Date) {
            let secDate = uData.Security_Date.toDate();
            let targetTime = secDate.getTime() + (72 * 3600000);
            let remainingTime = targetTime - Date.now();
            if (remainingTime > 0) {
                return res.json({ success: false, isLocked: true, targetTime, remainingTime, message: "Security lock active for 72 hours following security changes." });
            }
        }
        res.json({ success: true, isLocked: false });
    } catch(e) { res.status(400).json({ success: false, message: e.message }); }
});

// Dispatch 04: Wallet counters are authoritative; Redis caches display results only.
const q4QuotaFlights = new Map();

function q4Error(message, status = 503) {
    return Object.assign(new Error(message), { statusCode: status, httpStatus: status });
}

function q4ValidMonth(value) {
    return typeof value === 'string' && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value);
}

function q4Month(now = Date.now()) {
    const local = moment(now).tz('Asia/Kolkata');
    const start = local.clone().startOf('month');
    return { key: start.format('YYYY-MM'), start: start.valueOf(),
        end: start.clone().add(1, 'month').valueOf(), now };
}

function q4StoredQuota(wallet, window) {
    const value = wallet.Monthly_Quota;
    if (value === undefined || value === null) return null;
    if (typeof value !== 'object' || value.version !== 1 || !q4ValidMonth(value.month) ||
        !Number.isSafeInteger(value.withdrawals) || value.withdrawals < 0 ||
        !Number.isSafeInteger(value.p2p) || value.p2p < 0 || value.month > window.key) {
        throw q4Error('Monthly quota state requires reconciliation. No financial action was applied.');
    }
    return value.month === window.key
        ? { ...value }
        : { version: 1, month: window.key, withdrawals: 0, p2p: 0 };
}

async function q4ReadQuota(t, walletRef, wallet, uid, window) {
    const stored = q4StoredQuota(wallet, window);
    if (stored) return stored;
    // Do not silently treat an existing unmarked account as unused.
    // This opt-in requires a reviewed ledger schema; legacy local-format-only dates need reconciliation.
    if (process.env.TCM_QUOTA_BOOTSTRAP_SCHEMA !== 'timestamp-or-iso-v1') {
        throw q4Error('Monthly quota initialization requires a verified ledger baseline. Contact support.');
    }
    const ranges = [
        ['timestamp', m2Timestamp.fromMillis(window.start), m2Timestamp.fromMillis(window.end)],
        ['timestamp', window.start, window.end],
        ['timestamp', new Date(window.start).toISOString(), new Date(window.end).toISOString()],
        ['Date', new Date(window.start).toISOString(), new Date(window.end).toISOString()]
    ];
    const records = new Map();
    let scanned = 0;
    try {
        for (const [field, start, end] of ranges) {
            let cursor = null;
            while (true) {
                let query = db.collection('Transactions').where('UID', '==', uid)
                    .where('Type', 'in', ['Withdraw', 'P2P Sent'])
                    .where(field, '>=', start).where(field, '<', end)
                    .orderBy(field).orderBy(m2FieldPath.documentId()).limit(100);
                if (cursor) query = query.startAfter(cursor);
                const page = await t.get(query);
                scanned += page.docs.length;
                if (scanned > 2000) throw q4Error('Monthly quota baseline exceeds the automatic review bound. Contact support.');
                for (const doc of page.docs) {
                    const row = doc.data();
                    if (row.UID !== uid || !['Withdraw', 'P2P Sent'].includes(row.Type)) {
                        throw q4Error('Monthly quota ledger scope mismatch.');
                    }
                    records.set(doc.id, row);
                }
                if (page.docs.length < 100) break;
                cursor = page.docs[page.docs.length - 1];
            }
        }
    } catch (error) {
        if (e4MissingIndex(error)) {
            console.warn('[Q4 QUOTA] Initialization index unavailable:', error.message);
            throw q4Error('Monthly quota security indexes are building. Please try again later. Your balance is untouched.');
        }
        throw error;
    }
    const result = { version: 1, month: window.key, withdrawals: 0, p2p: 0 };
    for (const row of records.values()) {
        if (['Rejected', 'Cancelled', 'Refunded'].includes(row.Status)) continue;
        const time = parseSafeTimestamp(row.timestamp || row.Date);
        if (!Number.isFinite(time) || time <= 0) throw q4Error('Ledger time requires reconciliation.');
        const month = row.Quota_Month === undefined ? q4Month(time).key : row.Quota_Month;
        if (!q4ValidMonth(month)) throw q4Error('Invalid ledger quota month.');
        if (month !== window.key) continue;
        if (row.Type === 'Withdraw') result.withdrawals++;
        else result.p2p++;
    }
    return result;
}

function q4TakeSlot(quota, kind) {
    const field = kind === 'withdraw' ? 'withdrawals' : 'p2p';
    const limit = kind === 'withdraw' ? 5 : 15;
    if (quota[field] >= limit) {
        throw q4Error(kind === 'withdraw' ? 'Monthly withdrawal limit (5) reached!' :
            'Monthly P2P transfer limit (15) reached!', 400);
    }
    return { ...quota, [field]: quota[field] + 1 };
}

async function q4WithdrawalAdjustment(t, ref, wallet, uid, withdrawal, action, window) {
    if (!['reject', 'cancel', 'reverse'].includes(action)) return { wallet: {}, ledger: {} };
    const time = parseSafeTimestamp(withdrawal.timestamp || withdrawal.Date);
    if (withdrawal.Quota_Month === undefined && (!Number.isFinite(time) || time <= 0)) {
        throw q4Error('Withdrawal quota month cannot be verified.');
    }
    const month = withdrawal.Quota_Month ?? q4Month(time).key;
    if (!q4ValidMonth(month) || month > window.key) throw q4Error('Invalid withdrawal quota month.');
    const expected = action === 'reverse' ? 'Released' : 'Counted';
    if (withdrawal.Quota_Count_State !== undefined && withdrawal.Quota_Count_State !== expected) {
        throw q4Error('Withdrawal quota transition requires reconciliation.');
    }
    const ledger = { Quota_Month: month, Quota_Count_State: action === 'reverse' ? 'Counted' : 'Released' };
    if (month !== window.key) return { wallet: {}, ledger };
    let quota = await q4ReadQuota(t, ref, wallet, uid, window);
    if (action === 'reverse') quota = q4TakeSlot(quota, 'withdraw');
    else {
        if (quota.withdrawals <= 0) throw q4Error('Withdrawal quota count is inconsistent. Contact support.');
        quota = { ...quota, withdrawals: quota.withdrawals - 1 };
    }
    return { wallet: { Monthly_Quota: quota }, ledger };
}

app.get('/api/finance/monthly-quota', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const uid = req.authenticatedUid;
    const actor = req.authenticatedUserDoc;
    if (typeof uid !== 'string' || !uid || uid.includes('/') || !actor?.exists || actor.id !== uid) {
        return res.status(401).json({ success: false, message: 'Authentication required.' });
    }
    if (req.query.uid !== undefined && req.query.uid !== uid) {
        return res.status(403).json({ success: false, message: 'Account ownership mismatch.' });
    }
    if (actor.data().Status === 'Banned') {
        return res.status(403).json({ success: false, code: 'ACCOUNT_BLOCKED', message: 'Account access is blocked.' });
    }
    try {
        const window = q4Month();
        const cacheKey = `monthly_quota_${uid}`;
        const cached = await getCache(cacheKey);
        const revision = actor.data().counters?.txCount;
        if (cached && cached.uid === uid && cached.month === window.key && cached.revision === revision &&
            Number.isSafeInteger(cached.wdCount) && cached.wdCount >= 0 &&
            Number.isSafeInteger(cached.p2pCount) && cached.p2pCount >= 0) {
            return res.json({ success: true, wdCount: cached.wdCount, p2pCount: cached.p2pCount, month: window.key, source: 'redis' });
        }
        const flightKey = uid + ':' + window.key;
        let flight = q4QuotaFlights.get(flightKey);
        if (!flight) {
            if (q4QuotaFlights.size >= 200) throw q4Error('Quota reader busy. Try again shortly.');
            const ref = db.collection('Wallets').doc(uid);
            flight = db.runTransaction(async t => {
                const wallet = await t.get(ref);
                if (!wallet.exists) throw q4Error('Wallet unavailable.');
                // Recompute the calendar boundary on each transaction attempt.
                const currentWindow = q4Month();
                const value = await q4ReadQuota(t, ref, wallet.data(), uid, currentWindow);
                if (wallet.data().Monthly_Quota === undefined || wallet.data().Monthly_Quota === null ||
                    wallet.data().Monthly_Quota.month !== currentWindow.key) {
                    t.update(ref, { Monthly_Quota: value });
                }
                return value;
            }).finally(() => q4QuotaFlights.delete(flightKey));
            q4QuotaFlights.set(flightKey, flight);
        }
        const value = await flight;
        if (value.month !== q4Month().key) throw q4Error('Month changed during refresh. Please refresh again.');
        try {
            await setCache(cacheKey, { uid, month: value.month, wdCount: value.withdrawals,
                p2pCount: value.p2p, revision }, 60);
        } catch (cacheError) {
            console.warn('[Q4 QUOTA] Cache unavailable; returning verified wallet counters.');
        }
        return res.json({ success: true, wdCount: value.withdrawals, p2pCount: value.p2p, month: value.month, source: 'wallet' });
    } catch (error) {
        return res.status(error.statusCode || 503).json({ success: false, message: error.message });
    }
});

app.get('/api/finance/transactions/more', async (req, res) => {
    try {
        // MEMO: TCM-DASH-READER-R1 | 2026-10-10 | Asia/Kolkata
        // The existing global /api middleware verifies the Bearer token.
        const uid = req.authenticatedUid;
        if (typeof uid !== "string" || !uid.trim() || uid.includes("/")) {
            return res.status(401).json({ success: false, message: "Authenticated account is required." });
        }
        if (req.query.uid !== undefined && req.query.uid !== uid) {
            return res.status(403).json({ success: false, message: "Account ownership mismatch." });
        }

        const { lastTimestamp, lastId } = req.query;
        if (!lastId && !lastTimestamp) throw new Error('Missing history cursor.');
        const parsedTime = lastTimestamp === undefined ? null : Number(lastTimestamp);
        if (!lastId && (!Number.isSafeInteger(parsedTime) || parsedTime < 0)) throw new Error('Invalid history timestamp.');

        // Reuse the snapshot verified by the global middleware for this request.
        const userDoc = req.authenticatedUserDoc;
        if (!userDoc || !userDoc.exists || userDoc.id !== uid) {
            return res.status(401).json({ success: false, message: "Authenticated account no longer exists." });
        }
        if (userDoc.data().Status === "Banned") {
            return res.status(403).json({ success: false, message: "Account access is blocked." });
        }

        const page = await dashboardHistoryReader.page(uid, { afterId: lastId || '', beforeMs: lastId ? null : parsedTime });
        const txs = page.records;
        return res.json({ success: true, data: await teamBonusIdentity.enrich(db, txs, uid), hasMore: page.hasMore, nextCursor: page.nextCursor });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
});
// MEMO TCM-ADM-014-S1 | 2026-10-10 02:20 IST | Asia/Kolkata
// MEMO TCM-ADM-014-S2-A | 2026-10-10 02:30 IST | Asia/Kolkata
// MEMO TCM-ADM-014-S2-B | 2026-10-10 02:40 IST | Asia/Kolkata
// Existing decimal wallet fields remain the public storage format.
// New fields: Wallets.Admin_Locked_Balance, AdminOperations/{requestId}.
const admS2Scale = 1000000n;
const admS2MaxItems = 500;

function admS2Error(message, status = 400) {
    const error = new Error(message);
    error.httpStatus = status;
    return error;
}
function admS2Micro(value, label, allowZero = true) {
    if (typeof value !== 'string' && typeof value !== 'number') {
        throw admS2Error('Invalid ' + label);
    }
    const text = String(value).trim();
    if (!/^\d+(?:\.\d{1,6})?$/.test(text)) {
        throw admS2Error(label + ' must have at most six decimal places.');
    }
    const [whole, fraction = ''] = text.split('.');
    const result = BigInt(whole) * admS2Scale + BigInt(fraction.padEnd(6, '0'));
    if ((!allowZero && result === 0n) || result > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw admS2Error('Out-of-range ' + label);
    }
    return result;
}
function admS2Money(value) {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw admS2Error('Wallet amount exceeds supported precision.');
    }
    const result = Number(value) / 1000000;
    if (admS2Micro(result, 'wallet projection') !== value) {
        throw admS2Error('Wallet amount cannot be represented without losing a micro-unit.');
    }
    return result;
}
// MONEY-V1: Shared legacy balance reader. No storage migration is enabled here.
function moneyV1Text(micro) {
    if (typeof micro !== 'bigint' || micro < 0n || micro > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw admS2Error('Money value exceeds supported precision.');
    }
    return (micro / admS2Scale).toString() + '.' +
        (micro % admS2Scale).toString().padStart(6, '0');
}

function moneyV1ReadLegacy(raw, label) {
    const numeric = typeof raw === 'number';
    if ((!numeric && typeof raw !== 'string') ||
        (numeric && (!Number.isFinite(raw) || raw < 0))) {
        throw admS2Error('Invalid ' + label);
    }
    const text = String(raw).trim();
    if (!text || text.length > 80) throw admS2Error('Invalid ' + label);
    const match = numeric
        ? /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text)
        : /^(\d+)(?:\.(\d+))?$/.exec(text);
    if (!match) throw admS2Error('Invalid ' + label);

    const fraction = match[2] || '';
    const exponent = numeric ? Number(match[3] || 0) : 0;
    const coefficient = BigInt(match[1] + fraction);
    const places = fraction.length - exponent;
    let micro, residual = 0n, divisor = 1n;
    if (places <= 6) {
        micro = coefficient * (10n ** BigInt(6 - places));
    } else {
        divisor = 10n ** BigInt(places - 6);
        micro = coefficient / divisor;
        const remainder = coefficient % divisor;
        if (remainder * 2n >= divisor) micro += 1n;
        const difference = coefficient - micro * divisor;
        residual = difference < 0n ? -difference : difference;
    }
    if (micro > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw admS2Error('Out-of-range ' + label);
    }
    if (residual !== 0n) {
        const tolerance = Math.min(
            0.0000001,
            8 * Number.EPSILON * Math.max(1, Math.abs(Number(text)))
        );
        const difference = Number(residual) / Number(divisor) / 1000000;
        if (!Number.isFinite(difference) || difference > tolerance) {
            throw admS2Error(label + ' requires precision reconciliation.');
        }
    }
    return {
        micro,
        exactZero: coefficient === 0n,
        amount: moneyV1Text(micro),
        adjusted: residual !== 0n
    };
}

// MONEY-V7: Existing documents stay legacy until an approved migration converts them.
const moneyV7Fields = Object.freeze({
    Wallet: Object.freeze([
        'Main_Balance', 'Locked_Balance', 'Admin_Locked_Balance', 'Debt',
        'Lifetime_Stake', 'Total_Deposit', 'Total_Withdraw', 'Total_Withdrawal',
        'Total_Earn', 'Daily_Earn', 'Total_Team', 'Daily_Team',
        'Total_Stake', 'Daily_Stake', 'Total_Reserve', 'Daily_Reserve',
        'Total_Airdrop', 'Daily_Airdrop', 'Total_Comp', 'Daily_Comp',
        'Total_Dividend', 'Daily_Dividend', 'Total_Team_Deposit'
    ]),
    Treasury: Object.freeze([
        'Withdrawal_Fee_Wallet', 'Withdrawal_Pending_Fees', 'P2P_Fee_Wallet',
        'Dividend_Pool_Wallet', 'Total_Revenue', 'Total_Breakage_Profit', 'Missed_Bonus_Pool'
    ])
});

function moneyV7Canonical(data, scope) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw admS2Error('Money document is unavailable.', 409);
    if (data.Money_Version === undefined && data.Money_micro === undefined && data.Money_Scope === undefined) return false;
    const fields = moneyV7Fields[scope];
    const stored = data.Money_micro;
    if (!fields || data.Money_Version !== 1 || data.Money_Scope !== scope ||
        !stored || typeof stored !== 'object' || Array.isArray(stored) ||
        Object.keys(stored).length !== fields.length) {
        throw admS2Error('Canonical money schema requires reconciliation.', 409);
    }
    for (const field of fields) {
        const raw = stored[field];
        if (typeof raw !== 'string' || !/^(?:0|[1-9]\d{0,15})$/.test(raw)) {
            throw admS2Error('Invalid canonical money field: ' + field, 409);
        }
        const expected = admS2Money(BigInt(raw));
        const actual = data[field] === undefined ? 0 : data[field];
        if (typeof actual !== 'number' || actual !== expected) {
            throw admS2Error('Money projection mismatch: ' + field, 409);
        }
    }
    if (scope === 'Wallet' && stored.Total_Withdraw !== stored.Total_Withdrawal) {
        throw admS2Error('Withdrawal total aliases require reconciliation.', 409);
    }
    return true;
}

function moneyV7View(data, scope = 'Wallet') {
    moneyV7Canonical(data, scope);
    return data;
}

function moneyV7Updates(data, updates, scope = 'Wallet', mode = 'update') {
    const canonical = moneyV7Canonical(data, scope);
    if (!canonical) return updates;
    if (!['update', 'merge', 'view'].includes(mode) || !updates || typeof updates !== 'object' || Array.isArray(updates)) {
        throw admS2Error('Invalid canonical money update.', 409);
    }
    const out = { ...updates }, changed = {};
    for (const key of Object.keys(out)) {
        if (key === 'Money_micro' || key.startsWith('Money_micro.') || key === 'Money_Version' || key === 'Money_Scope') {
            throw admS2Error('Canonical metadata cannot be overwritten by a financial update.', 409);
        }
        if (moneyV7Fields[scope].some(field => key.startsWith(field + '.'))) {
            throw admS2Error('Money fields must be scalar amounts.', 409);
        }
    }
    if (scope === 'Wallet') {
        const first = Object.prototype.hasOwnProperty.call(out, 'Total_Withdraw');
        const second = Object.prototype.hasOwnProperty.call(out, 'Total_Withdrawal');
        if (first || second) {
            const a = admS2Micro(first ? out.Total_Withdraw : out.Total_Withdrawal, 'withdrawal total');
            const b = admS2Micro(second ? out.Total_Withdrawal : out.Total_Withdraw, 'withdrawal alias');
            if (a !== b) throw admS2Error('Conflicting withdrawal total updates.', 409);
            out.Total_Withdraw = out.Total_Withdrawal = admS2Money(a);
        }
    }
    for (const field of moneyV7Fields[scope]) {
        if (!Object.prototype.hasOwnProperty.call(out, field)) continue;
        const micro = admS2Micro(out[field], field);
        out[field] = admS2Money(micro);
        changed[field] = micro.toString();
    }
    if (mode === 'view') {
        out.Money_Version = 1;
        out.Money_Scope = scope;
        out.Money_micro = { ...data.Money_micro, ...changed };
    } else if (Object.keys(changed).length) {
        if (mode === 'merge') out.Money_micro = changed;
        else for (const [field, value] of Object.entries(changed)) out['Money_micro.' + field] = value;
    }
    return out;
}

function moneyV7NextView(data, updates, scope = 'Wallet') {
    return { ...data, ...moneyV7Updates(data, updates, scope, 'view') };
}

function moneyV7NewWallet(data) {
    const out = { ...data }, stored = {};
    for (const field of moneyV7Fields.Wallet) {
        if (data[field] !== undefined && admS2Micro(data[field], field) !== 0n) {
            throw admS2Error('New canonical wallets must start with zero financial balances.');
        }
        out[field] = 0;
        stored[field] = '0';
    }
    out.Money_Version = 1;
    out.Money_Scope = 'Wallet';
    out.Money_micro = stored;
    return out;
}

function moneyV7Amount(record, field, microField, label) {
    if (!record || record[microField] === undefined) return moneyV1ReadLegacy(record?.[field], label).micro;
    const raw = record[microField];
    if (typeof raw !== 'string' || !/^(?:0|[1-9]\d{0,15})$/.test(raw)) throw admS2Error('Invalid stored ' + label, 409);
    const micro = BigInt(raw);
    if (typeof record[field] !== 'number' || record[field] !== admS2Money(micro)) {
        throw admS2Error('Stored amount projection mismatch: ' + label, 409);
    }
    return micro;
}

function admS2Balance(wallet, field) {
    if (wallet && wallet.Money_Scope !== undefined) {
        const scope = wallet.Money_Scope;
        if (moneyV7Canonical(wallet, scope)) {
            if (!moneyV7Fields[scope].includes(field)) throw admS2Error('Unknown canonical money field: ' + field, 409);
            return BigInt(wallet.Money_micro[field]);
        }
    } else if (wallet && (wallet.Money_Version !== undefined || wallet.Money_micro !== undefined)) {
        throw admS2Error('Canonical money scope is missing.', 409);
    }
    const raw = wallet[field] === undefined ? 0 : wallet[field];
    return moneyV1ReadLegacy(raw, field).micro;
}
// T9: Display-only metadata from audits already staged in this transaction.
// WeakMap entries disappear with the transaction attempt; no extra database reads.
const t9AttemptAudits = new WeakMap();
function t9RememberAudit(transaction, id, row) {
    const entries = t9AttemptAudits.get(transaction) || [];
    entries.push({ ...row, id });
    t9AttemptAudits.set(transaction, entries);
}
function t9AuditType(type) {
    const types = {
        'Deposit': 'Deposit credit after debt settlement',
        'Withdraw': 'Withdrawal held',
        'P2P Sent': 'P2P transfer sent', 'P2P Received': 'P2P transfer received',
        'NFT Reserve': 'NFT reservation', 'NFT Sold': 'NFT sale: principal plus net profit',
        'NFT Profit': 'NFT sale: principal plus net profit', 'Staking Lock': 'Staking principal locked',
        'Staking Reward': 'Staking ROI', 'Team Reservation Bonus': 'Team reservation bonus',
        'Company Profit Share': 'Company dividend', 'Airdrop': 'Airdrop',
        'Airdrop Reversal': 'Airdrop Reversal', 'Admin Vault Lock': 'Admin Vault Lock',
        'Admin Vault Unlock': 'Admin Vault Unlock'
    };
    if (/^Team Bonus \([ABC]-Hand\)$/.test(type)) return 'NFT team commission';
    if (/^Withdrawal (?:approve|reject|vault|reverse|cancel)$/.test(type)) return type;
    return Object.prototype.hasOwnProperty.call(types, type) ? types[type] : null;
}
function t9AuditSnapshot(row, type, source) {
    const result = {
        Balance_Old: row.Balance_Old, Balance_New: row.Balance_New,
        Balance_Snapshot_Version: row.Audit_Version, Main_Ledger_Entry_ID: row.id,
        Balance_Source: source,
        Balance_Scope: /^Team Bonus \([ABC]-Hand\)$/.test(type) ? 'Combined_NFT_Commission' : 'Main_Balance'
    };
    if (row.Audit_Version === 2) {
        for (const field of ['Balance_Old_micro', 'Balance_New_micro', 'Balance_Delta_micro']) result[field] = row[field];
    }
    return result;
}
function t9UnchangedSnapshot(wallet) {
    const micro = admS2Balance(wallet, 'Main_Balance');
    const amount = admS2Money(micro);
    return { Balance_Old: amount, Balance_New: amount,
        Balance_Old_micro: micro.toString(), Balance_New_micro: micro.toString(), Balance_Delta_micro: '0',
        Balance_Snapshot_Version: 2, Main_Ledger_Entry_ID: null,
        Balance_Source: 'Committed_Record', Balance_Scope: 'No_Main_Balance_Movement' };
}
function t9Record(transaction, record, uid = record.UID, type = record.Type, unchangedWallet = null) {
    const expected = t9AuditType(type);
    const entries = (t9AttemptAudits.get(transaction) || []).filter(row => row.UID === uid && row.Type === expected);
    if (entries.length === 1) return { ...record, ...t9AuditSnapshot(entries[0], type, 'Committed_Record') };
    if (unchangedWallet && entries.length === 0) return { ...record, ...t9UnchangedSnapshot(unchangedWallet) };
    // Debt components and treasury fees do not represent another Main Balance credit.
    return { ...record, Balance_Source: 'Unavailable' };
}

function admS2Level(user) {
    const raw = user.Rank === undefined || user.Rank === 0 || user.Rank === '0' ? 1 : user.Rank;
    if (!['number', 'string'].includes(typeof raw) || !/^\d+$/.test(String(raw))) throw admS2Error('Invalid membership rank.');
    const level = Number(raw);
    if (!Number.isInteger(level) || level < 1 || level > 6) throw admS2Error('Invalid membership rank.');
    return level;
}
function admS2Uid(uid) {
    if (typeof uid !== 'string' || !uid.trim() || uid !== uid.trim() || uid.includes('/')) {
        throw admS2Error('Invalid UID.');
    }
    return uid;
}
async function admS2ReadAdmin(t, uid) {
    const snap = await t.get(db.collection('Users').doc(uid));
    if (!snap.exists || snap.data().Role !== 'Admin' || snap.data().Status === 'Banned') {
        throw admS2Error('Active administrator privileges required.', 403);
    }
    return snap.data();
}
function admS2Audit(actor, uid, details) {
    return {
        Admin_Name: actor.Name || uid, Actor_UID: uid,
        Date: new Date().toISOString(), timestamp: FieldValue.serverTimestamp(),
        ...details
    };
}
function admS2Spec(body, family) {
    const allowed = family === 'airdrop'
        ? ['single', 'pool', 'reverse-level']
        : ['lock', 'unlock', 'mass-lock', 'mass-unlock'];
    if (!allowed.includes(body.action)) throw admS2Error('Invalid administrative action.');
    const spec = { family, action: body.action };
    if (['single', 'lock', 'unlock'].includes(body.action)) {
        spec.uid = admS2Uid(body.uid);
        spec.amountMicro = admS2Micro(body.amount, 'amount', false).toString();
    }
    if (['pool', 'mass-lock'].includes(body.action)) {
        spec.poolMicro = admS2Micro(body.pool, 'pool', false).toString();
        spec.percentages = {};
        let total = 0n;
        for (let level = 1; level <= 6; level++) {
            const pct = admS2Micro(body.percentages?.[level], 'level percentage');
            if (pct > 100n * admS2Scale) throw admS2Error('Percentage exceeds 100.');
            spec.percentages[level] = pct.toString();
            total += pct;
        }
        if (total === 0n || (body.action === 'pool' && total > 100n * admS2Scale)) {
            throw admS2Error('Airdrop percentage total must be positive and at most 100.');
        }
    }
    if (['reverse-level', 'mass-unlock'].includes(body.action)) {
        if (!['number', 'string'].includes(typeof body.level) || !/^\d+$/.test(String(body.level))) throw admS2Error('Invalid level.');
        const level = Number(body.level);
        if (!Number.isInteger(level) || level < 1 || level > 6) throw admS2Error('Invalid level.');
        spec.level = level;
    }
    return spec;
}
async function admS2Scan(query, visit) {
    let cursor;
    while (true) {
        const page = await (cursor ? query.startAfter(cursor) : query).limit(200).get();
        for (const doc of page.docs) visit(doc);
        if (page.size < 200) break;
        cursor = page.docs[page.docs.length - 1];
    }
}
function admS2Append(items, item) {
    if (items.length >= admS2MaxItems) {
        throw admS2Error('Operation exceeds 500 items. No operation was created; split the scope before retrying.');
    }
    items.push(item);
}
async function admS2Plan(spec) {
    if (['single', 'lock', 'unlock'].includes(spec.action)) {
        return [{ uid: spec.uid, amountMicro: spec.amountMicro, orderId: generateOrderId(spec.family === 'airdrop' ? 'AIR' : 'VAULT') }];
    }
    const users = new Map();
    await admS2Scan(db.collection('Users').orderBy('__name__'), doc => {
        const user = doc.data();
        if (spec.action === 'pool' && user.Status !== 'Active') return;
        const level = admS2Level(user);
        if (spec.level && level !== spec.level) return;
        if (spec.percentages && BigInt(spec.percentages[level]) === 0n) return;
        if (users.size >= admS2MaxItems) throw admS2Error('Operation exceeds 500 eligible users. No operation was created.');
        users.set(doc.id, { level });
    });
    const items = [];
    if (spec.action === 'reverse-level') {
        await admS2Scan(db.collection('Transactions').where('Type', '==', 'Airdrop').orderBy('__name__'), doc => {
            const tx = doc.data();
            if (tx.Status === 'Success' && users.has(tx.UID)) {
                admS2Append(items, { uid: tx.UID, txId: doc.id, level: spec.level });
            }
        });
    } else if (spec.action === 'pool') {
        const pool = BigInt(spec.poolMicro);
        for (let level = 1; level <= 6; level++) {
            const members = [...users.keys()].filter(uid => users.get(uid).level === level).sort();
            if (!members.length) continue;
            const allocation = pool * BigInt(spec.percentages[level]) / (100n * admS2Scale);
            const perUser = allocation / BigInt(members.length);
            const remainder = allocation % BigInt(members.length);
            members.forEach((uid, index) => {
                const amount = perUser + (BigInt(index) < remainder ? 1n : 0n);
                if (amount > 0n) admS2Append(items, { uid, level, amountMicro: amount.toString(), orderId: generateOrderId('AIR') });
            });
        }
    } else {
        for (const [uid, user] of users) {
            const item = { uid, level: user.level, orderId: generateOrderId('VAULT') };
            if (spec.action === 'mass-lock') {
                // Preserve the existing per-member vault lock target policy.
                item.amountMicro = (BigInt(spec.poolMicro) * BigInt(spec.percentages[user.level]) / (100n * admS2Scale)).toString();
                if (item.amountMicro === '0') continue;
            }
            admS2Append(items, item);
        }
    }
    return items;
}
function admS2AirdropDay(tx) {
    if (typeof tx.Earned_Day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(tx.Earned_Day)) return tx.Earned_Day;
    let date;
    if (tx.timestamp && typeof tx.timestamp.toDate === 'function') date = tx.timestamp.toDate();
    else if (typeof tx.Date === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(tx.Date)) date = new Date(tx.Date);
    if (!date || !Number.isFinite(date.getTime())) throw admS2Error('Airdrop date cannot be verified.');
    return moment(date).tz('Asia/Kolkata').format('YYYY-MM-DD');
}
function admS2Daily(scope, ref, wallet, today) {
    try { return buildISTDailyIncomeUpdates(scope, ref, wallet, {}, today); }
    catch (error) { throw admS2Error(error.message); }
}
async function admS2Process(jobRef, actorUid, index) {
    let result;
    try {
    result = await db.runTransaction(async t => {
        const actor = await admS2ReadAdmin(t, actorUid);
        const jobSnap = await t.get(jobRef);
        const job = jobSnap.data();
        if (!job || job.actorUid !== actorUid) throw admS2Error('Operation ownership mismatch.', 403);
        if (index !== job.cursor) return { uid: null };
        const item = job.items[index];
        if (!item) return { uid: null };
        const receiptRef = jobRef.collection('items').doc(String(index));
        const receipt = await t.get(receiptRef);
        if (receipt.exists) throw admS2Error('Operation receipt/cursor mismatch.', 409);
        const userRef = db.collection('Users').doc(item.uid);
        const walletRef = db.collection('Wallets').doc(item.uid);
        const userSnap = await t.get(userRef);
        const walletSnap = await t.get(walletRef);
        const reverse = job.spec.action === 'reverse-level';
        const originalRef = reverse ? db.collection('Transactions').doc(item.txId) : null;
        const originalSnap = reverse ? await t.get(originalRef) : null;
        let outcome = 'Applied';
        let reason = '';
        let amount = 0n, recovered = 0n, unrecovered = 0n;
        const updates = {};
        // Fresh scope prevents calculator cache reuse across transaction retries.
        const dailyScope = {};
        const today = moment().tz('Asia/Kolkata').format('YYYY-MM-DD');
        const wallet = walletSnap.exists ? walletSnap.data() : {};
        const user = userSnap.exists ? userSnap.data() : {};
        let txCount;
        let originalUpdates;
        let ledger;
        try {
            if (!userSnap.exists || !walletSnap.exists) throw admS2Error('User or wallet missing.');
            l4AssertMutable(user);
            if (item.level && admS2Level(user) !== item.level) throw admS2Error('Membership level changed.');
            if (job.spec.action === 'pool' && user.Status !== 'Active') throw admS2Error('User is no longer Active.');
            const main = admS2Balance(wallet, 'Main_Balance');
            if (job.spec.family === 'airdrop') {
                if (reverse) {
                    if (!originalSnap.exists) throw admS2Error('Original airdrop missing.');
                    const original = originalSnap.data();
                    if (original.Type !== 'Airdrop' || original.UID !== item.uid || original.Status !== 'Success') {
                        throw admS2Error('Airdrop is no longer eligible for reversal.');
                    }
                    amount = admS2Micro(original.Amount, 'airdrop amount', false);
                    const earnedDay = admS2AirdropDay(original);
                    if (earnedDay > today) throw admS2Error('Airdrop date is in the future.');
                    const totalAir = admS2Balance(wallet, 'Total_Airdrop');
                    const totalComp = admS2Balance(wallet, 'Total_Comp');
                    if (totalAir < amount || totalComp < amount) throw admS2Error('Lifetime income counters require reconciliation.');
                    recovered = main < amount ? main : amount;
                    unrecovered = amount - recovered;
                    Object.assign(updates, admS2Daily(dailyScope, walletRef, wallet, today));
                    if (earnedDay === today) {
                        for (const field of ['Daily_Airdrop', 'Daily_Comp']) {
                            const daily = admS2Balance(updates, field);
                            if (daily < amount) throw admS2Error('Daily income counters require reconciliation.');
                            updates[field] = admS2Money(daily - amount);
                        }
                    }
                    Object.assign(updates, {
                        Main_Balance: admS2Money(main - recovered),
                        Debt: admS2Money(admS2Balance(wallet, 'Debt') + unrecovered),
                        Total_Airdrop: admS2Money(totalAir - amount),
                        Total_Comp: admS2Money(totalComp - amount)
                    });
                    originalUpdates = {
                        Status: 'Reversed', status: 'Reversed', Reversed_By: actorUid,
                        Reversed_At: FieldValue.serverTimestamp(),
                        Recovered_Amount: admS2Money(recovered), Unrecovered_Amount: admS2Money(unrecovered)
                    };
                    ledger = { Type: 'Airdrop Reversal', Original_Transaction_ID: item.txId, Recovered_Amount: admS2Money(recovered), Debt_Added: admS2Money(unrecovered) };
                } else {
                    amount = BigInt(item.amountMicro);
                    Object.assign(updates, admS2Daily(dailyScope, walletRef, wallet, today));
                    updates.Main_Balance = admS2Money(main + amount);
                    for (const field of ['Total_Airdrop', 'Total_Comp']) updates[field] = admS2Money(admS2Balance(wallet, field) + amount);
                    for (const field of ['Daily_Airdrop', 'Daily_Comp']) updates[field] = admS2Money(admS2Balance(updates, field) + amount);
                    ledger = { Type: 'Airdrop', Earned_Day: today, Earned_Level: admS2Level(user) };
                }
            } else {
                const locked = admS2Balance(wallet, 'Locked_Balance');
                const adminLocked = admS2Balance(wallet, 'Admin_Locked_Balance');
                if (adminLocked > locked) throw admS2Error('Admin locked balance exceeds total locked balance.');
                const unlock = ['unlock', 'mass-unlock'].includes(job.spec.action);
                amount = job.spec.action === 'mass-unlock' ? adminLocked : BigInt(item.amountMicro);
                if (amount === 0n) throw admS2Error('No tracked admin-locked funds.');
                if (unlock && adminLocked < amount) throw admS2Error('Insufficient tracked admin-locked funds.');
                if (!unlock && main < amount) throw admS2Error('Insufficient Main_Balance; no debt created.');
                Object.assign(updates, {
                    Main_Balance: admS2Money(unlock ? main + amount : main - amount),
                    Locked_Balance: admS2Money(unlock ? locked - amount : locked + amount),
                    Admin_Locked_Balance: admS2Money(unlock ? adminLocked - amount : adminLocked + amount)
                });
                ledger = { Type: unlock ? 'Admin Vault Unlock' : 'Admin Vault Lock' };
            }
            try { txCount = nextStakingTxCount(user); }
            catch (error) { throw admS2Error(error.message); }
        } catch (error) {
            if (error.httpStatus !== 400) throw error;
            outcome = 'Skipped';
            reason = error.message;
            recovered = 0n;
            unrecovered = 0n;
        }
        const amountValue = admS2Money(amount);
        if (outcome === 'Applied') {
            t.update(walletRef, moneyV7Updates(wallet, { ...updates, ...t8MainEntry(t, item.uid, wallet, updates.Main_Balance, ledger.Type, jobRef.id) }, 'Wallet', 'update'));
            t.update(userRef, { 'counters.txCount': txCount });
            if (originalUpdates) t.update(originalRef, originalUpdates);
            t.create(db.collection('Transactions').doc('ADM-S2-' + jobRef.id + '-' + index), t9Record(t, {
                ...ledger, UID: item.uid, Amount: amountValue,
                Status: 'Success', status: 'Success', Order_ID: item.orderId || 'AIR-REV-' + jobRef.id + '-' + index,
                Operation_ID: jobRef.id, Amount_micro: amount.toString(), Balance_Old: admS2Money(admS2Balance(wallet, 'Main_Balance')),
                Balance_New: updates.Main_Balance, Date: new Date().toISOString(),
                timestamp: FieldValue.serverTimestamp()
            }));
        }
        const details = {
            Target_UID: item.uid, Action_Type: job.spec.family + ':' + job.spec.action,
            Operation_ID: jobRef.id, Outcome: outcome, Amount: amountValue,
            Recovered_Amount: admS2Money(recovered), Unrecovered_Amount: admS2Money(unrecovered),
            Original_Transaction_ID: item.txId || '', Details: reason || 'Administrative transaction committed'
        };
        t.create(receiptRef, details);
        t.create(db.collection('AdminLogs').doc('ADM-S2-' + jobRef.id + '-' + index), admS2Audit(actor, actorUid, details));
        t.update(jobRef, {
            cursor: index + 1,
            applied: job.applied + (outcome === 'Applied' ? 1 : 0),
            skipped: job.skipped + (outcome === 'Skipped' ? 1 : 0),
            appliedMicro: (BigInt(job.appliedMicro) + (outcome === 'Applied' ? amount : 0n)).toString(),
            updatedAt: FieldValue.serverTimestamp()
        });
        return { uid: outcome === 'Applied' ? item.uid : null };
    });
    } catch (error) {
        // A commit acknowledgement can fail after the server has committed.
        try {
            const receipt = await jobRef.collection('items').doc(String(index)).get();
            if (receipt.exists && receipt.data().Outcome === 'Applied') {
                await clearUserCache(receipt.data().Target_UID);
            }
        } catch (recoveryError) {
            console.error('Admin commit/cache reconciliation unavailable:', recoveryError);
        }
        throw error;
    }
    if (result.uid) {
        try { await clearUserCache(result.uid); }
        catch (error) { console.error('Admin operation cache invalidation failed:', error); }
    }
}
async function admS2Handle(req, res, family) {
    let operationRef;
    try {
        const actorUid = req.authenticatedUid;
        if (!actorUid) throw admS2Error('Authentication required.', 401);
        const body = req.body || {};
        if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(body.requestId)) throw admS2Error('Valid requestId required.');
        operationRef = db.collection('AdminOperations').doc(body.requestId);
        const spec = admS2Spec(body, family);
        const fingerprint = require('crypto').createHash('sha256').update(JSON.stringify(spec)).digest('hex');
        const jobRef = operationRef;
        const initial = await db.runTransaction(async t => {
            await admS2ReadAdmin(t, actorUid);
            return t.get(jobRef);
        });
        if (!initial.exists) {
            const items = await admS2Plan(spec);
            if (Buffer.byteLength(JSON.stringify(items), 'utf8') > 750000) {
                throw admS2Error('Operation plan is too large; no operation was created.');
            }
            await db.runTransaction(async t => {
                const actor = await admS2ReadAdmin(t, actorUid);
                const existing = await t.get(jobRef);
                if (existing.exists) {
                    if (existing.data().actorUid !== actorUid || existing.data().fingerprint !== fingerprint) throw admS2Error('requestId already belongs to another operation.', 409);
                    return;
                }
                t.create(jobRef, {
                    actorUid, spec, fingerprint, items, cursor: 0,
                    applied: 0, skipped: 0, appliedMicro: '0',
                    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
                });
                t.create(db.collection('AdminLogs').doc('ADM-S2-' + jobRef.id + '-START'), admS2Audit(actor, actorUid, {
                    Action_Type: 'Operation Planned', Operation_ID: jobRef.id,
                    Target_UID: spec.uid || '', Details: JSON.stringify(spec), Item_Count: items.length
                }));
            });
        }
        let job;
        for (let step = 0; step < 20; step++) {
            job = (await jobRef.get()).data();
            if (job.actorUid !== actorUid || job.fingerprint !== fingerprint) throw admS2Error('Operation ownership/payload mismatch.', 409);
            if (job.cursor >= job.items.length) break;
            await admS2Process(jobRef, actorUid, job.cursor);
        }
        job = (await jobRef.get()).data();
        return res.json({ success: true, data: {
            requestId: jobRef.id, done: job.cursor >= job.items.length,
            total: job.items.length, processed: job.cursor, applied: job.applied,
            skipped: job.skipped, appliedMicro: job.appliedMicro,
            undistributedPoolMicro: job.spec.action === 'pool'
                ? (BigInt(job.spec.poolMicro) - BigInt(job.appliedMicro)).toString() : null
        }});
    } catch (error) {
        let operationCreated = null;
        if (operationRef && error.httpStatus === 400) {
            try { operationCreated = (await operationRef.get()).exists; }
            catch (checkError) { console.error('Operation existence check unavailable:', checkError); }
        }
        return res.status(error.httpStatus || 503).json({
            success: false, operationCreated,
            message: error.message || 'Operation interrupted; retry with the same requestId.'
        });
    }
}
app.post('/api/admin/airdrop-action', (req, res) => admS2Handle(req, res, 'airdrop'));
app.post('/api/admin/vault-action', (req, res) => admS2Handle(req, res, 'vault'));

// MEMO TCM-ADM-014-S3-A | 2026-10-10 03:07 IST | Asia/Kolkata
app.get('/api/admin/logs', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const uid = req.authenticatedUid;
        if (!uid) return res.status(401).json({ success: false, message: 'Authentication required.' });

        const actor = req.authenticatedUserDoc;
        if (!actor || !actor.exists || actor.id !== uid || actor.data().Role !== 'Admin' || actor.data().Status === 'Banned') {
            return res.status(403).json({ success: false, message: 'Active administrator privileges required.' });
        }

        const rawLimit = req.query.limit === undefined ? '25' : req.query.limit;
        if (typeof rawLimit !== 'string' || !/^\d{1,3}$/.test(rawLimit)) {
            return res.status(400).json({ success: false, message: 'Invalid page limit.' });
        }
        const pageLimit = Number(rawLimit);
        if (pageLimit < 1 || pageLimit > 100) {
            return res.status(400).json({ success: false, message: 'Page limit must be between 1 and 100.' });
        }

        const { Timestamp } = require('firebase-admin/firestore');
        let query = db.collection('AdminLogs')
            .orderBy('timestamp', 'desc')
            .orderBy('__name__', 'desc');

        if (req.query.cursor !== undefined) {
            if (typeof req.query.cursor !== 'string' || Buffer.byteLength(req.query.cursor, 'utf8') > 4096) {
                return res.status(400).json({ success: false, message: 'Invalid cursor.' });
            }
            let cursor;
            try { cursor = JSON.parse(req.query.cursor); }
            catch (error) { return res.status(400).json({ success: false, message: 'Malformed cursor JSON.' }); }
            const seconds = cursor?.timestamp?.seconds;
            const nanoseconds = cursor?.timestamp?.nanoseconds;
            const docId = cursor?.docId;
            if (
                !Number.isSafeInteger(seconds) || seconds < -62135596800 || seconds > 253402300799 ||
                !Number.isInteger(nanoseconds) || nanoseconds < 0 || nanoseconds > 999999999 ||
                typeof docId !== 'string' || !docId || docId.includes('/') ||
                docId === '.' || docId === '..' || Buffer.byteLength(docId, 'utf8') > 1500
            ) {
                return res.status(400).json({ success: false, message: 'Invalid cursor fields.' });
            }
            query = query.startAfter(new Timestamp(seconds, nanoseconds), docId);
        }

        const snap = await query.limit(pageLimit + 1).get();
        const page = snap.docs.slice(0, pageLimit);
        const text = value => typeof value === 'string' ? value.slice(0, 4000) : '';
        const items = page.map(doc => {
            const log = doc.data();
            const timestamp = log.timestamp;
            if (
                !(timestamp instanceof Timestamp) || !Number.isSafeInteger(timestamp.seconds) ||
                !Number.isInteger(timestamp.nanoseconds) ||
                timestamp.seconds < -62135596800 || timestamp.seconds > 253402300799 ||
                timestamp.nanoseconds < 0 || timestamp.nanoseconds > 999999999
            ) {
                const error = new Error('An audit record has an invalid timestamp; review AdminLogs data types.');
                error.httpStatus = 409;
                throw error;
            }
            const item = {
                id: doc.id,
                timestamp: { seconds: timestamp.seconds, nanoseconds: timestamp.nanoseconds },
                Date: text(log.Date), Admin_Name: text(log.Admin_Name),
                Actor_UID: text(log.Actor_UID), Action_Type: text(log.Action_Type),
                Target_UID: text(log.Target_UID), Details: text(log.Details),
                Outcome: text(log.Outcome), Operation_ID: text(log.Operation_ID)
            };
            for (const field of ['Amount', 'Unrecovered_Amount', 'Debt_Recovered']) {
                if (typeof log[field] === 'number' && Number.isFinite(log[field])) item[field] = log[field];
            }
            return item;
        });
        const hasMore = snap.size > pageLimit;
        const last = items[items.length - 1];
        return res.json({
            success: true, items,
            nextCursor: hasMore && last ? { timestamp: last.timestamp, docId: last.id } : null,
            hasMore, timestampRequired: true
        });
    } catch (error) {
        console.error('AdminLogs feed failed:', error);
        return res.status(error.httpStatus || 503).json({
            success: false,
            message: error.httpStatus ? error.message : 'Audit feed unavailable. Retry without changing your cursor.'
        });
    }
});

app.post('/api/admin/role-action', async (req, res) => {
    if (!m1RequireAdmin(req, res)) return;

    const actorUid = req.authenticatedUid;
    const { uid, role } = req.body || {};

    if (
        typeof uid !== 'string' ||
        !uid.trim() ||
        uid !== uid.trim() ||
        /[\u0000-\u001f\u007f/\\]/.test(uid) ||
        uid === '.' ||
        uid === '..' ||
        Buffer.byteLength(uid, 'utf8') > 1500 ||
        !['Admin', 'User'].includes(role)
    ) {
        return res.status(400).json({
            success: false,
            message: 'Invalid role action.'
        });
    }

    if (uid === actorUid && role !== 'Admin') {
        return res.status(400).json({
            success: false,
            message: 'You cannot demote your own administrator account.'
        });
    }

    try {
        const actorRef = db.collection('Users').doc(actorUid);
        const targetRef = db.collection('Users').doc(uid);
        const auditRef = db.collection('AdminLogs').doc();
        const token = req.authenticatedUserDoc.data().Token;

        const result = await db.runTransaction(async t => {
            const actorSnap = await t.get(actorRef);
            const actor = actorSnap.exists ? actorSnap.data() : null;

            if (
                !actor ||
                actor.Role !== 'Admin' ||
                actor.Status === 'Banned' ||
                typeof token !== 'string' ||
                !token ||
                actor.Token !== token
            ) {
                const error = new Error('Active administrator session required.');
                error.httpStatus = 403;
                throw error;
            }

            const targetSnap = uid === actorUid
                ? actorSnap
                : await t.get(targetRef);

            if (!targetSnap.exists) {
                const error = new Error('Account not found.');
                error.httpStatus = 404;
                throw error;
            }

            l4AssertMutable(targetSnap.data());
            const previousRole = String(targetSnap.data().Role || 'User');

            if (previousRole === role) {
                return { uid, role, changed: false };
            }

            t.update(targetRef, { Role: role });

            t.create(auditRef, {
                Admin_Name: actor.Name || actorUid,
                Actor_UID: actorUid,
                Target_UID: uid,
                Action_Type: role === 'Admin'
                    ? 'Admin Role Granted'
                    : 'Admin Role Revoked',
                Previous_Role: previousRole,
                New_Role: role,
                timestamp: FieldValue.serverTimestamp()
            });

            return { uid, role, changed: true };
        });

        try {
            await m2RedisCommand(() =>
                redisClient.del(`init_data_full_${result.uid}`)
            );
        } catch (error) {
            console.warn('Role committed; init cache invalidation pending.');
        }

        try {
            await clearUserCache(result.uid);
        } catch (error) {
            console.warn('Role committed; user cache invalidation pending.');
        }

        try {
            if (global.io) {
                global.io.to(result.uid).emit('user_role_changed', {
                    uid: result.uid,
                    role: result.role
                });
            }
        } catch (error) {
            console.warn('Role committed; live role notification unavailable.');
        }

        return res.json({
            success: true,
            message: result.changed
                ? role === 'Admin'
                    ? 'Administrator role granted.'
                    : 'Administrator role revoked.'
                : 'Account already has the requested role.',
            data: result
        });
    } catch (error) {
        console.error('Admin role action failed:', error.message);

        return res.status(error.httpStatus || 503).json({
            success: false,
            message: error.httpStatus
                ? error.message
                : 'Role update unavailable. Please try again.'
        });
    }
});

app.post('/api/admin/access-action', async (req, res) => {
    try {
        const actorUid = req.authenticatedUid;

        if (!actorUid) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required.'
            });
        }

        const { uid, status } = req.body || {};

        if (
            typeof uid !== 'string' ||
            !uid.trim() ||
            uid.includes('/') ||
            !['Banned', 'Active'].includes(status)
        ) {
            return res.status(400).json({
                success: false,
                message: 'Invalid account action.'
            });
        }

        if (uid === actorUid && status === 'Banned') {
            return res.status(400).json({
                success: false,
                message: 'You cannot block your own administrator account.'
            });
        }

        const result = await db.runTransaction(async (t) => {
            const actorSnap = await t.get(
                db.collection('Users').doc(actorUid)
            );

            if (
                !actorSnap.exists ||
                actorSnap.data().Role !== 'Admin' ||
                actorSnap.data().Status === 'Banned'
            ) {
                const error = new Error(
                    'Active administrator privileges required.'
                );
                error.httpStatus = 403;
                throw error;
            }

            const targetRef = db.collection('Users').doc(uid);
            const targetSnap = await t.get(targetRef);

            if (!targetSnap.exists) {
                const error = new Error('Account not found.');
                error.httpStatus = 404;
                throw error;
            }

            l4AssertMutable(targetSnap.data());
            const previousStatus = targetSnap.data().Status;

            if (previousStatus === status) {
                return { uid, status, changed: false };
            }

            t.update(targetRef, { Status: status });

            t.create(db.collection('AdminLogs').doc(), {
                Admin_Name: actorSnap.data().Name || actorUid,
                Actor_UID: actorUid,
                Target_UID: uid,
                Action_Type: status === 'Banned'
                    ? 'Account Blocked'
                    : 'Account Unblocked',
                Previous_Status: previousStatus || 'Unspecified',
                New_Status: status,
                Details: 'Account access updated by administrator',
                Date: new Date().toISOString(),
                timestamp: FieldValue.serverTimestamp()
            });

            return { uid, status, changed: true };
        });

        if (result.status === 'Banned') {
            await invalidateDashboardSockets(result.uid, {
                status: 403, message: 'Account access is blocked.'
            });
        }
        try {
            await clearUserCache(result.uid);
        } catch (error) {
            console.error('Access cache invalidation failed:', error);
        }

        return res.json({
            success: true,
            message: `UID ${result.uid} access status: ${result.status}`,
            data: result
        });
    } catch (error) {
        return res.status(error.httpStatus || 500).json({
            success: false,
            message: error.message
        });
    }
});

app.post('/api/admin/deposit-action', async (req, res) => {
    try {
        const actorUid = req.authenticatedUid;
        if (!actorUid) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required.'
            });
        }

        const { action, docId, adminNote } = req.body || {};
        if (
            !['approve', 'reject'].includes(action) ||
            typeof docId !== 'string' ||
            !docId.trim() ||
            docId.includes('/')
        ) {
            return res.status(400).json({
                success: false,
                message: 'Invalid deposit action.'
            });
        }

        const reason = typeof adminNote === 'string'
            ? adminNote.trim().slice(0, 1000)
            : '';

        if (action === 'reject' && !reason) {
            throw new Error('Rejection reason is required.');
        }

        const result = await db.runTransaction(async (t) => {
            const adminRef = db.collection('Users').doc(actorUid);
            const txRef = db.collection('Transactions').doc(docId);

            const adminSnap = await t.get(adminRef);
            if (!adminSnap.exists || adminSnap.data().Role !== 'Admin') {
                const error = new Error('Administrator privileges required.');
                error.httpStatus = 403;
                throw error;
            }

            const txSnap = await t.get(txRef);
            if (!txSnap.exists) {
                throw new Error('Deposit transaction not found.');
            }

            const deposit = txSnap.data();
            if (deposit.Type !== 'Deposit' || deposit.Status !== 'Pending') {
                const error = new Error(
                    'Deposit is not Pending or has already been processed.'
                );
                error.httpStatus = 409;
                throw error;
            }

            const uid = deposit.UID;
            const amount = Number(deposit.Amount);

            if (
                typeof uid !== 'string' ||
                !uid ||
                uid.includes('/') ||
                (
                    typeof deposit.Amount !== 'number' &&
                    typeof deposit.Amount !== 'string'
                ) ||
                !/^\d+(?:\.\d+)?$/.test(String(deposit.Amount).trim()) ||
                !Number.isFinite(amount) ||
                amount <= 0
            ) {
                throw new Error('Invalid recorded deposit.');
            }

            const userRef = db.collection('Users').doc(uid);
            const walletRef = db.collection('Wallets').doc(uid);
            const userSnap = await t.get(userRef);
            const walletSnap = await t.get(walletRef);

            if (!userSnap.exists || !walletSnap.exists) {
                throw new Error('Deposit account not found.');
            }

            if (action === 'approve') await d2LegacyLocks(t, txRef, deposit, true);
            const txCountBase = nextStakingTxCount(userSnap.data());
            let txCount = txCountBase;
            let debtRecovered = 0n;
            let netDepositCredit = 0n;
            const walletUpdates = {};

            if (action === 'approve') {
                const wallet = walletSnap.data();
                const depositMicro = admS2Micro(deposit.Amount, 'deposit amount', false);
                const main = admS2Balance(wallet, 'Main_Balance');
                const totalDeposit = admS2Balance(wallet, 'Total_Deposit');
                const debt = admS2Balance(wallet, 'Debt');
                debtRecovered = debt < depositMicro ? debt : depositMicro;
                netDepositCredit = depositMicro - debtRecovered;

                Object.assign(walletUpdates, {
                    Main_Balance: admS2Money(main + netDepositCredit),
                    Total_Deposit: admS2Money(totalDeposit + depositMicro),
                    Debt: admS2Money(debt - debtRecovered)
                });

                if (debtRecovered > 0n) {
                    txCount = txCountBase + 1;
                    if (!Number.isSafeInteger(txCount)) {
                        throw new Error('Transaction counter overflow.');
                    }
                }
            }

            const status = action === 'approve' ? 'Success' : 'Rejected';
            const txUpdates = {
                Status: status,
                status,
                Admin_Note: reason || 'Deposit approved by administrator',
                Processed_By: actorUid,
                ...(action === 'approve' ? {
                    Debt_Recovered: admS2Money(debtRecovered),
                    Net_Deposit_Credit: admS2Money(netDepositCredit)
                } : {}),
                [action === 'approve' ? 'Approved_At' : 'Rejected_At']:
                    FieldValue.serverTimestamp()
            };

            if (action === 'approve') {
                t.update(walletRef, moneyV7Updates(walletSnap.data(), { ...walletUpdates, ...t8MainEntry(t, uid, walletSnap.data(), walletUpdates.Main_Balance, 'Deposit credit after debt settlement', txRef.id) }, 'Wallet', 'update'));
                if (debtRecovered > 0n) {
                    t.create(db.collection('Transactions').doc('TX-DEBT-REC-' + txRef.id), t9Record(t, {
                        UID: uid,
                        Type: 'Debt Recovery',
                        Amount: admS2Money(debtRecovered),
                        Status: 'Success', status: 'Success',
                        Order_ID: 'DEBT-REC-' + txRef.id,
                        Deposit_Transaction_ID: txRef.id,
                        Debt_Before: walletSnap.data().Debt === undefined ? 0 : walletSnap.data().Debt,
                        Debt_After: walletUpdates.Debt,
                        Date: new Date().toISOString(),
                        timestamp: FieldValue.serverTimestamp()
                    }));
                }
            }

            t.update(txRef, action === 'approve' ? t9Record(t, txUpdates, uid, 'Deposit') : txUpdates);
            t.update(userRef, { 'counters.txCount': txCount });

            t.create(db.collection('AdminLogs').doc(), {
                Admin_Name: adminSnap.data().Name || actorUid,
                Actor_UID: actorUid,
                Action_Type: action === 'approve'
                    ? 'Deposit Approved'
                    : 'Deposit Rejected',
                Target_UID: uid,
                Transaction_ID: txRef.id,
                Order_ID: deposit.Order_ID || txRef.id,
                Amount: amount,
                Debt_Recovered: admS2Money(debtRecovered),
                Net_Deposit_Credit: action === 'approve' ? admS2Money(netDepositCredit) : 0,
                Details: reason || 'Deposit approved',
                Date: new Date().toISOString(),
                timestamp: FieldValue.serverTimestamp()
            });

            return {
                uid, amount, status, txCount,
                debtRecovered: admS2Money(debtRecovered),
                netDepositCredit: admS2Money(netDepositCredit)
            };
        });

        try {
            await clearUserCache(result.uid);
        } catch (cacheError) {
            console.error('Deposit cache invalidation failed:', cacheError);
        }

        return res.json({
            success: true,
            message: action === 'approve'
                ? `Deposit approved: ${result.amount} USDT. Wallet credit: ${result.netDepositCredit} USDT. Debt recovered: ${result.debtRecovered} USDT.`
                : `Deposit rejected: ${result.amount} USDT.`,
            data: result
        });
    } catch (error) {
        return res.status(error.httpStatus || 400).json({
            success: false,
            message: error.message
        });
    }
});

app.get('/api/finance/deposit-address', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const uid = req.authenticatedUid;
        if (!uid) return res.status(401).json({ success: false, message: 'Authentication required.' });
        const wallets = await ensureUserDepositWallets(uid);
        return res.json({ success: true, data: {
            BEP20: wallets.Deposit_BEP20, TRC20: wallets.Deposit_TRC20
        } });
    } catch (error) {
        const known = typeof error.code === 'string' && error.code.startsWith('DEPOSIT_');
        return res.status(known ? error.status : 503).json({
            success: false,
            code: known ? error.code : 'DEPOSIT_WALLET_UNAVAILABLE',
            message: known ? error.message : 'Deposit wallets are temporarily unavailable. Please try again.'
        });
    }
});

const d2BscUsdt = '0x55d398326f99059fF775485246999027B3197955';
const d2TronUsdt = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const d2TransferTopic = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const d2TokenABI = [
    'function balanceOf(address) view returns (uint256)',
    'function transfer(address,uint256) returns (bool)'
];
let d2BscReader = null, d2TronReader = null;

function d2Error(status, code, message) {
    return Object.assign(new Error(message), { status, httpStatus: status, code });
}
function d2ReplayError() {
    return d2Error(409, 'DEPOSIT_ALREADY_CREDITED', 'This transaction hash has already been credited.');
}
function d2Hash(network, value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (network === 'BEP20' && /^0x[0-9a-fA-F]{64}$/.test(text)) {
        const txHash = text.toLowerCase();
        return { txHash, lockKey: 'BSC_' + txHash };
    }
    if (network === 'TRC20' && /^(?:0x)?[0-9a-fA-F]{64}$/.test(text)) {
        const txHash = text.replace(/^0x/, '').toLowerCase();
        return { txHash, lockKey: 'TRON_' + txHash };
    }
    throw d2Error(400, 'DEPOSIT_INVALID_HASH', 'Select BEP20 or TRC20 and enter a valid transaction hash.');
}
function d2MicroText(micro) {
    return (micro / admS2Scale).toString() + '.' +
        (micro % admS2Scale).toString().padStart(6, '0');
}
async function d2RPC(operation, milliseconds = 15000) {
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(operation),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(d2Error(503, 'DEPOSIT_RPC_UNAVAILABLE',
                    'Blockchain verification is temporarily unavailable. Please try again.')), milliseconds);
            })
        ]);
    } finally { clearTimeout(timer); }
}
function d2Bsc() {
    if (!hdEthers) throw d2Error(503, 'DEPOSIT_NOT_CONFIGURED', 'Blockchain deposits are not configured.');
    if (!d2BscReader) {
        const request = new hdEthers.FetchRequest(process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org/');
        request.timeout = 15000;
        d2BscReader = new hdEthers.JsonRpcProvider(request);
    }
    return d2BscReader;
}
function d2Tron() {
    if (!hdTronWeb) throw d2Error(503, 'DEPOSIT_NOT_CONFIGURED', 'Blockchain deposits are not configured.');
    if (!d2TronReader) {
        d2TronReader = new hdTronWeb({
            fullHost: process.env.TRON_FULL_HOST || 'https://api.trongrid.io',
            ...(process.env.TRONGRID_API_KEY
                ? { headers: { 'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY } } : {})
        });
    }
    return d2TronReader;
}
function d2Confirmations() {
    const count = Number(process.env.BSC_MIN_CONFIRMATIONS || 3);
    if (!Number.isSafeInteger(count) || count < 1) {
        throw d2Error(503, 'DEPOSIT_NOT_CONFIGURED', 'Deposit confirmation settings are invalid.');
    }
    return count;
}
function d2TronHex(address) {
    const text = String(address || '').replace(/^0x/i, '');
    if (/^[0-9a-fA-F]{40}$/.test(text)) return text.toLowerCase();
    if (/^41[0-9a-fA-F]{40}$/.test(text)) return text.slice(2).toLowerCase();
    if (hdTronWeb.isAddress(address)) {
        return hdTronWeb.address.toHex(address).slice(2).toLowerCase();
    }
    return '';
}
function d2TransferRaw(logs, network, destination, source) {
    const contract = network === 'BEP20' ? d2BscUsdt.toLowerCase() : d2TronHex(d2TronUsdt);
    const target = network === 'BEP20' ? destination.slice(2).toLowerCase() : d2TronHex(destination);
    const from = source ? (network === 'BEP20' ? source.slice(2).toLowerCase() : d2TronHex(source)) : '';
    let total = 0n;
    for (const log of Array.isArray(logs) ? logs : []) {
        const emitter = network === 'BEP20' ? String(log.address || '').toLowerCase() : d2TronHex(log.address);
        if (emitter !== contract || log.removed === true || !Array.isArray(log.topics) || log.topics.length !== 3) continue;
        const topics = log.topics.map(value => String(value).replace(/^0x/i, '').toLowerCase());
        if (topics[0] !== d2TransferTopic || !/^0{24}[0-9a-f]{40}$/.test(topics[2]) ||
            topics[2].slice(24) !== target || (from && topics[1] !== '0'.repeat(24) + from)) continue;
        const data = String(log.data || '').replace(/^0x/i, '');
        if (!/^[0-9a-fA-F]{64}$/.test(data)) {
            throw d2Error(400, 'DEPOSIT_INVALID_EVENT', 'Invalid USDT Transfer event.');
        }
        total += BigInt('0x' + data);
    }
    return total;
}
async function verifyOnChainUsdtDeposit({ network, txid, expectedAddress, expectedMicro }) {
    const normalized = d2Hash(network, txid);
    if ((await db.collection('Used_TxHashes').doc(normalized.lockKey).get()).exists) throw d2ReplayError();
    let verifiedMicro, verifiedBlock;
    try {
        if (network === 'BEP20') {
            expectedAddress = hdEthers.getAddress(expectedAddress);
            const provider = d2Bsc();
            if ((await d2RPC(() => provider.getNetwork())).chainId !== 56n) {
                throw d2Error(503, 'DEPOSIT_WRONG_NETWORK', 'BSC RPC must connect to mainnet.');
            }
            const receipt = await d2RPC(() => provider.getTransactionReceipt(normalized.txHash));
            if (!receipt || receipt.status !== 1 || receipt.hash.toLowerCase() !== normalized.txHash) {
                throw d2Error(400, 'DEPOSIT_UNCONFIRMED', 'Successful USDT transaction receipt was not found.');
            }
            if (await d2RPC(() => receipt.confirmations()) < d2Confirmations()) {
                throw d2Error(409, 'DEPOSIT_UNCONFIRMED', 'Transaction needs more confirmations. Please try again shortly.');
            }
            const block = await d2RPC(() => provider.getBlock(receipt.blockNumber));
            if (!block || block.hash !== receipt.blockHash) {
                throw d2Error(409, 'DEPOSIT_UNCONFIRMED', 'Transaction block changed. Please retry after confirmation.');
            }
            verifiedBlock = receipt.blockNumber;
            const raw = d2TransferRaw(receipt.logs, network, expectedAddress);
            if (raw % (10n ** 12n) !== 0n) {
                throw d2Error(400, 'DEPOSIT_PRECISION', 'On-chain amount must be an exact six-decimal USDT value.');
            }
            verifiedMicro = raw / (10n ** 12n);
        } else {
            const tron = d2Tron();
            if (!hdTronWeb.isAddress(expectedAddress)) throw new Error('Invalid deposit address');
            const info = await d2RPC(() => tron.trx.getTransactionInfo(normalized.txHash));
            if (!info || String(info.id || '').toLowerCase() !== normalized.txHash ||
                !info.receipt || info.receipt.result !== 'SUCCESS') {
                throw d2Error(400, 'DEPOSIT_UNCONFIRMED', 'Confirmed successful USDT transaction was not found.');
            }
            verifiedBlock = info.blockNumber;
            verifiedMicro = d2TransferRaw(info.log, network, expectedAddress);
        }
    } catch (error) {
        if (String(error.code || '').startsWith('DEPOSIT_')) throw error;
        throw d2Error(503, 'DEPOSIT_RPC_UNAVAILABLE', 'Blockchain verification is temporarily unavailable. Please try again.');
    }
    if (verifiedMicro < 10000n) {
        throw d2Error(400, 'DEPOSIT_MINIMUM', 'At least 0.010000 USDT must reach your deposit address from the official USDT contract.');
    }
    if (verifiedMicro !== expectedMicro) {
        throw d2Error(400, 'DEPOSIT_AMOUNT_MISMATCH',
            'On-chain amount found: ' + d2MicroText(verifiedMicro) + ' USDT. Enter this exact amount.');
    }
    return { ...normalized, verifiedMicro, verifiedBlock, verifiedAmount: admS2Money(verifiedMicro) };
}

function d2LegacyKeys(row) {
    if (row.Network === 'BEP20' || row.Network === 'TRC20') {
        try { return [d2Hash(row.Network, row.TXID)]; } catch (error) { return []; }
    }
    const result = [];
    for (const network of ['BEP20', 'TRC20']) {
        try { result.push(d2Hash(network, row.TXID)); } catch (error) {}
    }
    return result;
}
async function d2LegacyLocks(transaction, reference, row, rejectUsed) {
    const keys = d2LegacyKeys(row);
    const records = [];
    for (const key of keys) {
        const ref = db.collection('Used_TxHashes').doc(key.lockKey);
        records.push({ ...key, ref, snapshot: await transaction.get(ref) });
    }
    if (rejectUsed && records.some(record => record.snapshot.exists)) throw d2ReplayError();
    let micro = 0n;
    try { micro = admS2Micro(row.Amount, 'legacy deposit amount'); } catch (error) {}
    for (const record of records) {
        if (record.snapshot.exists) continue;
        transaction.create(record.ref, {
            UID: row.UID, Network: record.lockKey.startsWith('BSC_') ? 'BEP20' : 'TRC20',
            TXID: record.txHash, Amount: admS2Money(micro), Amount_micro: micro.toString(),
            Order_ID: row.Order_ID || reference.id, Transaction_ID: reference.id,
            Legacy_Manual: true, timestamp: FieldValue.serverTimestamp()
        });
    }
}
async function d2BackfillLegacyLocks(uid) {
    const markerRef = db.collection('Deposit_Replay_Migrations').doc(uid);
    const marker = await markerRef.get();
    if (marker.exists && marker.data().complete === true) return;
    let cursor = marker.exists ? marker.data().cursor || '' : '';
    for (let page = 0; page < 5; page++) {
        let query = db.collection('Transactions').where('UID', '==', uid)
            .orderBy(m1FieldPath.documentId()).limit(100);
        if (cursor) query = query.startAfter(cursor);
        const rows = await query.get();
        for (const doc of rows.docs) {
            const row = doc.data();
            if (row.Type !== 'Deposit' || String(row.Status || row.status).toLowerCase() !== 'success' ||
                row.Verified_OnChain === true || !d2LegacyKeys(row).length) continue;
            await db.runTransaction(async transaction => {
                const current = await transaction.get(doc.ref);
                if (current.exists && current.data().Type === 'Deposit' &&
                    String(current.data().Status || current.data().status).toLowerCase() === 'success') {
                    await d2LegacyLocks(transaction, doc.ref, current.data(), false);
                }
            });
        }
        cursor = rows.empty ? cursor : rows.docs[rows.size - 1].id;
        const complete = rows.size < 100;
        await markerRef.set({ cursor, complete }, { merge: true });
        if (complete) return;
    }
    throw d2Error(503, 'DEPOSIT_REPLAY_BACKFILL_PENDING',
        'Deposit history protection is being prepared. Please retry shortly.');
}

app.post('/api/finance/deposit', async (req, res) => {
    try {
        const uid = req.authenticatedUid;
        if (typeof uid !== 'string' || !uid || uid.includes('/')) {
            return res.status(401).json({ success: false, message: 'Authentication required.' });
        }
        if (req.body.uid !== undefined && req.body.uid !== uid) {
            throw d2Error(403, 'DEPOSIT_OWNER_MISMATCH', 'Account ownership mismatch.');
        }
        const checkAccount = snapshot => {
            if (!snapshot.exists || snapshot.data().Account_Deleted === true || snapshot.data().Status === 'Banned') {
                throw d2Error(403, 'DEPOSIT_ACCOUNT_UNAVAILABLE', 'Account is unavailable for deposits.');
            }
            if (snapshot.data().Status === 'Pending_Deletion') {
                throw d2Error(403, 'DEPOSIT_FROZEN_PENDING_DELETION',
                    'Account deletion is in progress. Inflows are suspended. Abort deletion to resume transactions.');
            }
            if (snapshot.data().Token !== r3Bearer(req)) {
                throw d2Error(401, 'DEPOSIT_SESSION_CHANGED', 'Session changed. Please sign in again.');
            }
        };
        checkAccount(req.authenticatedUserDoc);
        const network = req.body.network;
        const normalized = d2Hash(network, req.body.txid || req.body.txHash);
        const expectedMicro = admS2Micro(req.body.amount, 'deposit amount', false);
        const wallets = await ensureUserDepositWallets(uid);
        await d2BackfillLegacyLocks(uid);
        const expectedAddress = network === 'BEP20' ? wallets.Deposit_BEP20 : wallets.Deposit_TRC20;
        const verified = await verifyOnChainUsdtDeposit({
            network, txid: normalized.txHash, expectedAddress, expectedMicro
        });
        const { verifiedMicro, verifiedAmount, txHash, lockKey } = verified;
        const userRef = db.collection('Users').doc(uid);
        const walletRef = db.collection('Wallets').doc(uid);
        const lockRef = db.collection('Used_TxHashes').doc(lockKey);
        const txRef = db.collection('Transactions').doc();
        const newOrderId = generateOrderId('DEP');
        const txDateIso = new Date().toISOString();
        const data = await db.runTransaction(async transaction => {
            const lock = await transaction.get(lockRef);
            const account = await transaction.get(userRef);
            const walletSnap = await transaction.get(walletRef);
            if (lock.exists) throw d2ReplayError();
            checkAccount(account);
            if (!walletSnap.exists) throw d2Error(409, 'DEPOSIT_WALLET_MISSING', 'Wallet ledger was not found.');
            if (account.data().Deposit_Wallet_Index !== wallets.Deposit_Wallet_Index ||
                account.data()[network === 'BEP20' ? 'Deposit_BEP20' : 'Deposit_TRC20'] !== expectedAddress) {
                throw d2Error(409, 'DEPOSIT_WALLET_CHANGED', 'Deposit wallet changed. Please contact support.');
            }
            const wallet = walletSnap.data();
            const main = admS2Balance(wallet, 'Main_Balance');
            const totalDeposit = admS2Balance(wallet, 'Total_Deposit');
            const debt = admS2Balance(wallet, 'Debt');
            const debtRecovered = debt < verifiedMicro ? debt : verifiedMicro;
            const netDepositCredit = verifiedMicro - debtRecovered;
            const updates = {
                Main_Balance: admS2Money(main + netDepositCredit),
                Total_Deposit: admS2Money(totalDeposit + verifiedMicro),
                Debt: admS2Money(debt - debtRecovered)
            };
            const txCount = nextStakingTxCount(account.data()) + (debtRecovered > 0n ? 1 : 0);
            if (!Number.isSafeInteger(txCount)) throw admS2Error('Transaction counter overflow.');
            const deposit = {
                UID: uid, Type: 'Deposit', Network: network,
                Amount: verifiedAmount, Amount_micro: verifiedMicro.toString(),
                TXID: txHash, Order_ID: newOrderId, Date: txDateIso,
                Status: 'Success', status: 'Success', Verified_OnChain: true,
                Deposit_Address: expectedAddress, Deposit_Wallet_Index: wallets.Deposit_Wallet_Index,
                Deposit_Block_Number: verified.verifiedBlock,
                Debt_Recovered: admS2Money(debtRecovered),
                Net_Deposit_Credit: admS2Money(netDepositCredit),
                Sweep_Status: 'Pending_Sweep', timestamp: FieldValue.serverTimestamp()
            };
            transaction.update(walletRef, moneyV7Updates(wallet, { ...updates, ...t8MainEntry(transaction, uid, wallet, updates.Main_Balance, 'Deposit credit after debt settlement', newOrderId) }, 'Wallet', 'update'));
            transaction.update(userRef, { 'counters.txCount': txCount });
            transaction.create(lockRef, {
                UID: uid, Network: network, TXID: txHash, Amount: verifiedAmount,
                Amount_micro: verifiedMicro.toString(), Order_ID: newOrderId,
                Transaction_ID: txRef.id, timestamp: FieldValue.serverTimestamp()
            });
            transaction.create(txRef, t9Record(transaction, deposit));
            if (debtRecovered > 0n) {
                transaction.create(db.collection('Transactions').doc('TX-DEBT-REC-' + txRef.id), t9Record(transaction, {
                    UID: uid, Type: 'Debt Recovery', Amount: admS2Money(debtRecovered),
                    Status: 'Success', status: 'Success', Order_ID: 'DEBT-REC-' + txRef.id,
                    Deposit_Transaction_ID: txRef.id,
                    Debt_Before: wallet.Debt === undefined ? 0 : wallet.Debt,
                    Debt_After: updates.Debt, Date: txDateIso, timestamp: FieldValue.serverTimestamp()
                }));
            }
            return { ...deposit, timestamp: Date.now(), id: txRef.id, txCount };
        });
        await clearUserCache(uid);
        const response = res.json({ success: true, message: 'Deposit verified on-chain & credited!', data });
        scheduleDepositSweep({ uid, index: wallets.Deposit_Wallet_Index, network, txDocId: txRef.id });
        return response;
    } catch (error) {
        const known = String(error.code || '').startsWith('DEPOSIT_');
        return res.status(error.status || error.httpStatus || 503).json({
            success: false, code: known ? error.code : 'DEPOSIT_REJECTED',
            message: known || error.httpStatus === 400 ? error.message :
                'Deposit verification is temporarily unavailable. Please retry with the same transaction hash.'
        });
    }
});

const d2SweepQueues = new Map();

const d3GasQueues = new Map();

function d3GasStation(network) {
    const bsc = network === 'BEP20';
    const override = process.env[bsc ? 'GAS_STATION_PRIVATE_KEY_BSC' : 'GAS_STATION_PRIVATE_KEY_TRON'];
    const wallet = override
        ? new hdEthers.Wallet(override.startsWith('0x') ? override : '0x' + override)
        : hdEthers.HDNodeWallet.fromPhrase(process.env.HD_MASTER_MNEMONIC, '',
            bsc ? "m/44'/60'/0'/0/0" : "m/44'/195'/0'/0/0");
    return { wallet, address: bsc ? wallet.address : hdTronWeb.address.fromPrivateKey(wallet.privateKey.slice(2)) };
}
(() => {
    if (!hdDepositConfig) return;
    for (const network of ['BEP20', 'TRC20']) {
        try {
            const reserved = network === 'BEP20'
                ? hdEthers.getAddress(hdDepositConfig.bep.deriveChild(0).address)
                : hdTronWeb.address.fromHex('41' + hdDepositConfig.tron.deriveChild(0).address.slice(2));
            console.info('[GAS STATION] ' + network + ' reserved index 0: ' + reserved);
            const station = d3GasStation(network);
            console.info('[GAS STATION] ' + network + ' funding address: ' + station.address);
        } catch (error) {
            console.warn('[GAS STATION] ' + network + ' configuration invalid; top-ups disabled.');
        }
    }
})();
function d3GasCap(name, fallback) {
    const value = process.env[name] ?? fallback;
    if (!/^[0-9]+$/.test(value) || BigInt(value) <= 0n) throw new Error('Invalid gas cap');
    return BigInt(value);
}
function d3TopUpClear() {
    return Object.fromEntries(['topUpHash', 'topUpAmount', 'topUpSigned', 'topUpStation',
        'topUpChild', 'topUpState', 'topUpReserved'].map(key => [key, FieldValue.delete()]));
}
async function d3NativeBalance(network, address) {
    if (network === 'BEP20') return d2RPC(() => d2Bsc().getBalance(address));
    const value = await d2RPC(() => d2Tron().trx.getBalance(address));
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Native balance unavailable');
    return BigInt(value);
}
function d3TronUnsigned(unsigned, station, child, amount) {
    const calls = unsigned?.raw_data?.contract;
    const value = calls?.[0]?.parameter?.value;
    if (!calls || calls.length !== 1 || calls[0].type !== 'TransferContract' ||
        d2TronHex(value.owner_address) !== d2TronHex(station) ||
        d2TronHex(value.to_address) !== d2TronHex(child) ||
        !Number.isSafeInteger(value.amount) || BigInt(value.amount) !== amount) {
        throw new Error('Unexpected native transfer');
    }
    const utils = (d2Tron().utils || require('tronweb').utils).transaction;
    const canonical = String(utils.txPbToTxID(utils.txJsonToPb({ raw_data: unsigned.raw_data })))
        .replace(/^0x/, '').toLowerCase();
    if (!/^(?:[0-9a-fA-F]{2})+$/.test(unsigned.raw_data_hex || '') ||
        d2Hash('TRC20', unsigned.txID).txHash !== canonical ||
        hdEthers.sha256('0x' + unsigned.raw_data_hex).slice(2).toLowerCase() !== canonical) {
        throw new Error('Native transaction encoding mismatch');
    }
}
async function s4BscReceipt(hash) {
    const provider = d2Bsc();
    const receipt = await d2RPC(() => provider.getTransactionReceipt(hash));
    if (!receipt) return null;
    if (String(receipt.hash).toLowerCase() !== hash.toLowerCase()) throw new Error('Receipt hash mismatch');
    if (await d2RPC(() => receipt.confirmations()) < d2Confirmations()) return null;
    const block = await d2RPC(() => provider.getBlock(receipt.blockNumber));
    if (!block || block.hash !== receipt.blockHash) return null;
    return receipt.status === 0 || receipt.status === 1 ? receipt : null;
}
async function s4TronBody(hash) {
    const body = await d2RPC(() => d2Tron().solidityNode.request(
        'walletsolidity/gettransactionbyid', { value: hash }, 'post'));
    if (body && Object.keys(body).length === 0) return null;
    if (String(body?.txID || '').toLowerCase() !== hash) throw new Error('Confirmed transaction unavailable');
    return body;
}
async function d3TopUpReceipt(network, job) {
    const amount = BigInt(job.topUpAmount);
    if (network === 'BEP20') {
        const provider = d2Bsc();
        const receipt = await s4BscReceipt(job.topUpHash);
        if (!receipt) return null;
        if (receipt.status !== 1) return false;
        const tx = await d2RPC(() => provider.getTransaction(job.topUpHash));
        if (!tx || tx.hash.toLowerCase() !== job.topUpHash ||
            hdEthers.getAddress(tx.from) !== job.topUpStation ||
            hdEthers.getAddress(tx.to) !== job.topUpChild || tx.value !== amount || tx.data !== '0x') {
            throw new Error('Native receipt mismatch');
        }
        return true;
    }
    const tx = await s4TronBody(job.topUpHash);
    if (!tx?.ret?.[0]?.contractRet) return null;
    d3TronUnsigned(tx, job.topUpStation, job.topUpChild, amount);
    return tx.ret[0].contractRet === 'SUCCESS';
}

function scheduleDepositSweep(args) {
    try {
        const key = args.network + '_' + args.uid;
        const previous = d2SweepQueues.get(key) || Promise.resolve();
        const task = previous.catch(() => {}).then(() =>
            new Promise(resolve => setImmediate(resolve))).then(() => d2RunSweep(args));
        const safe = task.catch(() => {
            console.warn('[DEPOSIT SWEEP] Deferred; credited wallet is unchanged.');
        }).finally(() => {
            if (d2SweepQueues.get(key) === safe) d2SweepQueues.delete(key);
        });
        d2SweepQueues.set(key, safe);
    } catch (error) {
        console.warn('[DEPOSIT SWEEP] Scheduling deferred; credited wallet is unchanged.');
    }
}
function d3EnsureGas(args) {
    const previous = d3GasQueues.get(args.network) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => d3RunGasTopUp(args));
    const tail = task.catch(() => {}).finally(() => {
        if (d3GasQueues.get(args.network) === tail) d3GasQueues.delete(args.network);
    });
    d3GasQueues.set(args.network, tail);
    return task;
}
async function d3RunGasTopUp({ network, child, jobRef, lease, neededGas }) {
    const bsc = network === 'BEP20';
    const lockRef = db.collection('System').doc('Gas_Station_Lock_' + network);
    const ledgerRef = db.collection('System').doc('Gas_Station_Ledger');
    const stationLease = tcmAuthCrypto.randomUUID();
    let acquired = false;
    try {
        let job = await db.runTransaction(async transaction => {
            const snapshot = await transaction.get(jobRef);
            if (!snapshot.exists || snapshot.data().lease !== lease) throw new Error('Sweep lease changed');
            return snapshot.data();
        });
        if (job.topUpReviewRequired) throw new Error('Top-up review required');
        if (!job.topUpHash && await d3NativeBalance(network, child) >= neededGas) return;
        await db.runTransaction(async transaction => {
            const snapshot = await transaction.get(lockRef);
            const row = snapshot.exists ? snapshot.data() : {};
            if (Number(row.leaseUntil || 0) > Date.now() ||
                (row.pendingHash && (row.pendingJob !== jobRef.id || row.pendingHash !== job.topUpHash))) {
                throw new Error('Gas station busy');
            }
            transaction.set(lockRef, { lease: stationLease, leaseUntil: Date.now() + 120000 }, { merge: true });
        });
        acquired = true;
        if (!job.topUpHash) {
            const deficit = neededGas - await d3NativeBalance(network, child);
            if (deficit <= 0n) return;
            const cap = d3GasCap(bsc ? 'BSC_MAX_TOPUP_WEI' : 'TRON_MAX_TOPUP_SUN',
                bsc ? '5000000000000000' : '50000000');
            const dailyCap = d3GasCap(bsc ? 'BSC_DAILY_GAS_CAP_WEI' : 'TRON_DAILY_GAS_CAP_SUN',
                bsc ? '100000000000000000' : '500000000');
            if (deficit > cap) throw new Error('Top-up cap exceeded');
            const { wallet, address: station } = d3GasStation(network);
            if (!station || station === child) throw new Error('Gas station address conflict');
            let signed, hash, reserved;
            if (bsc) {
                const provider = d2Bsc();
                if ((await d2RPC(() => provider.getNetwork())).chainId !== 56n) throw new Error('Wrong chain');
                const gasPrice = (await d2RPC(() => provider.getFeeData())).gasPrice;
                if (!gasPrice || gasPrice <= 0n) throw new Error('Gas price unavailable');
                const estimate = await d2RPC(() => provider.estimateGas({ from: station, to: child, value: deficit }));
                const gasLimit = (estimate * 120n + 99n) / 100n;
                reserved = deficit + gasLimit * gasPrice;
                if (await d3NativeBalance(network, station) < reserved) {
                    throw new Error('Gas station reserve insufficient');
                }
                const nonce = await d2RPC(() => provider.getTransactionCount(station, 'pending'));
                signed = await wallet.signTransaction({ to: child, value: deficit, data: '0x',
                    type: 0, chainId: 56, nonce, gasLimit, gasPrice });
                hash = hdEthers.keccak256(signed);
            } else {
                reserved = deficit + 2000000n;
                if (deficit > BigInt(Number.MAX_SAFE_INTEGER) ||
                    await d3NativeBalance(network, station) < reserved) {
                    throw new Error('Gas station reserve insufficient');
                }
                const unsigned = await d2RPC(() => d2Tron().transactionBuilder.sendTrx(child, Number(deficit), station));
                d3TronUnsigned(unsigned, station, child, deficit);
                const tx = await d2Tron().trx.sign(unsigned, wallet.privateKey.slice(2));
                hash = d2Hash(network, tx.txID).txHash;
                signed = JSON.stringify(tx);
            }
            job = { ...job, topUpHash: hash, topUpAmount: deficit.toString(), topUpSigned: signed,
                topUpStation: station, topUpChild: child, topUpState: 'Pending', topUpReserved: reserved.toString() };
            // Reserve top-up plus station fee allowance against the UTC daily cap.
            // Persist public signed data BEFORE broadcast.
            // Reservations are not refunded after uncertain RPC results.
            await db.runTransaction(async transaction => {
                const current = await transaction.get(jobRef);
                const lock = await transaction.get(lockRef);
                const ledger = await transaction.get(ledgerRef);
                if (!current.exists || current.data().lease !== lease || current.data().topUpHash ||
                    !lock.exists || lock.data().lease !== stationLease || lock.data().pendingHash ||
                    Number(lock.data().leaseUntil) <= Date.now()) throw new Error('Gas lease changed');
                const day = new Date().toISOString().slice(0, 10);
                const row = ledger.exists ? ledger.data()[network] : null;
                const spent = row?.day === day ? BigInt(row.spent) : 0n;
                if (spent < 0n || spent + reserved > dailyCap) throw new Error('Daily gas cap exceeded');
                transaction.set(ledgerRef, { [network]: { day, spent: (spent + reserved).toString() } }, { merge: true });
                transaction.set(jobRef, { topUpHash: hash, topUpAmount: job.topUpAmount, topUpSigned: signed,
                    topUpStation: station, topUpChild: child, topUpState: 'Pending',
                    topUpReserved: job.topUpReserved }, { merge: true });
                transaction.set(lockRef, { pendingHash: hash, pendingJob: jobRef.id }, { merge: true });
            });
        }
        if (job.topUpChild !== child) throw new Error('Pending top-up destination changed');
        let outcome = await d3TopUpReceipt(network, job);
        if (outcome === null) {
            try {
                if (bsc) await d2RPC(() => d2Bsc().broadcastTransaction(job.topUpSigned));
                else await d2RPC(() => d2Tron().trx.sendRawTransaction(JSON.parse(job.topUpSigned)));
            } catch (error) {}
            for (let attempt = 0; attempt < 30 && outcome === null; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 3000));
                outcome = await d3TopUpReceipt(network, job);
            }
        }
        if (outcome === null) throw new Error('Top-up confirmation pending');
        await db.runTransaction(async transaction => {
            const current = await transaction.get(jobRef);
            const lock = await transaction.get(lockRef);
            if (!current.exists || current.data().topUpHash !== job.topUpHash ||
                !lock.exists || lock.data().lease !== stationLease) throw new Error('Gas lease changed');
            if (current.data().lease !== lease) throw new Error('Sweep lease changed');
            if (outcome) {
                transaction.set(jobRef, { topUpState: 'Confirmed' }, { merge: true });
            } else {
                const failures = (Number(current.data().topUpFailures) || 0) + 1;
                const review = failures >= 3;
                transaction.set(db.collection('Gas_Station_TopUp_Attempts').doc(network + '_' + job.topUpHash), {
                    Job_ID: jobRef.id, Hash: job.topUpHash, Amount: job.topUpAmount,
                    Reserved: job.topUpReserved, State: 'Failed', Attempt: failures,
                    Checked_At: FieldValue.serverTimestamp()
                }, { merge: true });
                transaction.set(jobRef, {
                    ...d3TopUpClear(), topUpFailures: failures, topUpReviewRequired: review
                }, { merge: true });
            }
            transaction.set(lockRef, { pendingHash: FieldValue.delete(), pendingJob: FieldValue.delete() }, { merge: true });
        });
        if (!outcome) {
            const updated = await jobRef.get();
            throw new Error(updated.data().topUpReviewRequired ? 'Top-up review required' : 'Top-up retry scheduled');
        }
        if (await d3NativeBalance(network, child) < neededGas) throw new Error('Native gas insufficient');
    } finally {
        if (acquired) {
            await db.runTransaction(async transaction => {
                const lock = await transaction.get(lockRef);
                if (lock.exists && lock.data().lease === stationLease) {
                    transaction.set(lockRef, { leaseUntil: 0 }, { merge: true });
                }
            });
        }
    }
}

async function d2SweepLeaseWrite(jobRef, lease, patch, txRef, txPatch) {
    return db.runTransaction(async transaction => {
        const current = await transaction.get(jobRef);
        if (!current.exists || current.data().lease !== lease) throw new Error('Sweep lease changed');
        transaction.set(jobRef, patch, { merge: true });
        if (txRef && txPatch) transaction.update(txRef, txPatch);
    });
}
async function d2SweepReceipt(network, hash, master, child, rawAmount) {
    if (network === 'BEP20') {
        const receipt = await s4BscReceipt(hash);
        if (!receipt) return null;
        if (receipt.status === 0) return false;
        if (d2TransferRaw(receipt.logs, network, master, child) !== rawAmount) throw new Error('Sweep receipt mismatch');
        return { blockNumber: receipt.blockNumber };
    }
    const body = await s4TronBody(hash);
    if (!body?.ret?.[0]?.contractRet) return null;
    if (body.ret[0].contractRet !== 'SUCCESS') return false;
    const info = await d2RPC(() => d2Tron().solidityNode.request(
        'walletsolidity/gettransactioninfobyid', { value: hash }, 'post'));
    if (!info?.receipt?.result || String(info.id || '').toLowerCase() !== hash) return null;
    if (info.receipt.result !== 'SUCCESS') throw new Error('Sweep receipt mismatch');
    if (d2TransferRaw(info.log, network, master, child) !== rawAmount) throw new Error('Sweep receipt mismatch');
    return { blockNumber: info.blockNumber };
}
function s4SweepFailure(error) {
    const message = String(error?.message || '');
    const gas = new Set(['Top-up cap exceeded', 'Daily gas cap exceeded',
        'Gas station reserve insufficient', 'Native gas insufficient', 'Energy exceeds fee limit']);
    const review = new Set(['Wrong chain', 'Sweep address conflict', 'Signing address conflict',
        'Gas station address conflict', 'Pending sweep destination changed', 'Pending top-up destination changed',
        'Native receipt mismatch', 'Sweep receipt mismatch', 'Receipt hash mismatch', 'Unexpected native transfer',
        'Native transaction encoding mismatch', 'Unsigned transaction encoding mismatch',
        'Unexpected unsigned transfer', 'Token transfer would fail', 'Invalid gas cap', 'Invalid fee limit', 'Top-up review required']);
    const pending = new Set(['Top-up confirmation pending', 'Sweep confirmation pending',
        'Gas station busy', 'Sweep lease changed', 'Gas lease changed', 'Top-up retry scheduled']);
    const status = review.has(message) ? 'Sweep_Review_Required' : gas.has(message) ? 'Sweep_Pending_Gas' : 'Pending_Sweep';
    const safeMessage = gas.has(message) || review.has(message) || pending.has(message)
        ? message : 'RPC or chain data unavailable; saved transaction retained';
    return { Sweep_Status: status, Sweep_Error_Code: safeMessage === message
        ? message.toUpperCase().replace(/[^A-Z0-9]+/g, '_') : 'SWEEP_RPC_UNAVAILABLE',
        Sweep_Error_Message: safeMessage, Sweep_Last_Attempt_At: FieldValue.serverTimestamp() };
}
async function d2RunSweep({ uid, index, network, txDocId, retry = 0 }) {
    const txRef = db.collection('Transactions').doc(txDocId);
    const jobRef = db.collection('Deposit_Sweep_Jobs').doc(network + '_' + uid);
    const lease = tcmAuthCrypto.randomUUID();
    let claimed = false;
    try {
        const claim = await db.runTransaction(async transaction => {
            const job = await transaction.get(jobRef);
            const deposit = await transaction.get(txRef);
            if (!deposit.exists || deposit.data().UID !== uid || deposit.data().Network !== network ||
                deposit.data().Verified_OnChain !== true || deposit.data().Status !== 'Success' ||
                deposit.data().Deposit_Wallet_Index !== index ||
                ['Swept', 'Sweep_Review_Required'].includes(deposit.data().Sweep_Status)) return null;
            const row = job.exists ? job.data() : {};
            if (Number(row.leaseUntil || 0) > Date.now()) return { busy: true };
            transaction.set(jobRef, { lease, leaseUntil: Date.now() + 240000 }, { merge: true });
            return { job: row, deposit: deposit.data() };
        });
        if (!claim) return;
        if (claim.busy) {
            if (retry < 10) {
                const timer = setTimeout(() => scheduleDepositSweep({
                    uid, index, network, txDocId, retry: retry + 1
                }), 30000);
                timer.unref?.();
            }
            return;
        }
        claimed = true;
        let job = claim.job;
        if (job.topUpReviewRequired) throw new Error('Top-up review required');
        let master = network === 'BEP20' ? process.env.ADMIN_MASTER_BEP20 : process.env.ADMIN_MASTER_TRC20;
        try {
            if (network === 'BEP20') {
                master = hdEthers.getAddress(master);
                if (master === hdEthers.ZeroAddress) throw new Error('Zero address');
            } else {
                if (!master || !hdTronWeb.isAddress(master) || master === 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb') {
                    throw new Error('Invalid master');
                }
                master = hdTronWeb.address.fromHex(hdTronWeb.address.toHex(master));
            }
        } catch (error) {
            await d2SweepLeaseWrite(jobRef, lease, { leaseUntil: 0 }, txRef,
                { Sweep_Status: 'Master_Not_Configured' });
            return;
        }

        const expected = hdDepositDerive(index);
        const child = network === 'BEP20' ? expected.Deposit_BEP20 : expected.Deposit_TRC20;
        if (master === child || claim.deposit.Deposit_Address !== child) throw new Error('Sweep address conflict');
        if (network === 'BEP20' && (await d2RPC(() => d2Bsc().getNetwork())).chainId !== 56n) {
            throw new Error('Wrong chain');
        }
        if (job.pendingHash && (job.master !== master || job.child !== child)) {
            throw new Error('Pending sweep destination changed');
        }
        if (job.topUpHash) {
            await d3EnsureGas({ network, child, jobRef, lease, neededGas: 0n });
        }

        if (!job.pendingHash) {
            // Confirm capped station top-ups before signing the USDT sweep.
            // Signing keys exist only in this function's memory.
            let rawAmount, signed, hash;
            if (network === 'BEP20') {
                const provider = d2Bsc();
                const signer = hdEthers.HDNodeWallet.fromPhrase(
                    process.env.HD_MASTER_MNEMONIC, '', `m/44'/60'/0'/0/${index}`
                ).connect(provider);
                if (signer.address !== child) throw new Error('Signing address conflict');
                const token = new hdEthers.Contract(d2BscUsdt, d2TokenABI, signer);
                rawAmount = await d2RPC(() => token.balanceOf(child));
                if (rawAmount > 0n) {
                    const gasPrice = (await d2RPC(() => provider.getFeeData())).gasPrice;
                    if (!gasPrice || gasPrice <= 0n) throw new Error('Gas price unavailable');
                    if (await d2RPC(() => token.transfer.staticCall(master, rawAmount)) !== true) {
                        throw new Error('Token transfer would fail');
                    }
                    const estimate = await d2RPC(() => token.transfer.estimateGas(master, rawAmount, { gasPrice: 0n }));
                    const gasLimit = (estimate * 120n + 99n) / 100n;
                    await d3EnsureGas({ network, child, jobRef, lease, neededGas: gasLimit * gasPrice });
                    const nonce = await d2RPC(() => provider.getTransactionCount(child, 'pending'));
                    const request = await token.transfer.populateTransaction(master, rawAmount, {
                        type: 0, chainId: 56, gasPrice, gasLimit, nonce
                    });
                    signed = await signer.signTransaction(request);
                    hash = hdEthers.keccak256(signed);
                }
            } else {
                const tron = d2Tron();
                const read = await d2RPC(() => tron.transactionBuilder.triggerConfirmedConstantContract(
                    d2TronUsdt, 'balanceOf(address)', {},
                    [{ type: 'address', value: child }], child
                ));
                const word = read.constant_result?.[0];
                if (!/^[0-9a-fA-F]{64}$/.test(word || '')) throw new Error('Token balance unavailable');
                rawAmount = BigInt('0x' + word);
                if (rawAmount > 0n) {
                    const feeLimit = Number(process.env.TRON_SWEEP_FEE_LIMIT || 150000000);
                    if (!Number.isSafeInteger(feeLimit) || feeLimit < 1 || feeLimit > 15000000000) {
                        throw new Error('Invalid fee limit');
                    }
                    const parameters = [
                        { type: 'address', value: master }, { type: 'uint256', value: rawAmount.toString() }
                    ];
                    const simulation = await d2RPC(() => tron.transactionBuilder.triggerConstantContract(
                        d2TronUsdt, 'transfer(address,uint256)', {}, parameters, child
                    ));
                    const resources = await d2RPC(() => tron.trx.getAccountResources(child));
                    const prices = await d2RPC(() => tron.trx.getChainParameters());
                    const energyPrice = Number(prices.find(row => row.key === 'getEnergyFee')?.value);
                    const bandwidthPrice = Number(prices.find(row => row.key === 'getTransactionFee')?.value);
                    const energy = Number(simulation.energy_used);
                    const transferResult = simulation.constant_result?.[0];
                    if (!simulation.result?.result || !/^[0-9a-fA-F]{64}$/.test(transferResult || '') ||
                        BigInt('0x' + transferResult) !== 1n || !Number.isSafeInteger(energy) || energy < 1 ||
                        !Number.isSafeInteger(energyPrice) || energyPrice < 1 ||
                        !Number.isSafeInteger(bandwidthPrice) || bandwidthPrice < 1) {
                        throw new Error('Gas estimate unavailable');
                    }
                    const availableEnergy = Math.max(0, Number(resources.EnergyLimit || 0) - Number(resources.EnergyUsed || 0));
                    const availableBandwidth = Math.max(0, Number(resources.freeNetLimit || 0) - Number(resources.freeNetUsed || 0)) +
                        Math.max(0, Number(resources.NetLimit || 0) - Number(resources.NetUsed || 0));
                    const burnEnergy = Math.max(0, Math.ceil(energy * 1.2) - availableEnergy);
                    if (!Number.isSafeInteger(burnEnergy) || !Number.isFinite(availableBandwidth)) {
                        throw new Error('Gas resources unavailable');
                    }
                    const energyCost = BigInt(burnEnergy) * BigInt(energyPrice);
                    const bandwidthCost = BigInt(Math.max(0, Math.ceil(1000 - availableBandwidth))) * BigInt(bandwidthPrice);
                    if (energyCost > BigInt(feeLimit)) throw new Error('Energy exceeds fee limit');
                    await d3EnsureGas({ network, child, jobRef, lease,
                        neededGas: energyCost + bandwidthCost + 1000000n });
                    const wrapper = await d2RPC(() => tron.transactionBuilder.triggerSmartContract(
                        d2TronUsdt, 'transfer(address,uint256)', { feeLimit, callValue: 0 },
                        [{ type: 'address', value: master }, { type: 'uint256', value: rawAmount.toString() }], child
                    ));
                    const unsigned = wrapper.transaction;
                    const calls = unsigned?.raw_data?.contract;
                    const value = calls?.[0]?.parameter?.value;
                    const calldata = 'a9059cbb' + d2TronHex(master).padStart(64, '0') +
                        rawAmount.toString(16).padStart(64, '0');
                    if (!wrapper.result?.result || calls.length !== 1 ||
                        calls[0].type !== 'TriggerSmartContract' ||
                        d2TronHex(value.contract_address) !== d2TronHex(d2TronUsdt) ||
                        d2TronHex(value.owner_address) !== d2TronHex(child) ||
                        String(value.data).toLowerCase() !== calldata ||
                        Number(value.call_value || 0) !== 0 || Number(value.call_token_value || 0) !== 0 ||
                        unsigned.raw_data.fee_limit !== feeLimit) throw new Error('Unexpected unsigned transfer');
                    const transactionUtils = (tron.utils || require('tronweb').utils).transaction;
                    const proto = transactionUtils.txJsonToPb({ raw_data: unsigned.raw_data });
                    const canonicalHash = String(transactionUtils.txPbToTxID(proto)).replace(/^0x/, '').toLowerCase();
                    if (!/^(?:[0-9a-fA-F]{2})+$/.test(unsigned.raw_data_hex || '') ||
                        d2Hash(network, unsigned.txID).txHash !== canonicalHash ||
                        hdEthers.sha256('0x' + unsigned.raw_data_hex).slice(2).toLowerCase() !== canonicalHash) {
                        throw new Error('Unsigned transaction encoding mismatch');
                    }
                    const signer = hdEthers.HDNodeWallet.fromPhrase(
                        process.env.HD_MASTER_MNEMONIC, '', `m/44'/195'/0'/0/${index}`
                    );
                    if (hdTronWeb.address.fromPrivateKey(signer.privateKey.slice(2)) !== child) {
                        throw new Error('Signing address conflict');
                    }
                    const transaction = await tron.trx.sign(unsigned, signer.privateKey.slice(2));
                    hash = d2Hash(network, transaction.txID).txHash;
                    signed = JSON.stringify(transaction);
                }
            }
            if (rawAmount <= 0n) {
                const patch = job.lastHash && claim.deposit.Deposit_Block_Number <= job.lastBlockNumber
                    ? { Sweep_Status: 'Swept', Sweep_TxHash: job.lastHash, Swept_At: FieldValue.serverTimestamp() }
                    : { Sweep_Status: 'Sweep_Pending_Gas' };
                await d2SweepLeaseWrite(jobRef, lease, {
                    ...(patch.Sweep_Status === 'Swept' ? d3TopUpClear() : {}), leaseUntil: 0
                }, txRef, patch);
                return;
            }
            job = { ...job, pendingHash: hash, signed, rawAmount: rawAmount.toString(),
                ownerTx: txDocId, master, child };
            // Persist the immutable signed transaction before broadcasting.
            // This is public transaction data, not a mnemonic or private key.
            await d2SweepLeaseWrite(jobRef, lease, {
                pendingHash: hash, signed, rawAmount: job.rawAmount, ownerTx: txDocId, master, child
            }, txRef, { Sweep_Status: 'Pending_Sweep', Sweep_TxHash: hash });
        }

        let outcome = await d2SweepReceipt(network, job.pendingHash, master, child, BigInt(job.rawAmount));
        if (outcome === null) {
            try {
                if (network === 'BEP20') await d2RPC(() => d2Bsc().broadcastTransaction(job.signed));
                else await d2RPC(() => d2Tron().trx.sendRawTransaction(JSON.parse(job.signed)));
            } catch (error) {
                // An already-broadcast transaction is reconciled by its saved hash.
            }
            for (let attempt = 0; attempt < 30 && outcome === null; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 3000));
                outcome = await d2SweepReceipt(network, job.pendingHash, master, child, BigInt(job.rawAmount));
            }
        }
        // Missing TRON body/receipt is inconclusive, even after transaction expiration.
        // Retain the signed transaction and hash for reconciliation; never infer failure.
        if (outcome === null) throw new Error('Sweep confirmation pending');
        const ownerRef = db.collection('Transactions').doc(job.ownerTx);
        const owner = await ownerRef.get();
        const failures = (Number(owner.exists ? owner.data().Sweep_Failures : 0) || 0) + (outcome ? 0 : 1);
        const finalPatch = outcome
            ? { Sweep_Status: 'Swept', Sweep_TxHash: job.pendingHash, Swept_At: FieldValue.serverTimestamp() }
            : { Sweep_Status: failures >= 3 ? 'Sweep_Review_Required' : 'Sweep_Pending_Gas',
                Sweep_Failures: failures, Sweep_TxHash: job.pendingHash };
        await d2SweepLeaseWrite(jobRef, lease, {
            pendingHash: FieldValue.delete(), signed: FieldValue.delete(),
            rawAmount: FieldValue.delete(), ownerTx: FieldValue.delete(), ...d3TopUpClear(),
            ...(outcome ? { lastHash: job.pendingHash, lastBlockNumber: outcome.blockNumber,
                topUpFailures: 0, topUpReviewRequired: false } : {}), leaseUntil: 0
        }, ownerRef, { ...finalPatch,
            Sweep_Error_Code: outcome ? FieldValue.delete() : 'SWEEP_TRANSACTION_FAILED',
            Sweep_Error_Message: outcome ? FieldValue.delete() : 'Confirmed sweep failed; retry limit applies',
            Sweep_Last_Attempt_At: FieldValue.serverTimestamp()
        });
        if (job.ownerTx !== txDocId) scheduleDepositSweep({ uid, index, network, txDocId });
    } catch (error) {
        if (claimed) {
            try {
                const failure = s4SweepFailure(error);
                await d2SweepLeaseWrite(jobRef, lease, { leaseUntil: 0 }, txRef, failure);
            } catch (writeError) {}
        }
        console.warn('[DEPOSIT SWEEP] ' + s4SweepFailure(error).Sweep_Error_Code + '; credited wallet is unchanged.');
    }
}

let d2SweepWorkerBusy = false, d2SweepCursor = '';
async function d2ResumeSweepBatch() {
    if (d2SweepWorkerBusy || !hdDepositConfig ||
        (!process.env.ADMIN_MASTER_BEP20 && !process.env.ADMIN_MASTER_TRC20)) return;
    d2SweepWorkerBusy = true;
    try {
        let query = db.collection('Transactions')
            .where('Sweep_Status', 'in', ['Pending_Sweep', 'Sweep_Pending_Gas', 'Master_Not_Configured'])
            .orderBy(m1FieldPath.documentId()).limit(20);
        if (d2SweepCursor) query = query.startAfter(d2SweepCursor);
        const rows = await query.get();
        for (const doc of rows.docs) {
            const row = doc.data();
            if (row.Verified_OnChain === true && hdDepositIndex(row.Deposit_Wallet_Index) &&
                ['BEP20', 'TRC20'].includes(row.Network)) {
                scheduleDepositSweep({ uid: row.UID, index: row.Deposit_Wallet_Index,
                    network: row.Network, txDocId: doc.id });
            }
        }
        d2SweepCursor = rows.size === 20 ? rows.docs[rows.size - 1].id : '';
    } catch (error) {
        console.warn('[DEPOSIT SWEEP] Background retry deferred.');
    } finally { d2SweepWorkerBusy = false; }
}
const d2SweepRetryTimer = setInterval(() => { void d2ResumeSweepBatch(); }, 300000);
d2SweepRetryTimer.unref?.();
setImmediate(() => { void d2ResumeSweepBatch(); });

app.post('/api/finance/withdraw', async (req, res) => {
    try {
        // MEMO TCM-FIN-013 | 2026-10-10 01:37 IST | Asia/Kolkata
        const uid = req.authenticatedUid;

        if (typeof uid !== "string" || !uid.trim() || uid.includes("/")) {
            return res.status(401).json({
                success: false,
                message: "Authenticated account is required."
            });
        }

        if (req.body.uid !== undefined && req.body.uid !== uid) {
            return res.status(403).json({
                success: false,
                message: "Account ownership mismatch."
            });
        }

        const network = req.body.network || req.body.net;
        const code2FA = req.body.code2FA || req.body.code;
        let address; // Destination is resolved from the authenticated user's Firestore record.
        const rawAmount = req.body.amount;

        if (
            (typeof rawAmount !== "number" && typeof rawAmount !== "string") ||
            !/^\d+(?:\.\d+)?$/.test(String(rawAmount).trim())
        ) {
            throw new Error("Invalid Amount!");
        }

        const amount = admS2Money(admS2Micro(rawAmount, 'withdrawal amount', false));
        if (!['BEP20', 'TRC20'].includes(network)) throw admS2Error('Unsupported withdrawal network.');

        // Monthly quota is checked against the wallet inside the financial transaction.

        const uSnapCheck = await db.collection("Users").doc(uid).get();
        const uDataCheck = uSnapCheck.data();
        if (uDataCheck.Security_Date) {
            let targetTime = uDataCheck.Security_Date.toDate().getTime() + (72 * 3600000);
            let remainingTime = targetTime - Date.now();
            if (remainingTime > 0) {
                return res.json({ success: false, isLocked: true, targetTime, remainingTime, message: "Security lock active for 72 hours following security changes." });
            }
        }

        await db.runTransaction(async (t) => {
            const uRef = db.collection("Users").doc(uid);
            const wRef = db.collection("Wallets").doc(uid);
            
            const uData = (await t.get(uRef)).data();
            const wData = (await t.get(wRef)).data();
            if (!uData || !wData) throw q4Error('Account or wallet unavailable.', 401);
            if (uData.Status === 'Banned' || uData.Account_Deleted) throw q4Error('Account access is blocked.', 403);
            if (uData.Security_Date && uData.Security_Date.toMillis() + 72 * 3600000 > Date.now()) {
                throw admS2Error('Security lock active for 72 hours following security changes.');
            }
            address = await c2Destination(t, network, uData[network === 'BEP20' ? 'Wallet_BEP20' : 'Wallet_TRC20']);
            const supplied = req.body.address || req.body.boundAddr;
            if (supplied !== undefined && c2Address(network, supplied) !== address) throw admS2Error('Bound wallet changed. Refresh and retry.', 409);
            const quotaWindow = q4Month();
            const monthlyQuota = await q4ReadQuota(t, wRef, wData, uid, quotaWindow);
            // MEMO TCM-FIN-013-S3 | 2026-10-10 01:54 IST | Asia/Kolkata
            const treasuryRef = db.collection("Admin_Data").doc("TCM_TREASURY");
            const treasurySnapshot = await t.get(treasuryRef);
            const treasury = treasurySnapshot.exists ? treasurySnapshot.data() : {};
            for (const field of ["Withdrawal_Fee_Wallet", "Total_Revenue", "Withdrawal_Pending_Fees"]) {
                const value = treasury[field] === undefined ? 0 : treasury[field];
                if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
                    throw new Error("Invalid treasury balance: " + field);
                }
            }

            if (!uData["2FA_Key"]) throw new Error("Please bind Google 2FA first!");
            let is2FAValid = false;
            try {
                is2FAValid = authenticator.verify({ token: String(code2FA), secret: uData["2FA_Key"] });
            } catch(err) {
                if (typeof authenticator.check === 'function') is2FAValid = authenticator.check(String(code2FA), uData["2FA_Key"]);
            }
            if (!is2FAValid) throw new Error("Invalid 2FA Code!");

            const withdrawalMicro = admS2Micro(rawAmount, 'withdrawal amount', false);
            const mainMicro = admS2Balance(wData, 'Main_Balance');
            if (mainMicro < withdrawalMicro) throw new Error("Insufficient Balance!");

            // 🔥 HEALTH PROTOCOL VALIDATION
            const tDep = admS2Balance(wData, 'Total_Deposit');
            const tWd = admS2Balance(wData, 'Total_Withdraw');
            const tTeamDep = admS2Balance(wData, 'Total_Team_Deposit');
            let health = 100;
            if (tWd > 0n) {
                const score = ((tDep * 10n + tTeamDep) * 10n) / tWd;
                health = Number(score > 100n ? 100n : score);
            }
            if (tWd > tDep && tTeamDep < 100000000n) health = Math.min(health, 35);
            
            if (health < 40) {
                throw new Error("Health Protocol Active. Your ecosystem needs new deposits to process further withdrawals.");
            }
            if (health >= 40 && health <= 49) {
                if (amount !== 25) {
                    throw new Error(`Emergency Quota Active: You can only withdraw exactly $25. Your health is ${health}%.`);
                }
            }

            const feeConfig = c2Fees(treasury);
            c2CheckVersion(req, feeConfig);
            const quote = c2Quote(rawAmount, feeConfig[network === 'BEP20' ? 'wdFeePctBEP20' : 'wdFeePctTRC20']);
            const fee = quote.fee, netAmount = quote.net;
            req.withdrawalQuote = { Fee: fee, Net_Amount: netAmount, Fee_Rate_Pct: quote.Fee_Rate_Pct, Fee_Config_Version: feeConfig.version };
            const feeMicro = BigInt(quote.Fee_micro);
            const withdrawalTreasuryUpdates = {};
            for (const field of ["Withdrawal_Fee_Wallet", "Total_Revenue", "Withdrawal_Pending_Fees"]) {
                withdrawalTreasuryUpdates[field] = admS2Money(admS2Balance(treasury, field) + feeMicro);
            }
            const newMainBal = admS2Money(mainMicro - withdrawalMicro);

            let wUpdates = {
                Main_Balance: newMainBal,
                Total_Withdraw: admS2Money(admS2Balance(wData, 'Total_Withdraw') + withdrawalMicro),
                Monthly_Quota: q4TakeSlot(monthlyQuota, 'withdraw')
            };
            let uUpdates = { "counters.txCount": nextStakingTxCount(uData) };

            let rankRes = calculateRankUpdates(uData, moneyV7NextView(wData, { Main_Balance: newMainBal }));
            if (rankRes.Rank !== undefined) uUpdates.Rank = rankRes.Rank;
            if (rankRes.Points !== undefined) wUpdates.Points = rankRes.Points;

            t.update(wRef, moneyV7Updates(wData, { ...wUpdates, ...t8MainEntry(t, uid, wData, newMainBal, 'Withdrawal held', req.generatedOrderId || 'Withdrawal request') }, 'Wallet', 'update'));
            if (Object.keys(uUpdates).length > 0) t.update(uRef, uUpdates);
            
            // 🚀 FIX: Document ID জেনারেট করে ফ্রন্টএন্ডের জন্য ধরে রাখা হচ্ছে
            let generatedTxDate = new Date().toISOString();
            const txRef = db.collection("Transactions").doc();
            req.generatedTxId = txRef.id;
            req.generatedOrderId = generateOrderId('WD');
            const feeLedgerRef = db.collection("Transactions").doc(`TX-FEE-${req.generatedOrderId}`);

            t.set(treasuryRef, moneyV7Updates(treasury, withdrawalTreasuryUpdates, 'Treasury', 'merge'), { merge: true });

            t.set(feeLedgerRef, {
                id: feeLedgerRef.id,
                UID: "TCM_TREASURY",
                Type: "Withdrawal Fee",
                Amount: fee,
                Direction: "Credit",
                Status: "Success",
                Order_ID: req.generatedOrderId,
                Source_UID: uid,
                Related_Transaction_ID: txRef.id,
                Fee_Cycle: 0,
                Date: generatedTxDate,
                timestamp: FieldValue.serverTimestamp()
            });

            t.set(txRef, t9Record(t, {
                Date: generatedTxDate, UID: uid, Type: "Withdraw",
                Amount: amount, Amount_micro: withdrawalMicro.toString(), Fee: fee, Net_Amount: netAmount,
                Net_Amount_micro: (withdrawalMicro - feeMicro).toString(),
                Fee_Rate_Pct: quote.Fee_Rate_Pct, Fee_Config_Version: feeConfig.version, Fee_micro: quote.Fee_micro,
                Network: network, Destination: address, Status: "Pending",
                Quota_Month: quotaWindow.key,
                Quota_Count_State: 'Counted',
                Order_ID: req.generatedOrderId,
                Fee_Treasury_State: "Held",
                Fee_Cycle: 0,
                timestamp: FieldValue.serverTimestamp()
            }));
        });
        await clearUserCache(uid);
        
        // 🚀 Return Real-time Data for Frontend Injection & Cancel Button
        res.json({ 
            success: true, 
            data: { id: req.generatedTxId, Order_ID: req.generatedOrderId, Date: new Date().toISOString(), ...req.withdrawalQuote }
        });
    } catch (e) {
        res.status(e.statusCode || 400).json({ success: false, message: e.message });
    }
});

// =========================================================
// 🛑 USER WITHDRAWAL CANCELLATION & INSTANT REFUND API
// =========================================================
// MEMO TCM-FIN-013-S3 | 2026-10-10 01:54 IST | Asia/Kolkata
const withdrawalActionHandler = async (req, res) => {
    try {
        const actorUid = req.authenticatedUid;
        if (!actorUid) return res.status(401).json({ success: false, message: 'Authentication required.' });
        const action = req.path === '/api/finance/cancel-withdrawal'
            ? 'cancel'
            : (req.path === '/api/finance/reverse-withdrawal' ? 'reverse' : req.body.action);
        if (!['approve', 'reject', 'vault', 'reverse', 'cancel'].includes(action)) {
            throw new Error('Invalid withdrawal action.');
        }
        const identifier = action === 'cancel' ? req.body.txId : req.body.docId;
        if (typeof identifier !== 'string' || !identifier.trim() || identifier.includes('/')) {
            throw new Error('Invalid withdrawal identifier.');
        }
        if (action === 'cancel' && req.body.uid !== undefined && req.body.uid !== actorUid) {
            return res.status(403).json({ success: false, message: 'Account ownership mismatch.' });
        }
        const outcome = await db.runTransaction(async (t) => {
            const actorRef = db.collection('Users').doc(actorUid);
            const actor = await t.get(actorRef);
            if (!actor.exists || (action !== 'cancel' && actor.data().Role !== 'Admin')) {
                const error = new Error('Administrator privileges required.');
                error.httpStatus = 403;
                throw error;
            }
            let txRef;
            let txSnap;
            if (action === 'cancel' && identifier.startsWith('WD-')) {
                const matches = await t.get(db.collection('Transactions')
                    .where('Order_ID', '==', identifier).limit(2));
                if (matches.size !== 1) throw new Error('Withdrawal order not found or ambiguous.');
                txSnap = matches.docs[0];
                txRef = txSnap.ref;
            } else {
                txRef = db.collection('Transactions').doc(identifier);
                txSnap = await t.get(txRef);
            }
            if (!txSnap.exists) throw new Error('Withdrawal not found.');
            const withdrawal = txSnap.data();
            if (withdrawal.Type !== 'Withdraw') throw new Error('Not a withdrawal.');
            const uid = withdrawal.UID;
            if (typeof uid !== 'string' || !uid || uid.includes('/')) throw new Error('Invalid withdrawal owner.');
            if (action === 'cancel' && uid !== actorUid) {
                const error = new Error('You do not own this withdrawal.');
                error.httpStatus = 403;
                throw error;
            }
            const expectedStatus = action === 'reverse' ? 'Rejected' : 'Pending';
            if (withdrawal.Status !== expectedStatus) throw new Error('Withdrawal status no longer permits this action.');
            if (action === 'reverse' && withdrawal.Refund_State !== 'Refunded') {
                throw new Error('A confirmed refunded rejection is required.');
            }
            const amountMicro = moneyV7Amount(withdrawal, 'Amount', 'Amount_micro', 'withdrawal amount');
            if (amountMicro <= 0n) throw new Error('Invalid withdrawal amount.');
            const amount = admS2Money(amountMicro);
            const walletRef = db.collection('Wallets').doc(uid);
            const userRef = db.collection('Users').doc(uid);
            const treasuryRef = db.collection('Admin_Data').doc('TCM_TREASURY');
            const walletSnap = await t.get(walletRef);
            const userSnap = await t.get(userRef);
            const treasurySnap = await t.get(treasuryRef);
            if (!walletSnap.exists || !userSnap.exists) throw new Error('Withdrawal account missing.');
            const wallet = walletSnap.data();
            const numeric = (value, label) =>
                moneyV1ReadLegacy(value === undefined ? 0 : value, label).micro;
            const main = admS2Balance(wallet, 'Main_Balance');
            const locked = admS2Balance(wallet, 'Locked_Balance');
            const totalWd = wallet.Money_Version === undefined
                ? numeric(wallet.Total_Withdraw ?? wallet.Total_Withdrawal, 'withdraw total')
                : admS2Balance(wallet, 'Total_Withdraw');
            const now = Date.now();
            const notes = typeof req.body.adminNote === 'string' ? req.body.adminNote.trim().slice(0, 1000) : '';
            const walletUpdates = {};
            const txUpdates = {};
            let treasuryUpdates = null;
            let feeLedgerRef = null;
            let feeLedgerData = null;
            const routed = withdrawal.Fee_Treasury_State !== undefined;
            const cycle = withdrawal.Fee_Cycle === undefined ? 0 : withdrawal.Fee_Cycle;
            if (!Number.isSafeInteger(cycle) || cycle < 0 || cycle >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid fee cycle.');
            const orderId = withdrawal.Order_ID;
            if (routed && (typeof orderId !== 'string' || !orderId || orderId.includes('/'))) throw new Error('Invalid fee order ID.');
            if (routed) {
                const feeMicro = moneyV7Amount(withdrawal, 'Fee', 'Fee_micro', 'withdrawal fee');
                if (feeMicro <= 0n || feeMicro >= amountMicro) throw new Error('Invalid withdrawal fee.');
                const fee = admS2Money(feeMicro);
                const creditId = cycle === 0 ? `TX-FEE-${orderId}` : `TX-FEE-REOPEN-${orderId}-${cycle}`;
                const creditSnap = await t.get(db.collection('Transactions').doc(creditId));
                if (action !== 'reverse' && (!creditSnap.exists || creditSnap.data().Amount !== fee || creditSnap.data().Related_Transaction_ID !== txRef.id)) {
                    throw new Error('Withdrawal fee credit evidence missing.');
                }
                const treasury = treasurySnap.exists ? treasurySnap.data() : {};
                const feeWallet = admS2Balance(treasury, 'Withdrawal_Fee_Wallet');
                const revenue = admS2Balance(treasury, 'Total_Revenue');
                const reserve = admS2Balance(treasury, 'Withdrawal_Pending_Fees');
                const subtract = (balance, value) => {
                    if (balance < value) throw new Error('Treasury fee reconciliation required.');
                    return admS2Money(balance - value);
                };
                if (action === 'reverse') {
                    if (withdrawal.Fee_Treasury_State !== 'Reversed') throw new Error('Fee was not reversed.');
                    const priorReversalId = cycle === 0 ? `TX-FEE-REV-${orderId}` : `TX-FEE-REV-${orderId}-${cycle}`;
                    const priorReversal = await t.get(db.collection('Transactions').doc(priorReversalId));
                    if (!priorReversal.exists || priorReversal.data().Amount !== fee || priorReversal.data().Related_Transaction_ID !== txRef.id) throw new Error('Fee reversal evidence missing.');
                    const nextCycle = cycle + 1;
                    feeLedgerRef = db.collection('Transactions').doc(`TX-FEE-REOPEN-${orderId}-${nextCycle}`);
                    const duplicate = await t.get(feeLedgerRef);
                    if (duplicate.exists) throw new Error('Fee reopening already recorded.');
                    treasuryUpdates = {
                        Withdrawal_Fee_Wallet: admS2Money(feeWallet + feeMicro),
                        Total_Revenue: admS2Money(revenue + feeMicro),
                        Withdrawal_Pending_Fees: admS2Money(reserve + feeMicro)
                    };
                    txUpdates.Fee_Cycle = nextCycle;
                    txUpdates.Fee_Treasury_State = 'Held';
                    feeLedgerData = { Type: 'Withdrawal Fee Reopened', Amount: fee, Direction: 'Credit' };
                } else {
                    if (withdrawal.Fee_Treasury_State !== 'Held') throw new Error('Withdrawal fee is not held.');
                    treasuryUpdates = { Withdrawal_Pending_Fees: subtract(reserve, feeMicro) };
                    if (action === 'approve') {
                        txUpdates.Fee_Treasury_State = 'Earned';
                    } else {
                        feeLedgerRef = db.collection('Transactions').doc(cycle === 0 ? `TX-FEE-REV-${orderId}` : `TX-FEE-REV-${orderId}-${cycle}`);
                        const duplicate = await t.get(feeLedgerRef);
                        if (duplicate.exists) throw new Error('Fee reversal already recorded.');
                        treasuryUpdates.Withdrawal_Fee_Wallet = subtract(feeWallet, feeMicro);
                        treasuryUpdates.Total_Revenue = subtract(revenue, feeMicro);
                        txUpdates.Fee_Treasury_State = 'Reversed';
                        feeLedgerData = { Type: 'Withdrawal Fee Reversal', Amount: fee, Direction: 'Debit' };
                    }
                }
                for (const value of Object.values(treasuryUpdates)) {
                    if (!Number.isFinite(value)) throw new Error('Treasury balance overflow.');
                }
            }
            if (action === 'approve') {
                Object.assign(txUpdates, { Status: 'Success', status: 'Success', Approved_At: FieldValue.serverTimestamp() });
            } else if (action === 'reverse') {
                const clawedBackMicro = main < amountMicro ? main : amountMicro;
                const debtAddedMicro = amountMicro - clawedBackMicro;
                const clawedBack = admS2Money(clawedBackMicro);
                Object.assign(walletUpdates, {
                    Main_Balance: admS2Money(main - clawedBackMicro),
                    Debt: admS2Money(admS2Balance(wallet, 'Debt') + debtAddedMicro),
                    Total_Withdraw: admS2Money(totalWd + amountMicro),
                    Total_Withdrawal: admS2Money(totalWd + amountMicro)
                });
                Object.assign(txUpdates, { Status: 'Pending', status: 'Pending', Refund_State: 'Clawed_Back', Reversed_At: FieldValue.serverTimestamp(), Audit_Trail: FieldValue.arrayUnion({ action: 'Reversed_To_Pending', clawed_back_amount: clawedBack, debt_added: admS2Money(debtAddedMicro), note: notes, timestamp: new Date(now).toISOString() }) });
            } else {
                const newTotal = admS2Money(totalWd > amountMicro ? totalWd - amountMicro : 0n);
                Object.assign(walletUpdates, { Total_Withdraw: newTotal, Total_Withdrawal: newTotal });
                if (action === 'reject') walletUpdates.Main_Balance = admS2Money(main + amountMicro);
                else {
                    walletUpdates.Locked_Balance = admS2Money(locked + amountMicro);
                    if (action === 'cancel') {
                        if (wallet.Locked_Withdrawals !== undefined && !Array.isArray(wallet.Locked_Withdrawals)) throw new Error('Invalid vault lock array.');
                        walletUpdates.Locked_Withdrawals = FieldValue.arrayUnion({ amount, amount_micro: amountMicro.toString(), unlockTime: now + 24 * 60 * 60 * 1000, txId: identifier });
                    }
                }
                const status = action === 'reject' ? 'Rejected' : action === 'vault' ? 'Locked' : 'Refunded';
                Object.assign(txUpdates, { Status: status, status, Refund_State: 'Refunded', Refund_Destination: action === 'reject' ? 'Main_Balance' : 'Locked_Balance', Refunded_At: FieldValue.serverTimestamp() });
            }
            txUpdates.Admin_Note = notes || `Withdrawal action: ${action}`;
            for (const value of Object.values(walletUpdates)) {
                if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) throw new Error('Wallet balance overflow.');
            }
            const quotaAdjustment = await q4WithdrawalAdjustment(
                t, walletRef, wallet, uid, withdrawal, action, q4Month()
            );
            Object.assign(walletUpdates, quotaAdjustment.wallet);
            Object.assign(txUpdates, quotaAdjustment.ledger);
            // Approval and its notification job commit together; SMTP runs outside this transaction.
            if (action === 'approve') {
                t.set(db.collection('Withdrawal_Email_Jobs').doc(txRef.id + '_' + cycle), {
                    UID: uid, Order_ID: orderId || txRef.id, Network: withdrawal.Network,
                    Amount: amount, Fee: withdrawal.Fee ?? 0,
                    Net_Amount: withdrawal.Net_Amount ?? admS2Money(amountMicro - numeric(withdrawal.Fee, 'withdrawal fee')),
                    Destination: String(withdrawal.Destination || ''), State: 'Pending', Attempts: 0,
                    NextAttemptAt: now, Created_At: FieldValue.serverTimestamp()
                });
            }
            // No reads after this point.
            if (Object.keys(walletUpdates).length) t.update(walletRef, moneyV7Updates(wallet, { ...walletUpdates,
                ...t8MainEntry(t, uid, wallet, walletUpdates.Main_Balance, 'Withdrawal ' + action, orderId || txRef.id) }, 'Wallet', 'update'));
            t.update(txRef, txUpdates);
            t.update(userRef, { 'counters.txCount': nextStakingTxCount(userSnap.data()) });
            if (treasuryUpdates) t.update(treasuryRef, moneyV7Updates(treasurySnap.exists ? treasurySnap.data() : {}, treasuryUpdates, 'Treasury', 'update'));
            if (feeLedgerRef) t.set(feeLedgerRef, { id: feeLedgerRef.id, UID: 'TCM_TREASURY', Status: 'Success', Order_ID: orderId, Related_Transaction_ID: txRef.id, Fee_Cycle: txUpdates.Fee_Cycle ?? cycle, Date: new Date(now).toISOString(), timestamp: FieldValue.serverTimestamp(), ...feeLedgerData });
            t.set(db.collection('Transactions').doc(), t9Record(t, { UID: uid, Type: 'Withdrawal ' + action, Amount: amount, Status: 'Success', Order_ID: orderId || txRef.id, Details: notes || action, Date: new Date(now).toISOString(), timestamp: FieldValue.serverTimestamp() }, uid, undefined, wallet));
            t.set(db.collection('AdminLogs').doc(), { Admin_Name: actor.data().Name || actorUid, Actor_UID: actorUid, Action_Type: 'Withdrawal ' + action, Target_UID: uid, Details: notes || action, Transaction_ID: txRef.id, Date: new Date(now).toISOString(), timestamp: FieldValue.serverTimestamp() });
            return { uid, message: 'Withdrawal ' + action + ' completed.' };
        });
        await clearUserCache(outcome.uid);
        setImmediate(() => { void c2RunMailQueue(); });
        return res.json({ success: true, message: outcome.message });
    } catch (error) {
        return res.status(error.httpStatus || 400).json({ success: false, message: error.message });
    }
};
app.post('/api/admin/withdrawal-action', withdrawalActionHandler);
app.post('/api/finance/cancel-withdrawal', withdrawalActionHandler);
app.post('/api/finance/reverse-withdrawal', withdrawalActionHandler);
// =========================================================
// 🚀 MODULE 4: P2P TRANSFER & HISTORY
// =========================================================
app.post('/api/p2p/read-glow', async (req, res) => {
    try {
        await db.collection("Users").doc(req.body.uid).update({ hasUnreadP2P: false });
        res.json({ success: true });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

// 🔥 P2P User Scanner: String & Number Data Type Fix
function publishP2PNotice(eventName, payload) {
    try {
        io.to(payload.receiverUid).timeout(3000).emit(eventName, payload, (error, responses = []) => {
            const accepted = responses.filter(response => response?.accepted === true);
            const rendered = accepted.filter(response => response.rendered === true);
            console.info('[P2P DELIVERY]', {
                eventId: payload.eventId,
                eventName,
                receiverUid: payload.receiverUid,
                acceptedCount: accepted.length,
                renderedCount: rendered.length,
                acknowledgmentTimedOut: Boolean(error),
                rejectionReasons: responses
                    .filter(response => response?.accepted !== true)
                    .map(response => response?.reason || 'unknown')
            });
        });
        return true;
    } catch (error) {
        console.warn('[P2P DELIVERY] Notification failed:', {
            eventId: payload.eventId,
            message: error.message
        });
        return false;
    }
}

const p2pScanNoticeCooldowns = new Map();

async function p2pResolveRecipient(req, res) {
    try {
        const senderUid = req.authenticatedUid;
        const senderDoc = req.authenticatedUserDoc;
        if (!senderUid || !senderDoc || !senderDoc.exists || senderDoc.id !== senderUid) {
            return res.status(401).json({ success: false, message: "Authentication required." });
        }
        if (senderDoc.data().Status === 'Banned') {
            return res.status(403).json({ success: false, message: "Account access is blocked." });
        }

        const isScan = req.query.isQr === '1';
        const suppliedUid = req.query.uid;
        const rawUid = typeof suppliedUid === 'string' ? suppliedUid.trim() : '';
        if (!/^[A-Za-z0-9]{1,128}$/.test(rawUid)) {
            return res.status(400).json({ success: false, message: "A valid alphanumeric UID is required!" });
        }

        const users = db.collection("Users");
        const stringMatch = await users.where("UID", "==", rawUid).limit(1).get();
        let userDoc = stringMatch.empty ? null : stringMatch.docs[0];
        if (!userDoc) {
            const directMatch = await users.doc(rawUid).get();
            if (directMatch.exists) userDoc = directMatch;
        }
        if (!userDoc && /^\d+$/.test(rawUid) && Number.isSafeInteger(Number(rawUid))) {
            const numericMatch = await users.where("UID", "==", Number(rawUid)).limit(1).get();
            if (!numericMatch.empty) userDoc = numericMatch.docs[0];
        }
        if (!userDoc) {
            return res.status(404).json({ success: false, message: "User not found!" });
        }
        if (userDoc.id === senderUid) {
            return res.status(400).json({ success: false, message: "Cannot send to yourself!" });
        }
        if (userDoc.data().Status === 'Pending_Deletion') {
            return res.status(409).json({
                success: false,
                isPendingDeletion: true,
                message: 'Recipient account is scheduled for deletion and cannot receive funds.'
            });
        }
        if (userDoc.data().Status === 'Banned' || userDoc.data().Account_Deleted === true) {
            return res.status(400).json({ success: false, message: "This recipient is unavailable." });
        }

        let scanEventId = null;
        let notification = 'not-requested';
        if (isScan) {
            notification = 'unavailable';
            try {
                const socketServer = global.io || io;
                if (socketServer) {
                    const now = Date.now();
                    const cooldownUntil = p2pScanNoticeCooldowns.get(senderUid) || 0;
                    if (p2pScanNoticeCooldowns.size >= 4096) {
                        for (const [uid, expiresAt] of p2pScanNoticeCooldowns) {
                            if (expiresAt <= now) p2pScanNoticeCooldowns.delete(uid);
                        }
                    }

                    if (cooldownUntil > now ||
                        (p2pScanNoticeCooldowns.size >= 4096 && !p2pScanNoticeCooldowns.has(senderUid))) {
                        notification = 'rate-limited';
                    } else {
                        p2pScanNoticeCooldowns.set(senderUid, now + 5000);
                        const redisDecision = await m2RedisCommand(() => redisClient.set(
                            `p2p:scan-notice:${senderUid}`, '1', { NX: true, EX: 5 }
                        ).then(result => result === 'OK' ? 'allowed' : 'denied'));

                        if (redisDecision === 'denied') {
                            notification = 'rate-limited';
                        } else if (redisDecision === 'allowed' || redisDecision === null) {
                            scanEventId = r3Crypto.randomUUID();
                            const emitted = publishP2PNotice('p2p_scan_waiting', {
                                eventId: scanEventId,
                                receiverUid: userDoc.id,
                                senderUid,
                                senderName: String(senderDoc.data().Name || 'TCM member').slice(0, 80),
                                validForMs: 60000
                            });
                            notification = emitted ? 'emitted' : 'unavailable';
                        }
                    }
                }
            } catch (error) {
                console.warn('[P2P SCAN] Live notification unavailable:', error);
            }
        }

        return res.json({
            success: true,
            name: String(userDoc.data().Name || 'TCM member'),
            receiverUid: userDoc.id,
            scanEventId,
            notification
        });
    } catch (error) {
        return res.status(503).json({ success: false, message: "Receiver lookup is temporarily unavailable." });
    }
}

app.get('/api/p2p/check-user', p2pResolveRecipient);

// 🔥 P2P Double-Spending Lock (Race Condition Fix)
const activeP2PTransfers = new Set();

const p2pTransferEngine = async (req, res) => {
    // MEMO TCM-FIN-013 | 2026-10-10 01:37 IST | Asia/Kolkata
    const senderUid = req.authenticatedUid;

    if (
        typeof senderUid !== "string" ||
        !senderUid.trim() ||
        senderUid.includes("/")
    ) {
        return res.status(401).json({
            success: false,
            message: "Authenticated account is required."
        });
    }

    if (
        (req.body.senderUid !== undefined && req.body.senderUid !== senderUid) ||
        (req.body.sUid !== undefined && req.body.sUid !== senderUid)
    ) {
        return res.status(403).json({
            success: false,
            message: "Sender ownership mismatch."
        });
    }
    
    // 🛡️ যদি এই ইউজারের কোনো P2P ট্রানজ্যাকশন অলরেডি প্রসেসিংয়ে থাকে, তবে পরের ক্লিক ব্লক হবে
    if (activeP2PTransfers.has(senderUid)) {
        console.log(`[P2P Locked] 🚫 Double spending blocked for UID: ${senderUid}`);
        return res.status(429).json({ success: false, message: "Transaction in progress. Please wait!" });
    }
    
    // 🔒 ইউজারকে লক করা হলো
    activeP2PTransfers.add(senderUid);

    try { 
        const receiverUid = req.body.receiverUid ?? req.body.rUid;
        const code2FA = req.body.code2FA;
        const rawAmount = req.body.amount;

        if (
            (typeof receiverUid !== "string" && typeof receiverUid !== "number") ||
            (typeof receiverUid === "string" &&
                (!receiverUid.trim() || receiverUid.includes("/"))) ||
            (typeof receiverUid === "number" &&
                (!Number.isSafeInteger(receiverUid) || receiverUid <= 0))
        ) {
            throw new Error("Invalid receiver UID.");
        }

        if (
            req.body.receiverUid !== undefined &&
            req.body.rUid !== undefined &&
            req.body.receiverUid !== req.body.rUid
        ) {
            throw new Error("Receiver UID mismatch.");
        }

        if (
            (typeof rawAmount !== "number" && typeof rawAmount !== "string") ||
            !/^\d+(?:\.\d+)?$/.test(String(rawAmount).trim())
        ) {
            throw new Error("Invalid Amount!");
        }

        const amount = admS2Money(admS2Micro(rawAmount, 'transfer amount', false));

        const customOrderId = generateOrderId('P2P');

        // Monthly quota is checked against the sender wallet inside the financial transaction.
        
        let finalFee = 0, sName = "", rName = "";
        let resolvedReceiverUid = receiverUid;

        const settlement = await db.runTransaction(async (t) => {
            const sUserRef = db.collection("Users").doc(senderUid);
            const sData = (await t.get(sUserRef)).data();
            if (!sData || sData.Account_Deleted === true || sData.Status === 'Banned') {
                throw new Error('Sender account is unavailable.');
            }
            if (sData.Status === 'Pending_Deletion') {
                throw new Error('Transfer blocked: Account is scheduled for deletion.');
            }
            sName = sData.Name || "User";

            if (!sData["2FA_Key"]) throw new Error("Please bind Google 2FA first!");
            let is2FAValid = false;
            try { is2FAValid = authenticator.verify({ token: String(code2FA), secret: sData["2FA_Key"] }); } catch(err) {}
            if (!is2FAValid) throw new Error("Invalid 2FA Code!");
            
            const rUserQuerySnap = await t.get(db.collection("Users").where("UID", "==", receiverUid).limit(2));
            if (rUserQuerySnap.empty) throw new Error("Receiver not found!");
            if (rUserQuerySnap.size !== 1) {
                throw new Error("Receiver UID is ambiguous.");
            }

            const rDoc = rUserQuerySnap.docs[0];

            if (rDoc.id === senderUid) {
                throw new Error("Transfers to your own account are not allowed.");
            }

            const rUserRef = rDoc.ref;
            const rData = rDoc.data();
            if (rData.Status === 'Pending_Deletion' || sData.Status === 'Pending_Deletion') {
                throw new Error('Transfer blocked: Account is scheduled for deletion.');
            }
            if (rData.Account_Deleted === true || rData.Status === 'Banned') {
                throw new Error('Recipient account is unavailable.');
            }
            resolvedReceiverUid = rDoc.id;
            rName = rData.Name || "User";
            
            const sWalletRef = db.collection("Wallets").doc(senderUid);
            const rWalletRef = db.collection("Wallets").doc(rDoc.id);
            const sWSnap = await t.get(sWalletRef);
            const rWSnap = await t.get(rWalletRef);

            // MEMO TCM-FIN-013-S2 | 2026-10-10 01:41 IST | Asia/Kolkata
            const treasuryRef = db.collection("Admin_Data").doc("TCM_TREASURY");
            const feeLedgerRef = db.collection("Transactions")
                .doc(`TX-FEE-${customOrderId}`);

            const treasurySnapshot = await t.get(treasuryRef);
            const feeLedgerSnapshot = await t.get(feeLedgerRef);

            if (!sWSnap.exists || !rWSnap.exists) {
                throw new Error("Sender or receiver wallet not found.");
            }
            if (sData.Status === 'Banned') throw q4Error('Account access is blocked.', 403);
            const quotaWindow = q4Month();
            const monthlyQuota = await q4ReadQuota(t, sWalletRef, sWSnap.data(), senderUid, quotaWindow);

            if (feeLedgerSnapshot.exists) {
                throw new Error("P2P fee ledger already exists for this order.");
            }

            const treasuryData = treasurySnapshot.exists
                ? treasurySnapshot.data()
                : {};

            const feeConfig = c2Fees(treasuryData);
            c2CheckVersion(req, feeConfig);
            const quote = c2Quote(rawAmount, feeConfig.p2pFeePct);
            const feeMicro = BigInt(quote.Fee_micro);
            const transferMicro = admS2Micro(rawAmount, 'transfer amount', false);
            const p2pTreasuryUpdates = {};
            for (const field of ["P2P_Fee_Wallet", "Total_Revenue"]) {
                p2pTreasuryUpdates[field] = admS2Money(admS2Balance(treasuryData, field) + feeMicro);
            }

            const senderMicro = admS2Balance(sWSnap.data(), 'Main_Balance');
            if (senderMicro < transferMicro) throw new Error("Insufficient Balance!");

            const fee = quote.fee;
            finalFee = fee;
            const netMicro = transferMicro - feeMicro;
            const netAmt = admS2Money(netMicro);
            const newSenderBal = admS2Money(senderMicro - transferMicro);
            const newReceiverBal = admS2Money(admS2Balance(rWSnap.data(), 'Main_Balance') + netMicro);
            
            let sWalletUpdates = {
                ...t8MainEntry(t, senderUid, sWSnap.data(), newSenderBal, 'P2P transfer sent', customOrderId),
                Main_Balance: newSenderBal,
                Monthly_Quota: q4TakeSlot(monthlyQuota, 'p2p')
            };
            let rWalletUpdates = { Main_Balance: newReceiverBal,
                ...t8MainEntry(t, rDoc.id, rWSnap.data(), newReceiverBal, 'P2P transfer received', customOrderId) };
            // Each committed user ledger row increments its owner's counter once.
            // These values are recalculated from fresh transaction reads on retries.
            let sUserUpdates = { 'counters.txCount': nextStakingTxCount(sData) };
            let rUserUpdates = {
                hasUnreadP2P: true,
                'counters.txCount': nextStakingTxCount(rData)
            };

            let sRankCalc = calculateRankUpdates(sData, moneyV7NextView(sWSnap.data(), { Main_Balance: newSenderBal }));
            if (sRankCalc.Rank !== undefined) sUserUpdates.Rank = sRankCalc.Rank;
            if (sRankCalc.Points !== undefined) sWalletUpdates.Points = sRankCalc.Points;

            let rRankCalc = calculateRankUpdates(rData, moneyV7NextView(rWSnap.data(), { Main_Balance: newReceiverBal }));
            if (rRankCalc.Rank !== undefined) rUserUpdates.Rank = rRankCalc.Rank;
            if (rRankCalc.Points !== undefined) rWalletUpdates.Points = rRankCalc.Points;

            if(Object.keys(sUserUpdates).length > 0) t.update(sUserRef, sUserUpdates);
            t.update(sWalletRef, moneyV7Updates(sWSnap.data(), sWalletUpdates, 'Wallet', 'update'));
            t.update(rUserRef, rUserUpdates);
            t.update(rWalletRef, moneyV7Updates(rWSnap.data(), rWalletUpdates, 'Wallet', 'update'));

            const txDateIso = new Date().toISOString(); 
            
            // 🔥 TCM-02: Document ID জেনারেট করা হচ্ছে যাতে ফ্রন্টএন্ডে রিয়েল-টাইম ইনজেক্ট করা যায়
            const p2pRef = db.collection("Send_Money_P2P").doc();
            const sTxRef = db.collection("Transactions").doc();
            const rTxRef = db.collection("Transactions").doc();
            
            // স্কোপের বাইরে আইডি সেভ করার জন্য রিকোয়েস্ট অবজেক্ট ব্যবহার করছি
            req.generatedTxId = sTxRef.id; 
            
            t.set(p2pRef, {
                Amount_micro: transferMicro.toString(), Net_Amount_micro: netMicro.toString(),

                Date: txDateIso,
                Sender_UID: senderUid,
                Sender_Name: sName,
                Receiver_UID: receiverUid,
                Receiver_Name: rName,
                Amount: amount,
                Fee: fee,
                Fee_Rate_Pct: quote.Fee_Rate_Pct, Fee_Config_Version: feeConfig.version, Fee_micro: quote.Fee_micro,
                Net_Amount: netAmt,
                Order_ID: customOrderId,
                Status: "Success",
                timestamp: FieldValue.serverTimestamp()
            });

            t.set(treasuryRef, moneyV7Updates(treasuryData, p2pTreasuryUpdates, 'Treasury', 'merge'), { merge: true });

            t.set(feeLedgerRef, {
                id: feeLedgerRef.id,
                Date: txDateIso,
                UID: "TCM_TREASURY",
                Type: "P2P Fee",
                Amount: fee,
                Status: "Success",
                Order_ID: customOrderId,
                Source_UID: senderUid,
                Receiver_UID: rDoc.id,
                Related_Transaction_ID: sTxRef.id,
                Related_P2P_ID: p2pRef.id,
                Details: "P2P transfer fee credited to company treasury",
                timestamp: FieldValue.serverTimestamp()
            }); 
            t.set(sTxRef, t9Record(t, {
                Amount_micro: transferMicro.toString(), Net_Amount_micro: netMicro.toString(),

                Date: txDateIso,
                UID: senderUid,
                Type: 'P2P Sent',
                Fee: fee, Net_Amount: netAmt, Fee_Rate_Pct: quote.Fee_Rate_Pct,
                Fee_Config_Version: feeConfig.version, Fee_micro: quote.Fee_micro,
                Amount: amount,
                Status: 'Success',
                Order_ID: customOrderId,
                Quota_Month: quotaWindow.key,
                Admin_Remarks: `To: ${rName} (UID: ${receiverUid})`,
                timestamp: FieldValue.serverTimestamp()
            }));
            t.set(rTxRef, t9Record(t, {
                Amount_micro: netMicro.toString(),

                Date: txDateIso,
                UID: rDoc.id,
                Type: 'P2P Received',
                Amount: netAmt,
                Status: 'Success',
                Order_ID: customOrderId,
                Admin_Remarks: `From: ${sName} (UID: ${senderUid})`,
                timestamp: FieldValue.serverTimestamp()
            }));

            return {
                eventId: rTxRef.id,
                receiverUid: rDoc.id,
                senderUid,
                senderName: String(sData.Name || 'TCM member'),
                orderId: customOrderId,
                receiverTransactionId: rTxRef.id,
                grossAmount: String(amount),
                feeAmount: String(fee),
                netAmount: String(netAmt),
                ledgerDate: txDateIso,
                status: 'Success'
            };
        });

        publishP2PNotice('p2p_transfer_received', settlement);
        
        const cacheResults = await Promise.allSettled([
            clearUserCache(senderUid),
            clearUserCache(resolvedReceiverUid)
        ]);
        for (const result of cacheResults) {
            if (result.status === 'rejected') console.warn('P2P committed; cache invalidation is pending.');
        }
        
        // 🚀 TCM-02 Return-on-Write: ফ্রন্টএন্ডে জিরো-বিলিং ইনজেকশনের জন্য রিয়েল ID এবং ডেটা রিটার্ন
        res.json({ 
            success: true, 
            data: { 
                id: req.generatedTxId, // ফায়ারবেসের আসল Document ID
                orderId: customOrderId, 
                fee: finalFee, 
                senderName: sName, 
                receiverName: rName,
                Date: new Date().toISOString(),
                timestamp: Date.now()
            } 
        }); 
    } catch (e) { 
        res.status(e.statusCode || 400).json({ success: false, message: e.message });
    } finally {
        // 🔓 ট্রানজ্যাকশন শেষ (সাকসেস বা ফেইল যাই হোক), এবার ইউজারকে আনলক করা হলো
        activeP2PTransfers.delete(senderUid);
    }
};
app.post('/api/p2p/transfer', p2pTransferEngine);
app.post('/api/finance/p2p', p2pTransferEngine); 

app.get('/api/p2p/lookup', async (req, res) => {
    try {
        const snap = await db.collection("Send_Money_P2P").where("Order_ID", "==", req.query.orderId).limit(1).get();
        if (snap.empty) throw new Error("Order ID not found!");
        res.json({ success: true, data: snap.docs[0].data() });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

app.get('/api/p2p/history', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const uid = req.authenticatedUid;
    if (typeof uid !== 'string' || !uid || uid.includes('/')) {
        return res.status(401).json({ success: false, message: 'Authentication required.' });
    }
    if (req.query.uid !== undefined && req.query.uid !== uid) {
        return res.status(403).json({ success: false, message: 'Account ownership mismatch.' });
    }
    const actor = req.authenticatedUserDoc;
    if (!actor || !actor.exists || actor.id !== uid) {
        return res.status(401).json({ success: false, message: 'Authenticated account unavailable.' });
    }
    if (actor.data().Status === 'Banned') {
        return res.status(403).json({ success: false, message: 'Account access is blocked.' });
    }
    try {
        const rawRevision = actor.data().counters?.txCount;
        const revision = typeof rawRevision === 'number' && Number.isSafeInteger(rawRevision) && rawRevision >= 0
            ? rawRevision : null;
        // Existing transfer transactions increment both parties' txCount atomically.
        // An old cache fill uses an old key and cannot overwrite a newer revision.
        const key = revision === null ? null : `p2p_history_e4_${encodeURIComponent(uid)}_${revision}`;
        if (key) {
            const cached = await m2RedisCommand(() => redisClient.get(key));
            if (typeof cached === 'string') {
                try {
                    const value = JSON.parse(cached);
                    if (value.uid === uid && value.revision === revision && Array.isArray(value.data) &&
                        value.data.length <= 10 && value.data.every(row =>
                            row && typeof row.id === 'string' && (row.Sender_UID === uid || row.Receiver_UID === uid))) {
                        return res.json({ success: true, source: 'redis', data: value.data, partial: value.partial === true, message: value.message || '' });
                    }
                } catch (error) {
                    // Invalid cache contents are a miss, not an authorization bypass.
                }
            }
        }
        const flightKey = key || 'uncached:' + uid;
        const remembered = e4P2PMemory.get(flightKey);
        if (remembered && Date.now() < remembered.until) {
            return res.json({ success: true, source: 'memory', ...remembered.result });
        }
        let operation = m2P2PFlights.get(flightKey);
        if (!operation) {
            if (m2P2PFlights.size >= 200) {
                return res.status(503).json({ success: false, message: 'History reader busy. Try again shortly.' });
            }
            operation = m2LoadP2PHistory(uid).then(async result => {
                e4Remember(e4P2PMemory, flightKey, { result, until: Date.now() + 60000 });
                if (key) await m2RedisCommand(() => redisClient.setEx(key, 60, JSON.stringify({ uid, revision, ...result })));
                return result;
            }).finally(() => m2P2PFlights.delete(flightKey));
            m2P2PFlights.set(flightKey, operation);
        }
        const result = await operation;
        return res.json({ success: true, source: 'db', ...result });
    } catch (error) {
        console.warn('M2 P2P history unavailable:', error.code || 'unknown', error.message);
        return res.status(503).json({ success: false, message: 'P2P history unavailable. Check backend/index configuration.' });
    }
});

// =========================================================
// 🚀 MODULE 5: NFT ENGINE (🔥 NFT Timezone Bug Fixed)
// =========================================================
// M2: Reservation-cycle entitlement and revision-keyed P2P display caching.
const { Timestamp: m2Timestamp, FieldPath: m2FieldPath } = require('firebase-admin/firestore');
const m2P2PFlights = new Map();

function m2NFTCycle(now = Date.now()) {
    const local = moment(now).tz('Asia/Kolkata');
    const start = local.clone().hours(5).minutes(30).seconds(0).milliseconds(0);
    if (local.isBefore(start)) start.subtract(1, 'days');
    return { key: start.format('YYYY-MM-DD'), start: start.valueOf(), end: start.clone().add(1, 'days').valueOf() };
}

async function m2CheckNFTCycle(t, wallet, uid, cycle) {
    const marker = wallet.Last_NFT_Reserve_Cycle;
    if (marker !== undefined && marker !== null) {
        if (typeof marker !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(marker) ||
            !Number.isFinite(Date.parse(marker + 'T00:00:00Z')) ||
            new Date(marker + 'T00:00:00Z').toISOString().slice(0, 10) !== marker) {
            throw new Error('NFT cycle marker is invalid. Contact support before reserving.');
        }
        if (marker >= cycle.key) {
            throw new Error(marker === cycle.key
                ? 'Daily Limit Reached! You have already reserved an NFT today.'
                : 'NFT cycle marker is ahead of the current cycle. Contact support.');
        }
        return;
    }
    try {
        // Bootstrap only unmarked wallets; never scan their lifetime reservation ledger.
        const base = db.collection('NFT_History').where('UID', '==', uid).where('Type', '==', 'NFT Reserve');
        const byTimestamp = await t.get(base
            .where('timestamp', '>=', m2Timestamp.fromMillis(cycle.start))
            .where('timestamp', '<', m2Timestamp.fromMillis(cycle.end)).limit(1));
        if (!byTimestamp.empty) throw new Error('Daily Limit Reached! You have already reserved an NFT today.');
        // The existing reservation writer stores Date as an ISO UTC string.
        const byDate = await t.get(base
            .where('Date', '>=', new Date(cycle.start).toISOString())
            .where('Date', '<', new Date(cycle.end).toISOString()).limit(1));
        if (!byDate.empty) throw new Error('Daily Limit Reached! You have already reserved an NFT today.');
    } catch (error) {
        if (e4MissingIndex(error)) {
            const temporary = new Error('NFT reservation security index is currently compiling. Please try again in a few minutes. Your balance is completely untouched.');
            temporary.statusCode = 503;
            throw temporary;
        }
        throw error;
    }
}

async function m2RedisCommand(command) {
    if (!redisClient || !redisClient.isReady) return null;
    let timeout;
    try {
        return await Promise.race([
            Promise.resolve().then(command),
            new Promise(resolve => { timeout = setTimeout(() => resolve(null), 200); })
        ]);
    } catch (error) {
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

// E4: Bounded reader degradation. Cached records are display data, never financial authority.
const dashboardHistoryReader = require('./lib/dashboard-history.cjs')({ db, FieldPath: m2FieldPath, Timestamp: m2Timestamp, validateBlockchain: nftBlockchainHistoryReference });
const e4HeadFlights = new Map();
const e4HeadMemory = new Map();
const e4P2PMemory = new Map();
let e4HeadIndexRetryAt = 0;
let e4P2PIndexRetryAt = 0;

function e4MissingIndex(error) {
    return [9, '9', 'FAILED_PRECONDITION', 'failed-precondition'].includes(error?.code) &&
        /index/i.test(String(error.message || ''));
}

function e4Remember(map, key, value) {
    if (!map.has(key) && map.size >= 500) map.delete(map.keys().next().value);
    map.set(key, value);
}

function e4RowsValid(rows, uid) {
    return Array.isArray(rows) && rows.length <= 20 && rows.every(row =>
        row && typeof row.id === 'string' && row.UID === uid);
}

async function e4LoadDashboardHead(uid, revision) {
    const key = `e4_tx_head_${encodeURIComponent(uid)}_${revision}`;
    // The existing init_data_full cache owns fresh snapshots and their invalidation.
    // This memory copy is used only for explicitly stale display during an outage.
    const remembered = e4HeadMemory.get(uid);
    const degraded = () => remembered && Date.now() - remembered.at < 600000
        ? { ...remembered, status: 'stale' }
        : { records: [], status: 'unavailable' };
    if (Date.now() < e4HeadIndexRetryAt) return degraded();
    let flight = e4HeadFlights.get(key);
    if (!flight) {
        if (e4HeadFlights.size >= 200) return degraded();
        flight = (async () => {
            try {
                const page = await dashboardHistoryReader.page(uid);
                const records = page.records;
                if (!e4RowsValid(records, uid)) throw new Error('Invalid scoped transaction head.');
                e4Remember(e4HeadMemory, uid, { ...page, revision, at: Date.now() });
                return { ...page, status: 'ready' };
            } catch (error) {
                if (e4MissingIndex(error)) {
                    e4HeadIndexRetryAt = Date.now() + 60000;
                    console.warn('[E4 HISTORY] Index not ready; no lifetime fallback will run.', error.message);
                } else {
                    console.warn('[E4 HISTORY] Bounded head unavailable:', error.code || 'unknown');
                }
                return degraded();
            }
        })().finally(() => e4HeadFlights.delete(key));
        e4HeadFlights.set(key, flight);
    }
    return flight;
}

async function m2LoadP2PHistory(uid) {
    let snapshots;
    let partial = Date.now() < e4P2PIndexRetryAt;
    if (!partial) {
        // Wait for every bounded attempt to finish before considering a fallback.
        const attempts = await Promise.allSettled(['Sender_UID', 'Receiver_UID'].flatMap(field =>
            ['timestamp', 'Date'].map(dateField => db.collection('Send_Money_P2P')
                .where(field, '==', uid).orderBy(dateField, 'desc')
                .orderBy(m2FieldPath.documentId(), 'desc').limit(10).get())
        ));
        const failures = attempts.filter(item => item.status === 'rejected');
        const otherFailure = failures.find(item => !e4MissingIndex(item.reason));
        if (otherFailure) throw otherFailure.reason;
        if (failures.length) {
            e4P2PIndexRetryAt = Date.now() + 60000;
            console.warn('[E4 P2P] Index not ready; serving a bounded sample.', failures[0].reason.message);
            partial = true;
        } else {
            snapshots = attempts.map(item => item.value);
        }
    }
    if (partial) {
        // Default document-ID order is only a sample, not the newest ten records.
        snapshots = await Promise.all(['Sender_UID', 'Receiver_UID'].map(field =>
            db.collection('Send_Money_P2P').where(field, '==', uid).limit(10).get()
        ));
    }
    const records = new Map();
    for (const snapshot of snapshots) {
        for (const doc of snapshot.docs) {
            const row = doc.data();
            if (row.Sender_UID !== uid && row.Receiver_UID !== uid) continue;
            records.set(doc.id, { ...row, id: doc.id, isSender: row.Sender_UID === uid });
        }
    }
    const data = [...records.values()].sort((a, b) =>
        parseSafeTimestamp(b.timestamp || b.Date) - parseSafeTimestamp(a.timestamp || a.Date) ||
        b.id.localeCompare(a.id)
    ).slice(0, 10);
    return { data, partial, message: partial
        ? 'Limited history while indexes build. This sample may omit newer transfers.' : '' };
}

// NFT MAINNET GALLERY START: public evidence only; no signing or financial writes.
const nftGuards = require('./lib/nft-reservation-guards.cjs')({
    readMicro: (value, label) => moneyV1ReadLegacy(value, label).micro,
    toMoney: value => admS2Money(value)
});
async function nftInvalidateMarket() {
    try {
        if (redisClient && redisClient.isReady) await redisClient.del('global_nft_market');
    } catch (error) { console.warn('[NFT] Market cache invalidation deferred.'); }
}
const nftGrowth = require('./lib/nft-price-growth.cjs');
const nftMainnet = require('./lib/nft-mainnet-gallery.cjs')({
    ethers: hdEthers, db, FieldValue, clearMarketCache: nftInvalidateMarket
});
let nftCooldownFlight, nftCooldownNextCheck = 0;
async function nftRecoverCooldowns() {
    if (nftCooldownFlight) return nftCooldownFlight;
    if (Date.now() < nftCooldownNextCheck) return;
    nftCooldownNextCheck = Date.now() + 10000;
    nftCooldownFlight = (async () => {
        // Compatibility recovery for old servers' cleared Cooldown records.
        // The retired two-minute deadline no longer delays eligible stock.
        const due = await db.collection('NFT_Gallery').where('Status', '==', 'Cooldown')
            .orderBy('Next_Available_Time', 'asc').limit(20).get();
        let changed = false;
        for (const doc of due.docs) {
            const released = await db.runTransaction(async transaction => {
                const current = await transaction.get(doc.ref);
                if (!current.exists) return false;
                const row = current.data();
                if (row.Status !== 'Cooldown' || row.Owner_UID !== '' || !Number.isFinite(row.Next_Available_Time) ||
                    row.Reservation != null || row.Reservation_Blockchain != null) return false;
                transaction.update(doc.ref, { Status: 'Available', Next_Available_Time: null });
                return true;
            });
            changed = released || changed;
        }
        if (changed) await nftInvalidateMarket();
        if (due.size === 20) nftCooldownNextCheck = Date.now();
    })().finally(() => { nftCooldownFlight = null; });
    return nftCooldownFlight;
}
function nftMainnetAdmin(req, res) {
    if (!m1RequireAdmin(req, res)) return false;
    if (req.authenticatedUserDoc.data().Status !== 'Active' || req.authenticatedUserDoc.data().Account_Deleted) {
        res.status(403).json({ success: false, message: 'Active administrator required.' });
        return false;
    }
    return true;
}
app.get('/api/admin/nft-mainnet/status', async (req, res) => {
    if (!nftMainnetAdmin(req, res)) return;
    try { await nftMainnet.refresh({ force: true }); res.json({ success: true, ...(await nftMainnet.verify({ assetId: req.query?.assetId })) }); }
    catch (error) { res.status(503).json({ success: false, message: error.message }); }
});
app.get('/api/admin/nft-mainnet/assets', async (req, res) => {
    if (!nftMainnetAdmin(req, res)) return;
    try { await nftMainnet.refresh({ force: true }); res.json({ success: true, data: nftMainnet.assets() }); }
    catch (error) { res.status(503).json({ success: false, message: error.message }); }
});
app.post('/api/admin/nft-mainnet/publish', async (req, res) => {
    if (!nftMainnetAdmin(req, res)) return;
    return nftMainnet.publish(req, res);
});
// Candidate verification and publication are separate, authenticated actions.
const nftAdminImport = require('./lib/nft-admin-import.cjs')({ db, FieldValue, gallery: nftMainnet, clearMarketCache: nftInvalidateMarket });
app.post('/api/admin/nft-mainnet/candidate/preview', async (req, res) => {
    if (!nftMainnetAdmin(req, res)) return;
    return nftAdminImport.preview(req, res);
});
app.post('/api/admin/nft-mainnet/candidate/publish', async (req, res) => {
    if (!nftMainnetAdmin(req, res)) return;
    return nftAdminImport.publish(req, res);
});
// NFT MAINNET GALLERY END

// NFT BLOCKCHAIN REFERENCE START: recorded identities and dated Mainnet snapshots.
function nftBlockchainReference(raw) {
    if (raw === undefined || raw === null) return null;

    const fail = () => {
        throw new Error(
            'Invalid NFT blockchain reference. Contact support.'
        );
    };

    if (
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        !hdEthers ||
        raw.Chain_ID !== 56 ||
        typeof raw.Contract_Address !== 'string' ||
        typeof raw.Token_ID !== 'string' ||
        !/^[1-9][0-9]{0,77}$/.test(raw.Token_ID) ||
        typeof raw.Metadata_URI !== 'string' ||
        !/^ipfs:\/\/[A-Za-z0-9]{46,100}(?:\/[A-Za-z0-9._/-]{1,100})?$/.test(raw.Metadata_URI) ||
        typeof raw.Mint_TxHash !== 'string' ||
        !/^0x[0-9a-fA-F]{64}$/.test(raw.Mint_TxHash)
    ) {
        fail();
    }

    let address;
    try {
        address = hdEthers.getAddress(raw.Contract_Address);
    } catch {
        fail();
    }

    if (
        address === hdEthers.ZeroAddress ||
        BigInt(raw.Token_ID) >= (1n << 256n) ||
        (address.toLowerCase() ===
            '0xc617c917bb594bb14f2a7ead2d9b650dd3754673' && !nftMainnet.matches(raw)) ||
        raw.Mint_TxHash.toLowerCase() ===
            '0x74ac1c82cfdd43579edd68644b4c756a3c17b524c3be3b1a1a823f9e2cf2b6a5'
    ) {
        fail();
    }

    return {
        Chain_ID: 56,
        Contract_Address: address,
        Token_ID: raw.Token_ID,
        Metadata_URI: raw.Metadata_URI,
        Mint_TxHash: raw.Mint_TxHash.toLowerCase(),
        Verification_Status: nftMainnet.matches(raw) && raw.Verification_Status === 'Verified_Mainnet_Snapshot'
            ? 'Verified_Mainnet_Snapshot' : 'Unverified_Reference',
        ...(nftMainnet.matches(raw) && raw.Verification_Status === 'Verified_Mainnet_Snapshot' ? {
            Custody_Address: nftMainnet.identity.custody,
            ...(typeof raw.Asset_Key === 'string' && /^0x[0-9a-fA-F]{64}$/.test(raw.Asset_Key) ? { Asset_Key: raw.Asset_Key } : {}),
            Verified_At: Number.isFinite(Date.parse(raw.Verified_At)) ? raw.Verified_At : null
        } : {})
    };
}

function nftBlockchainHistoryReference(raw) {
    try {
        return nftBlockchainReference(raw);
    } catch {
        return null;
    }
}
// NFT BLOCKCHAIN REFERENCE END

const LEVEL_PROFIT_RATES = {0: 0.000, 1: 0.013, 2: 0.018, 3: 0.023, 4: 0.028, 5: 0.033, 6: 0.038};

// 🔥 TCM-03: NFT Double-Spending & Race Condition Lock
const activeNFTOperations = new Set();

app.get('/api/nft/market', async (req, res) => {
    try {
        await nftRecoverCooldowns();
        const cacheKey = `global_nft_market`;
        const cachedMarket = await getCache(cacheKey);
        if (cachedMarket) return res.json({ success: true, source: 'redis', data: cachedMarket });

        const snap = await db.collection("NFT_Gallery").where("Status", "==", "Available").get();
        let marketList = [];
        snap.forEach(doc => marketList.push({ id: doc.id, ...doc.data() }));

        await setCache(cacheKey, marketList, 86400); 
        res.json({ success: true, source: 'db', data: marketList });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

app.get('/api/nft/history', async (req, res) => {
    try {
        await nftMainnet.refresh?.();
        const uid = req.authenticatedUid;
        if (!uid || req.query.uid !== undefined && req.query.uid !== uid) {
            return res.status(403).json({ success: false, message: 'Account ownership mismatch.' });
        }

        const cacheKey = `nft_history_full_${uid}`;
        const cachedData = await getCache(cacheKey);
        if (cachedData) return res.json({ success: true, source: 'redis', data: cachedData });

        const snap = await db.collection("NFT_History").where("UID", "==", uid).get();
        let historyArr = [];
        snap.forEach(d => historyArr.push({ id: d.id, ...d.data() }));

        historyArr.sort((a, b) => parseSafeTimestamp(b.timestamp || b.Date) - parseSafeTimestamp(a.timestamp || a.Date));

        await setCache(cacheKey, historyArr, 300); 
        res.json({ success: true, source: 'db', data: historyArr });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

// ORDER RECEIPT: public display metadata from the same committed transaction.
function nftOrderReceiptRecord(record, id = null) {
    const keys = ['Gross_micro', 'Fee_micro', 'Net_micro', 'Price_Policy', 'Price_Growth', 'UID', 'Type', 'Amount', 'Amount_micro', 'Order_ID', 'Details', 'NFT_ID',
        'Image_URL', 'docId', 'NFT_Level', 'Date', 'Blockchain', 'Reservation', 'Principal_micro',
        'Balance_Old', 'Balance_New', 'Balance_Old_micro', 'Balance_New_micro', 'Balance_Delta_micro',
        'Balance_Snapshot_Version', 'Main_Ledger_Entry_ID', 'Balance_Source', 'Balance_Scope'];
    const result = {};
    for (const key of keys) if (record[key] !== undefined) result[key] = record[key];
    if (typeof id === 'string') result.id = id;
    result.timestamp = record.Date;
    return result;
}

// NFT GROWTH SETTLEMENT START: exact 9/6/3/3 allocation for newly locked policy-v2 orders.
async function nftGrowthSettle(t, { uid, docId, settlement, uSnap, wSnap, nSnap, req }) {
    const policy = nftGrowth.readPolicy(settlement.snapshot.Price_Policy);
    const asset = nftMainnet.assetFor(settlement.snapshot.Blockchain);
    if (!asset || !nftMainnet.matches(nSnap.data().Blockchain) ||
        nSnap.data().Blockchain.Token_ID !== asset.tokenId) throw admS2Error('Reserved NFT identity needs review.', 409);
    const stateRef = db.collection('NFT_Price_State').doc(docId);
    const stateSnap = await t.get(stateRef);
    if (!stateSnap.exists) throw admS2Error('Reserved NFT quote history is missing.', 409);
    const state = nftGrowth.quote(asset, { ...nSnap.data(), Price: settlement.snapshot.Principal,
        Price_micro: settlement.snapshot.Principal_micro, Level: String(settlement.level), Price_Revision: policy.Quote_Revision }, stateSnap.data());
    const eventId = nftGrowth.eventId(docId, uid, settlement.orderId);
    const eventRef = db.collection('NFT_Price_Events').doc(eventId);
    const previousEvent = await t.get(eventRef);
    if (previousEvent.exists) throw admS2Error('This settlement has already been recorded.', 409);
    const amounts = nftGrowth.math(settlement.principalMicro, settlement.level);
    const user = uSnap.data(), wallet = wSnap.data(), recipients = new Map(), hands = [];
    let missing = 0n;
    for (const [index, hand] of ['A', 'B', 'C'].entries()) {
        const target = user['Sponsor_' + hand];
        let recipient, reason = 'No eligible sponsor';
        if (typeof target === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(target) && target !== uid) {
            if (!recipients.has(target)) {
                const account = await t.get(db.collection('Users').doc(target));
                const balance = await t.get(db.collection('Wallets').doc(target));
                const accountData = account.exists && account.data();
                recipients.set(target, { balance, eligible: Boolean(accountData && accountData.Status === 'Active' &&
                    !accountData.Account_Deleted && balance.exists), credit: 0n });
            }
            recipient = recipients.get(target);
        }
        const amount = amounts.team[index];
        if (recipient?.eligible) recipient.credit += amount;
        else missing += amount;
        hands.push({ Hand: hand, Recipient_UID: recipient?.eligible ? target : null, Amount_micro: amount.toString(),
            Disposition: recipient?.eligible ? 'Credited' : 'System_Reserved', ...(recipient?.eligible ? {} : { Reason: reason }) });
    }
    const paid = amounts.team.reduce((sum, amount) => sum + amount, 0n) - missing;
    if (paid + missing + amounts.growth !== amounts.fee || amounts.net + amounts.fee !== amounts.gross) {
        throw admS2Error('NFT allocation does not conserve gross profit.', 409);
    }
    const next = nftGrowth.next(state, amounts.growth, missing, settlement.orderId, eventId);
    const locked = admS2Balance(wallet, 'Locked_Balance');
    if (locked < settlement.principalMicro) throw admS2Error('NFT locked principal requires reconciliation.', 409);
    const newMain = nftGrowth.money(admS2Balance(wallet, 'Main_Balance') + amounts.ret);
    const net = nftGrowth.money(amounts.net), gross = nftGrowth.money(amounts.gross), fee = nftGrowth.money(amounts.fee);
    const updates = {
        Main_Balance: newMain, Locked_Balance: nftGrowth.money(locked - settlement.principalMicro),
        Total_Reserve: nftGrowth.money(admS2Balance(wallet, 'Total_Reserve') + amounts.net),
        Total_Comp: nftGrowth.money(admS2Balance(wallet, 'Total_Comp') + amounts.net),
        ...moneyV4NFTDailyUpdates(t, wSnap.ref, wallet, { Daily_Reserve: net, Daily_Comp: net })
    };
    const rankUpdates = calculateRankUpdates(user, moneyV7NextView(wallet, updates));
    const userUpdates = { 'counters.txCount': FieldValue.increment(1), 'counters.activeReservations': FieldValue.increment(-1) };
    if (rankUpdates.Rank !== undefined) userUpdates.Rank = rankUpdates.Rank;
    if (rankUpdates.Points !== undefined) updates.Points = rankUpdates.Points;
    const date = new Date().toISOString();
    const growthRecord = { Version: 1, Event_ID: eventId, Policy_Version: 2, Growth_BPS: 300,
        Price_Before_micro: state.Price_micro, Price_After_micro: next.Price_micro,
        Proposed_Price_micro: next.Proposed_Price_micro, Growth_micro: amounts.growth.toString(),
        Level_Before: state.Level, Level_After: next.Level, Revision: next.Revision, State: next.State };
    // All recipient, event and quote reads above finish before the first staged financial write.
    const saleAudit = t8MainEntry(t, uid, wallet, newMain, 'NFT sale: principal plus net profit', settlement.orderId);
    t.update(wSnap.ref, moneyV7Updates(wallet, { ...updates, ...saleAudit }, 'Wallet', 'update'));
    t.update(uSnap.ref, userUpdates);
    const cacheUIDs = [];
    for (const [target, recipient] of recipients) {
        if (!recipient.eligible || recipient.credit === 0n) continue;
        const balance = recipient.balance.data(), credit = nftGrowth.money(recipient.credit);
        const nextMain = nftGrowth.money(admS2Balance(balance, 'Main_Balance') + recipient.credit);
        const audit = t8MainEntry(t, target, balance, nextMain, 'NFT team commission', settlement.orderId);
        t.update(recipient.balance.ref, moneyV7Updates(balance, { ...audit, Main_Balance: nextMain,
            Total_Team: nftGrowth.money(admS2Balance(balance, 'Total_Team') + recipient.credit),
            Total_Comp: nftGrowth.money(admS2Balance(balance, 'Total_Comp') + recipient.credit),
            ...moneyV4NFTDailyUpdates(t, recipient.balance.ref, balance, { Daily_Team: credit, Daily_Comp: credit })
        }, 'Wallet', 'update'));
        cacheUIDs.push(target);
    }
    for (const hand of hands) if (hand.Disposition === 'Credited') {
        t.create(db.collection('Transactions').doc(), t9Record(t, { Date: date, UID: hand.Recipient_UID,
            Type: 'Team Bonus (' + hand.Hand + '-Hand)', Amount: nftGrowth.money(BigInt(hand.Amount_micro)),
            Amount_micro: hand.Amount_micro, Status: 'Success', Order_ID: settlement.orderId,
            Source_UID: uid, Source_Name: typeof user.Name === 'string' ? user.Name.trim().slice(0,200) : '',
            NFT_Policy_Version: 2, Admin_Remarks: 'From: ' + (user.Name || 'User') + ' (UID: ' + uid + ')', timestamp: FieldValue.serverTimestamp() }));
    }
    t.set(stateRef, { ...next, Updated_At: FieldValue.serverTimestamp() });
    t.create(eventRef, { Version: 1, UID: uid, Order_ID: settlement.orderId, docId, Asset_ID: asset.assetId,
        ...growthRecord, Gross_micro: amounts.gross.toString(), Fee_micro: amounts.fee.toString(),
        Net_micro: amounts.net.toString(), Team_Paid_micro: paid.toString(),
        Missing_Team_micro: missing.toString(), Hands: hands,
        Allocation_Scope: 'Off-chain fee allocation; growth and missing-team portions reserved for system accounting, not user cash credits.',
        Date: date, timestamp: FieldValue.serverTimestamp() });
    t.update(nSnap.ref, { Price: nftGrowth.money(BigInt(next.Price_micro)), Price_micro: next.Price_micro, Level: String(next.Level),
        Price_Revision: next.Revision, Price_Growth: growthRecord,
        Status: next.State === 'Active' ? 'Available' : 'PriceReview', Owner_UID: '',
        Next_Available_Time: null, Reservation_Blockchain: null, Reservation: null });
    const historyRef = db.collection('NFT_History').doc(), txRef = db.collection('Transactions').doc();
    const record = t9Record(t, { Date: date, UID: uid, Type: 'NFT Sold', Amount: nftGrowth.money(amounts.ret),
        Amount_micro: amounts.ret.toString(), Principal_micro: settlement.principalMicro.toString(),
        Gross_micro: amounts.gross.toString(), Fee_micro: amounts.fee.toString(), Net_micro: amounts.net.toString(),
        Price_Growth: growthRecord, Price_Policy: policy,
        Order_ID: settlement.orderId, Details: `Gross: ${gross} | Fee: -${fee} | Net: +${net}`,
        Blockchain: nftBlockchainHistoryReference(settlement.snapshot.Blockchain), NFT_ID: settlement.snapshot.NFT_ID,
        Image_URL: settlement.snapshot.Image_URL, Reservation: settlement.snapshot, docId, timestamp: FieldValue.serverTimestamp() });
    t.set(historyRef, record);
    t.set(txRef, t9Record(t, { Date: date, UID: uid, Type: 'NFT Profit', Amount: net, Amount_micro: amounts.net.toString(),
        Status: 'Success', Order_ID: settlement.orderId, Blockchain: nftBlockchainHistoryReference(settlement.snapshot.Blockchain), NFT_ID: settlement.snapshot.NFT_ID, timestamp: FieldValue.serverTimestamp() }));
    req.generatedHistoryId = historyRef.id; req.generatedTxId = txRef.id; req.generatedTxDate = date;
    req.generatedOrderId = settlement.orderId; req.growthCacheUIDs = cacheUIDs;
    const reserve = settlement.snapshot.Receipt_Reserve;
    return { data: { principal: nftGrowth.money(settlement.principalMicro), net, ret: nftGrowth.money(amounts.ret), fee, gross,
            Price_Growth: growthRecord },
        receipt: { Version: 1, UID: uid, Order_ID: settlement.orderId,
            reserve: reserve && reserve.UID === uid && reserve.Order_ID === settlement.orderId && reserve.docId === docId &&
                reserve.Amount_micro === settlement.principalMicro.toString() ? nftOrderReceiptRecord(reserve) : null,
            sale: nftOrderReceiptRecord(record, historyRef.id) } };
}
// NFT GROWTH SETTLEMENT END

app.post('/api/nft/reserve', async (req, res) => {
    // MEMO: TCM-NFT-AUTH-R1 | 2026-10-10 | Asia/Kolkata
    const uid = req.authenticatedUid;
    const requestedLevel = req.body?.level;
    if (typeof uid !== "string" || !uid.trim() || uid.includes("/")) {
        return res.status(401).json({ success: false, message: "Authenticated account is required." });
    }
    if (req.body && req.body.uid !== undefined && req.body.uid !== uid) {
        return res.status(403).json({ success: false, message: "Account ownership mismatch." });
    }

    // 🛡️ User Lock: ডাবল-ক্লিক স্প্যামিং ব্লক করা হলো
    if (activeNFTOperations.has(uid)) {
        return res.status(429).json({ success: false, message: "Processing... Please wait!" });
    }
    activeNFTOperations.add(uid);

    try {
        // Level bands remain unchanged; entitlement and rank are enforced by the server.
        const level = nftGuards.level(requestedLevel);
        await nftRecoverCooldowns();

        // New reservations require verified Mainnet stock at the selected level; never substitute legacy stock.
        const nftSnap = await db.collection('NFT_Gallery').where('Level', '==', level.toString())
            .where('Status', '==', 'Available').where('Blockchain.Verification_Status', '==', 'Verified_Mainnet_Snapshot').limit(1).get();
        if (nftSnap.empty) throw Object.assign(new Error('No verified Mainnet NFT available for this level.'), { statusCode: 503 });
        
        const nftDoc = nftSnap.docs[0];
        const nftData = nftDoc.data();
        let reservationBlockchain = null;
        let committedReservation;
        await nftMainnet.ensureReference?.(nftData.Blockchain);
        if (!nftMainnet.matches(nftData.Blockchain)) {
            throw Object.assign(new Error('NFT Mainnet identity is not supported. Please contact support.'), { statusCode: 503 });
        }
        const liveMainnet = await nftMainnet.verifyReference(nftData.Blockchain);
        const orderId = generateOrderId('NFT');

        const committedOrderReceipt = await db.runTransaction(async (t) => {
            const userSnap = await t.get(db.collection("Users").doc(uid));
            if (!userSnap.exists) {
                throw Object.assign(new Error("Authenticated account no longer exists."), { statusCode: 401 });
            }
            if (userSnap.data().Status === "Banned") {
                throw Object.assign(new Error("Account access is blocked."), { statusCode: 403 });
            }

            nftGuards.eligible(userSnap.data(), level);
            const wRef = db.collection("Wallets").doc(uid);
            const wSnap = await t.get(wRef);
            const nSnap = await t.get(nftDoc.ref);
            
            if (!wSnap.exists || !nSnap.exists || nSnap.data().Status !== "Available") {
                throw new Error("NFT unavailable.");
            }
            const reserveCycle = m2NFTCycle();
            await m2CheckNFTCycle(t, wSnap.data(), uid, reserveCycle);
            
            const currentNft = nSnap.data();
            if (nftGuards.level(currentNft.Level) !== level) throw new Error('NFT level changed. Please refresh.');
            // Recheck after the transactional read, before staging any financial write.
            if (currentNft.Blockchain?.Verification_Status !== 'Verified_Mainnet_Snapshot' ||
                !nftMainnet.matches(currentNft.Blockchain) || !liveMainnet ||
                currentNft.Blockchain.Token_ID !== nftData.Blockchain.Token_ID ||
                currentNft.Blockchain.Metadata_URI !== nftData.Blockchain.Metadata_URI ||
                currentNft.Blockchain.Mint_TxHash.toLowerCase() !== nftData.Blockchain.Mint_TxHash.toLowerCase() ||
                currentNft.Blockchain.Contract_Address.toLowerCase() !== nftData.Blockchain.Contract_Address.toLowerCase()) {
                throw new Error('NFT identity changed. Verify and retry.');
            }
            reservationBlockchain = nftMainnet.reference(liveMainnet);
            const priceMicro = moneyV7Amount(currentNft, 'Price', 'Price_micro', 'NFT reservation price');
            nftGuards.priceInBand(priceMicro, level);
            const price = admS2Money(priceMicro);
            committedReservation = nftGuards.create({ uid, orderId, selectedLevel: level, principalMicro: priceMicro,
                nft: currentNft, blockchain: reservationBlockchain });
            let growthQuote;
            if (nftGrowth.POLICY_VERSION === 2) {
                const asset = nftMainnet.assetFor(currentNft.Blockchain);
                if (!asset) throw admS2Error('NFT approved configuration is missing.', 409);
                const ref = db.collection('NFT_Price_State').doc(nftDoc.id);
                const saved = await t.get(ref);
                const state = nftGrowth.quote(asset, currentNft, saved.exists ? saved.data() : null);
                committedReservation.Price_Policy = nftGrowth.policy(state.Revision);
                growthQuote = { ref, state, missing: !saved.exists };
            }
            const mainMicro = admS2Balance(wSnap.data(), 'Main_Balance');
            if (mainMicro < priceMicro) throw new Error(`Insufficient Balance. Need ${price} ?`);
            const nextMain = admS2Money(mainMicro - priceMicro);

            if (growthQuote?.missing) t.create(growthQuote.ref, growthQuote.state);
            const reserveMainAudit = t8MainEntry(t, uid, wSnap.data(), nextMain, 'NFT reservation', orderId);
            const txDateIso = new Date().toISOString();
            // Reuse the staged audit in the existing reservation write; no extra reads/writes.
            committedReservation.Receipt_Reserve = nftOrderReceiptRecord(t9Record(t, {
                Date: txDateIso, UID: uid, Type: 'NFT Reserve', Amount: price,
                Amount_micro: committedReservation.Principal_micro, Order_ID: orderId,
                NFT_ID: committedReservation.NFT_ID, Image_URL: committedReservation.Image_URL,
                NFT_Level: level, docId: nftDoc.id, Blockchain: reservationBlockchain,
                ...(committedReservation.Price_Policy ? { Price_Policy: committedReservation.Price_Policy } : {})
            }));
            t.update(wRef, moneyV7Updates(wSnap.data(), {
                ...reserveMainAudit,
                Main_Balance: nextMain,
                Locked_Balance: admS2Money(admS2Balance(wSnap.data(), 'Locked_Balance') + priceMicro),
                Last_NFT_Reserve_Cycle: reserveCycle.key
            }, 'Wallet', 'update'));
            t.update(nftDoc.ref, { Status: "Reserved", Owner_UID: uid, Reservation_Blockchain: reservationBlockchain, Reservation: committedReservation });
            t.update(db.collection("Users").doc(uid), { "counters.txCount": FieldValue.increment(1), "counters.activeReservations": FieldValue.increment(1) });
            
            const historyRef = db.collection("NFT_History").doc();
            req.generatedHistoryId = historyRef.id;
            req.generatedTxDate = txDateIso;

            const reserveHistoryRecord = t9Record(t, { 
                Date: txDateIso, UID: uid, Type: "NFT Reserve", Amount: price, Order_ID: orderId, Details: "Reserved NFT", Amount_micro: committedReservation.Principal_micro, NFT_ID: committedReservation.NFT_ID, Image_URL: committedReservation.Image_URL, docId: nftDoc.id, NFT_Level: level, Blockchain: reservationBlockchain, Reservation: committedReservation, timestamp: FieldValue.serverTimestamp() 
            });
            t.set(historyRef, reserveHistoryRecord);
            return { Version: 1, UID: uid, Order_ID: orderId,
                reserve: nftOrderReceiptRecord(reserveHistoryRecord, historyRef.id), sale: null };
        });
        
        for (const target of req.growthCacheUIDs || []) await clearUserCache(target);
        await clearUserCache(uid); 
        if (typeof redisClient !== 'undefined' && redisClient.isReady) await redisClient.del(`nft_history_full_${uid}`);
        
        await nftInvalidateMarket();
        // Return only values from the successful transaction attempt.
        res.json({
            success: true,
            orderReceipt: committedOrderReceipt,
            nftData: { id: committedReservation.NFT_ID, price: committedReservation.Principal, img: committedReservation.Image_URL,
                orderId, docId: nftDoc.id, level: committedReservation.Level, Blockchain: reservationBlockchain,
                Price_Policy: committedReservation.Price_Policy || null },
            injectionData: { id: req.generatedHistoryId, Date: req.generatedTxDate, timestamp: Date.now() }
        });
    } catch (e) { 
        const status = [401, 403, 409, 503].includes(e.statusCode) ? e.statusCode : 400;
        res.status(status).json({ success: false, message: e.message });
    } finally {
        activeNFTOperations.delete(uid); // 🔓 আনলক
    }
});

app.post('/api/nft/sell', async (req, res) => {
    // MEMO: TCM-NFT-AUTH-R1 | 2026-10-10 | Asia/Kolkata
    const uid = req.authenticatedUid;
    const { docId, orderId } = req.body || {};
    if (typeof uid !== "string" || !uid.trim() || uid.includes("/")) {
        return res.status(401).json({ success: false, message: "Authenticated account is required." });
    }
    if (req.body && req.body.uid !== undefined && req.body.uid !== uid) {
        return res.status(403).json({ success: false, message: "Account ownership mismatch." });
    }

    // 🛡️ User Lock: ডাবল-ক্লিক স্প্যামিং ব্লক
    if (activeNFTOperations.has(uid)) {
        return res.status(429).json({ success: false, message: "Selling in progress. Please wait!" });
    }
    activeNFTOperations.add(uid);

    try {
        await nftMainnet.refresh?.();
        let receiptData = {};
        
        const committedOrderReceipt = await db.runTransaction(async (t) => {
            incomeDayStates.delete(t);
            const uSnap = await t.get(db.collection("Users").doc(uid));
            if (!uSnap.exists) {
                throw Object.assign(new Error("Authenticated account no longer exists."), { statusCode: 401 });
            }
            if (uSnap.data().Status === "Banned") {
                throw Object.assign(new Error("Account access is blocked."), { statusCode: 403 });
            }

            const wSnap = await t.get(db.collection("Wallets").doc(uid));
            const nSnap = await t.get(db.collection("NFT_Gallery").doc(docId));
            
            if(!wSnap.exists || !uSnap.exists || !nSnap.exists || nSnap.data().Owner_UID !== uid || nSnap.data().Status !== "Reserved") throw new Error("NFT unavailable to sell.");

            const uD = uSnap.data(); const wD = wSnap.data(); const nftData = nSnap.data();
            const settlement = await nftGuards.resolve(t, db, nftData, docId, uid, orderId);

            if (settlement.snapshot.Price_Policy !== undefined) {
                const outcome = await nftGrowthSettle(t, { uid, docId, settlement, uSnap, wSnap, nSnap, req });
                receiptData = outcome.data;
                return outcome.receipt;
            }
            // Existing reservations retain their original v1 settlement and 12/6/3 terms.
            const spA = uD.Sponsor_A ? await t.get(db.collection("Wallets").doc(uD.Sponsor_A)) : null;
            const spB = uD.Sponsor_B ? await t.get(db.collection("Wallets").doc(uD.Sponsor_B)) : null;
            const spC = uD.Sponsor_C ? await t.get(db.collection("Wallets").doc(uD.Sponsor_C)) : null;

            const principalMicro = settlement.principalMicro;
            const principal = admS2Money(principalMicro);
            const level = settlement.level;
            const gross = parseFloat((principal * (LEVEL_PROFIT_RATES[level] || 0)).toFixed(2));
            const fee = parseFloat((gross * 0.21).toFixed(2));
            const net = parseFloat((gross - fee).toFixed(2));
            const netMicro = admS2Micro(net, 'NFT net profit');
            const retMicro = principalMicro + netMicro;
            const ret = admS2Money(retMicro);
            receiptData = { principal, net, ret, fee, gross };

            const lockedMicro = admS2Balance(wD, 'Locked_Balance');
            if (lockedMicro < principalMicro) {
                throw admS2Error('NFT locked principal requires reconciliation.', 409);
            }
            const newMainBal = admS2Money(admS2Balance(wD, 'Main_Balance') + retMicro);
            const newLockedBal = admS2Money(lockedMicro - principalMicro);

            let wUpdates = {
                Main_Balance: newMainBal,
                Locked_Balance: newLockedBal,
                Total_Reserve: admS2Money(admS2Balance(wD, 'Total_Reserve') + netMicro),
                Total_Comp: admS2Money(admS2Balance(wD, 'Total_Comp') + netMicro),
                ...moneyV4NFTDailyUpdates(t, wSnap.ref, wD, {
                    Daily_Reserve: net,
                    Daily_Comp: net
                })
            };
            let uUpdates = {};

            let rankRes = calculateRankUpdates(uD, moneyV7NextView(wD, { Main_Balance: newMainBal, Locked_Balance: newLockedBal }));
            if (rankRes.Rank !== undefined) uUpdates.Rank = rankRes.Rank;
            if (rankRes.Points !== undefined) wUpdates.Points = rankRes.Points;

            uUpdates["counters.txCount"] = FieldValue.increment(1);
            uUpdates["counters.activeReservations"] = FieldValue.increment(-1);

            const t8SaleAudit = t8MainEntry(t, uid, wD, newMainBal, 'NFT sale: principal plus net profit', settlement.orderId);
            t.update(wSnap.ref, moneyV7Updates(wD, { ...wUpdates, ...t8SaleAudit }, 'Wallet', 'update'));
            if (Object.keys(uUpdates).length > 0) t.update(uSnap.ref, uUpdates);

            const txDateIso = new Date().toISOString();
            const senderDetails = `${uD.Name || 'User'} (UID: ${uid})`;
            const finalOrderId = settlement.orderId;
            const t8TeamAudit = t8TeamEntries(t, [[spA, 0.12], [spB, 0.06], [spC, 0.03]], gross, finalOrderId,
                new Map([[uid, moneyV7NextView(wD, { ...wUpdates, ...t8SaleAudit })]]));

            if(spA && spA.exists) { 
                let earnA = parseFloat((gross * 0.12).toFixed(2)); 
                t.update(spA.ref, moneyV7Updates(spA.data(), {
                    ...t8TeamAudit.get(spA.id),
                    ...moneyV4NFTDailyUpdates(t, spA.ref, spA.data(), {
                        Daily_Team: earnA,
                        Daily_Comp: earnA
                    })
                }, 'Wallet', 'update')); 
                t.set(db.collection("Transactions").doc(), t9Record(t, { Date: txDateIso, UID: spA.id, Type: "Team Bonus (A-Hand)", Amount: earnA, Status: "Success", Order_ID: finalOrderId, Admin_Remarks: `From: ${senderDetails}`, timestamp: FieldValue.serverTimestamp() })); 
                clearUserCache(spA.id);
            }
            if(spB && spB.exists) { 
                let earnB = parseFloat((gross * 0.06).toFixed(2)); 
                t.update(spB.ref, moneyV7Updates(spB.data(), {
                    ...t8TeamAudit.get(spB.id),
                    ...moneyV4NFTDailyUpdates(t, spB.ref, spB.data(), {
                        Daily_Team: earnB,
                        Daily_Comp: earnB
                    })
                }, 'Wallet', 'update')); 
                t.set(db.collection("Transactions").doc(), t9Record(t, { Date: txDateIso, UID: spB.id, Type: "Team Bonus (B-Hand)", Amount: earnB, Status: "Success", Order_ID: finalOrderId, Admin_Remarks: `From: ${senderDetails}`, timestamp: FieldValue.serverTimestamp() })); 
                clearUserCache(spB.id);
            }
            if(spC && spC.exists) { 
                let earnC = parseFloat((gross * 0.03).toFixed(2)); 
                t.update(spC.ref, moneyV7Updates(spC.data(), {
                    ...t8TeamAudit.get(spC.id),
                    ...moneyV4NFTDailyUpdates(t, spC.ref, spC.data(), {
                        Daily_Team: earnC,
                        Daily_Comp: earnC
                    })
                }, 'Wallet', 'update')); 
                t.set(db.collection("Transactions").doc(), t9Record(t, { Date: txDateIso, UID: spC.id, Type: "Team Bonus (C-Hand)", Amount: earnC, Status: "Success", Order_ID: finalOrderId, Admin_Remarks: `From: ${senderDetails}`, timestamp: FieldValue.serverTimestamp() })); 
                clearUserCache(spC.id);
            }

            // Availability changes atomically with the completed financial settlement.
            t.update(nSnap.ref, { Status: "Available", Owner_UID: "", Next_Available_Time: null, Reservation_Blockchain: null, Reservation: null });
            
            const historyRef = db.collection("NFT_History").doc();
            const txRef = db.collection("Transactions").doc();
            req.generatedHistoryId = historyRef.id;
            req.generatedTxId = txRef.id;
            req.generatedTxDate = txDateIso;
            req.generatedOrderId = finalOrderId;

            const saleHistoryRecord = t9Record(t, { Date: txDateIso, UID: uid, Type: "NFT Sold", Amount: ret, Order_ID: finalOrderId, Details: `Gross: ${gross} | Fee: -${fee} | Net: +${net}`, Blockchain: nftBlockchainHistoryReference(settlement.snapshot.Blockchain), NFT_ID: settlement.snapshot.NFT_ID, Image_URL: settlement.snapshot.Image_URL, Reservation: settlement.snapshot, Principal_micro: principalMicro.toString(), docId, timestamp: FieldValue.serverTimestamp() });
            t.set(historyRef, saleHistoryRecord);
            t.set(txRef, t9Record(t, { Date: txDateIso, UID: uid, Type: "NFT Profit", Amount: net, Status: "Success", Order_ID: finalOrderId, Blockchain: nftBlockchainHistoryReference(settlement.snapshot.Blockchain), NFT_ID: settlement.snapshot.NFT_ID, timestamp: FieldValue.serverTimestamp() }));
            const savedReserve = settlement.snapshot.Receipt_Reserve;
            const matchingReserve = savedReserve && savedReserve.UID === uid &&
                savedReserve.Order_ID === finalOrderId && savedReserve.Type === 'NFT Reserve' &&
                savedReserve.Amount_micro === principalMicro.toString() && savedReserve.docId === docId;
            return { Version: 1, UID: uid, Order_ID: finalOrderId,
                reserve: matchingReserve ? nftOrderReceiptRecord(savedReserve) : null,
                sale: nftOrderReceiptRecord(saleHistoryRecord, historyRef.id) };
        });

        for (const target of req.growthCacheUIDs || []) await clearUserCache(target);
        await clearUserCache(uid); 
        if (typeof redisClient !== 'undefined' && redisClient.isReady) await redisClient.del(`nft_history_full_${uid}`);
        
        await nftInvalidateMarket();
        // Existing credit, debt and commission math is unchanged.
        res.json({
            success: true,
            data: receiptData,
            orderReceipt: committedOrderReceipt,
            injectionData: { id: req.generatedTxId, Order_ID: req.generatedOrderId, Date: req.generatedTxDate, timestamp: Date.now() }
        });
    } catch (e) { 
        res.status([401, 403, 409, 503].includes(e.statusCode) ? e.statusCode : 400).json({ success: false, code: e.code, message: e.message }); 
    } finally {
        activeNFTOperations.delete(uid); // 🔓 আনলক
    }
});

const cron = require('node-cron');
// =================================================================================
// 🚀 MODULE: STAKING AUTOMATION & MIDNIGHT RESET ENGINE (TIMEZONE AWARE)
// =================================================================================

// MEMO TCM-STK-003 | 2026-10-09 23:27 IST | Asia/Kolkata
// Shared daily reset fields. Lifetime balances are never reset.
// MEMO TCM-STK-009 | 2026-10-10 00:35 IST | Asia/Kolkata
// MEMO TCM-STK-012 | 2026-10-10 01:15 IST | Asia/Kolkata
const incomeDayStates = new WeakMap();

const buildISTDailyIncomeUpdates = (
    t,
    walletRef,
    wallet,
    credits,
    dayKey = moment().tz("Asia/Kolkata").format("YYYY-MM-DD")
) => {
    const fields = [
        "Daily_Stake", "Daily_Comp", "Daily_Earn",
        "Daily_Team", "Daily_Reserve", "Daily_Airdrop", "Daily_Dividend"
    ];

    let states = incomeDayStates.get(t);
    if (!states) {
        states = new Map();
        incomeDayStates.set(t, states);
    }

    let state = states.get(walletRef.path);

    if (!state) {
        const previousDay = wallet.Last_Reset_Day;

        if (
            previousDay !== undefined &&
            previousDay !== "" &&
            (
                typeof previousDay !== "string" ||
                !/^\d{4}-\d{2}-\d{2}$/.test(previousDay)
            )
        ) {
            throw new Error("Invalid wallet reset day.");
        }

        if (previousDay && previousDay > dayKey) {
            throw new Error("Wallet reset day is ahead of income day.");
        }

        state = { Last_Reset_Day: dayKey };

        for (const field of fields) {
            const value = previousDay === dayKey
                ? admS2Money(admS2Balance(wallet, field))
                : 0;

            if (!Number.isFinite(value) || value < 0) {
                throw new Error("Invalid daily counter: " + field);
            }

            state[field] = value;
        }

        states.set(walletRef.path, state);
    }

    if (state.Last_Reset_Day !== dayKey) {
        throw new Error("Income day changed inside transaction.");
    }

    for (const [field, amount] of Object.entries(credits)) {
        if (
            !fields.includes(field) ||
            !Number.isFinite(amount) ||
            amount < 0
        ) {
            throw new Error("Invalid daily income credit.");
        }

        const next = moneyV1ReadLegacy(state[field], field).micro + admS2Micro(amount, 'daily income credit');
        state[field] = admS2Money(next);
    }

    return { ...state };
};

const nextStakingTxCount = (user) => {
    const raw = user.counters && user.counters.txCount;
    const count = raw === undefined ? 0 : Number(raw);

    if (
        (raw !== undefined && typeof raw !== "number" && typeof raw !== "string") ||
        (typeof raw === "string" && raw.trim() === "") ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        count >= Number.MAX_SAFE_INTEGER
    ) {
        throw new Error("Invalid transaction counter.");
    }

    return count + 1;
};

const stakingDailyResetFields = (dayKey) => ({
    Daily_Stake: 0,
    Daily_Comp: 0,
    Daily_Earn: 0,
    Daily_Team: 0,
    Daily_Reserve: 0,
    Daily_Airdrop: 0,
    Daily_Dividend: 0,
    Last_Reset_Day: dayKey
});

const invalidateStakingWalletCache = async (uid) => {
    try {
        if (typeof redisClient !== "undefined" && redisClient.isReady) {
            await redisClient.del(`init_data_full_${uid}`);
        }
    } catch (error) {
        console.error("[STAKING CACHE] Invalidation failed:", uid, error);
    }
    try { global.io?.to(uid).emit('dashboard_invalidated', { uid }); } catch (_) {}
};

// R3: Dispatch state is cached; financial settlement remains transactional in Firestore.
// Set TCM_RECOVERY_START_DAY explicitly to the first reviewed recovery day.
const r3Recovery = { running: false, completed: new Set(), retryAt: 0, failures: 0, cursor: 0, outage: false, lastSignal: 0 };
const r3Day = time => moment(time).tz('Asia/Kolkata').format('YYYY-MM-DD');
const r3NextDay = day => new Date(Date.parse(day + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
const r3ValidDay = day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    Number.isFinite(Date.parse(day + 'T00:00:00Z')) && new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) === day;
const r3GlobalOutage = error => [8, 14, 4, 7, 16, 'PERMISSION_DENIED', 'UNAUTHENTICATED', 'RESOURCE_EXHAUSTED', 'UNAVAILABLE', 'DEADLINE_EXCEEDED',
    'resource-exhausted', 'unavailable', 'deadline-exceeded'].includes(error?.code);

function r3SignalDatabaseRecovery() {
    if (r3Recovery.outage && !r3Recovery.running && Date.now() - r3Recovery.lastSignal >= 30000) {
        r3Recovery.lastSignal = Date.now();
        r3Recovery.outage = false;
        r3Recovery.retryAt = 0;
        void r3RunRecovery();
    }
}
async function r3ResetDay(day, counts = {}) {
    let cursor = null;
    let failed = 0;
    while (true) {
        let query = db.collection('Wallets').orderBy(r3FieldPath.documentId()).limit(100);
        if (cursor) query = query.startAfter(cursor);
        const page = await query.get();
        if (page.empty) break;
        for (const doc of page.docs) {
            try {
                const changed = await db.runTransaction(async t => {
                    const current = await t.get(doc.ref);
                    if (!current.exists) return false;
                    const previous = current.data().Last_Reset_Day;
                    if (previous && !r3ValidDay(previous)) throw new Error('Invalid wallet reset day.');
                    if (previous && previous >= day) return false;
                    t.update(doc.ref, moneyV7Updates(current.data(), stakingDailyResetFields(day), 'Wallet', 'update'));
                    return true;
                });
                if (changed) {
                    counts.resetCount = (counts.resetCount || 0) + 1;
                    await invalidateStakingWalletCache(doc.id);
                }
            } catch (error) {
                if (r3GlobalOutage(error)) throw error;
                failed++;
                console.error('[R3 RESET] Pending wallet:', doc.id, error.message);
            }
        }
        cursor = page.docs[page.docs.length - 1];
    }
    return failed === 0;
}

function r3EntitlementQuery(day, uid) {
    const scheduledTime = Date.parse(day + 'T00:00:00Z'); // 05:30 Asia/Kolkata.
    let query = db.collection('Staking_Contracts')
        .where('status', 'in', ['Active', 'Matured', 'Completed'])
        .where('startTime', '<=', scheduledTime).where('unlockTime', '>', scheduledTime);
    if (uid) query = query.where('UID', '==', uid);
    return query.orderBy('startTime').orderBy('unlockTime')
        .orderBy(r3FieldPath.documentId()).limit(100);
}

async function r3PayUserDay(uid, refs, day) {
    const scheduledTime = Date.parse(day + 'T00:00:00Z');
    const rates = { 7: 120, 15: 150, 30: 200, 60: 250 };
    const walletRef = db.collection('Wallets').doc(uid);
    const userRef = db.collection('Users').doc(uid);
    const ledgerRef = db.collection('Transactions').doc(`TX-ROI-${uid}-${day}`);
    const result = await db.runTransaction(async t => {
        // The SDK can reuse the transaction object on a retry: discard attempt-local accumulation.
        incomeDayStates.delete(t);
        const ledger = await t.get(ledgerRef);
        if (ledger.exists) {
            const row = ledger.data();
            if (row.UID !== uid || row.Type !== 'Staking Reward' || row.Status !== 'Success' ||
                !Number.isFinite(Number(row.Amount)) || Number(row.Amount) <= 0) {
                throw new Error('ROI ledger identity/status conflict; manual reconciliation required.');
            }
            // Never augment an old aggregate ledger whose component allocation is unknown.
            return { paid: false, legacy: row.Settlement_Version !== 'R3' };
        }
        const wallet = await t.get(walletRef);
        const user = await t.get(userRef);
        if (!user.exists || user.data().Account_Deleted === true) {
            const reviewRef = db.collection('AdminLogs').doc('ORPHAN-ROI-' + uid);
            const review = await t.get(reviewRef);
            if (!review.exists) {
                t.create(reviewRef, { Admin_Name: 'System', Actor_UID: 'SYSTEM', Target_UID: uid,
                    Action_Type: 'Orphan ROI Review Required', Review_Status: 'Open',
                    Reason: user.exists ? 'Deleted account' : 'Missing user account',
                    First_Earning_Day: day,
                    Details: 'ROI withheld. Review retained staking contracts and financial history; no funds or contracts were changed.',
                    timestamp: FieldValue.serverTimestamp() });
            }
            return { paid: false, legacy: false, skipped: 'orphan-account', reviewCreated: !review.exists };
        }
        if (!wallet.exists) {
            throw new Error('Existing account has no wallet; financial reconciliation required.');
        }
        if (refs.length > 150) {
            throw new Error('Recovery user exceeds the reviewed transaction size; manual settlement required.');
        }
        const snapshots = [];
        for (const ref of refs) snapshots.push(await t.get(ref));
        let roiNumerator = 0n;
        const components = [];
        for (const snapshot of snapshots) {
            if (!snapshot.exists) throw new Error('Recovery contract disappeared.');
            const stake = snapshot.data();
            const start = Number(stake.startTime);
            const unlock = Number(stake.unlockTime);
            if (stake.UID !== uid || !['Active', 'Matured', 'Completed'].includes(stake.status) ||
                !Number.isSafeInteger(start) || !Number.isSafeInteger(unlock) || unlock <= start || start <= 0) {
                throw new Error('Invalid recovery contract identity or times.');
            }
            if (start > scheduledTime || unlock <= scheduledTime) continue;
            const rate = rates[Number(stake.duration)];
            const principalMicro = moneyV7Amount(stake, 'amount', 'amount_micro', 'ROI staking principal');
            const amount = admS2Money(principalMicro);
            if (!rate || Number(stake.dailyRoi) !== rate / 100 || !Number.isFinite(amount) || amount <= 0 ||
                typeof stake.Card_Number !== 'string' || !stake.Card_Number.trim()) {
                throw new Error('Recovery contract lacks a verified standard plan.');
            }
            const tier = { 7: 'silver', 15: 'gold', 30: 'platinum', 60: 'diamond' }[Number(stake.duration)];
            const immutablePlan = stake.Plan_Version === 'TCM-PLANS-1' && stake.Plan_Tier === tier &&
                stake.Plan_Rate_Bps === rate && stake.Plan_Duration_Days === Number(stake.duration);
            if (!immutablePlan) {
                const cards = wallet.data().cards;
                const matches = cards && typeof cards === 'object' && !Array.isArray(cards)
                    ? Object.keys(rates).filter(days => {
                        const name = { 7: 'silver', 15: 'gold', 30: 'platinum', 60: 'diamond' }[days];
                        return typeof cards[name] === 'string' && cards[name].trim() === stake.Card_Number.trim();
                    }) : [];
                if (matches.length !== 1 || Number(matches[0]) !== Number(stake.duration)) {
                    throw new Error('Legacy contract ownership cannot be reconstructed; manual reconciliation required.');
                }
            }
            const contributionNumerator = principalMicro * BigInt(rate);
            roiNumerator += contributionNumerator;
            components.push({
                contractId: snapshot.id,
                amount: Number(contributionNumerator) / 10000000000,
                rateBps: rate,
                Principal_micro: principalMicro.toString(),
                Exact_Amount_Units_1e10: contributionNumerator.toString()
            });
        }
        if (!components.length) return { paid: false, legacy: false };
        if (roiNumerator <= 0n) throw new Error('Invalid recovery profit.');
        // Approved policy: aggregate first; round half up once to six decimals.
        const profitMicro = (roiNumerator + 5000n) / 10000n;
        if (profitMicro <= 0n) throw admS2Error('ROI is below the supported payout precision.');
        const profit = admS2Money(profitMicro);
        const roundingAdjustment = profitMicro * 10000n - roiNumerator;
        const nextMain = admS2Money(admS2Balance(wallet.data(), 'Main_Balance') + profitMicro);
        const nextStake = admS2Money(admS2Balance(wallet.data(), 'Total_Stake') + profitMicro);
        const nextComp = admS2Money(admS2Balance(wallet.data(), 'Total_Comp') + profitMicro);
        const settledAt = Date.now();
        const postingDay = r3Day(settledAt);
        const daily = moneyV4NFTDailyUpdates(t, walletRef, wallet.data(), {
            Daily_Stake: profit, Daily_Comp: profit
        }, postingDay);
        const t9ROIAudit = t8MainEntry(t, uid, wallet.data(), nextMain, 'Staking ROI', `ROI-${day}`);
        t.create(ledgerRef, t9Record(t, {
            id: ledgerRef.id, UID: uid, Type: 'Staking Reward', Amount: profit, Status: 'Success',
            Order_ID: `ROI-${day}`, Date: new Date(settledAt).toISOString(), timestamp: FieldValue.serverTimestamp(),
            Scheduled_Time: scheduledTime, Earning_Day: day, Posting_Day: postingDay,
            Settlement_Version: 'R3', Components: components,
            Amount_micro: profitMicro.toString(),
            Exact_Amount_Units_1e10: roiNumerator.toString(),
            Rounding_Adjustment_Units_1e10: roundingAdjustment.toString(),
            Rounding_Policy: 'USER_DAY_HALF_UP_6DP_V1',
            Details: day === postingDay ? 'Daily Staking Profit Added' : `Recovered staking profit for ${day}`
        }));
        t.update(walletRef, moneyV7Updates(wallet.data(), {
            ...daily, ...t9ROIAudit,
            Main_Balance: nextMain,
            Total_Stake: nextStake, Total_Comp: nextComp
        }, 'Wallet', 'update'));
        t.update(userRef, { 'counters.txCount': nextStakingTxCount(user.data()) });
        return { paid: true, legacy: false };
    });
    if (result.paid) await invalidateStakingWalletCache(uid);
    if (result.legacy) console.warn('[R3 ROI] Existing aggregate ledger not reallocated:', uid, day);
    return result;
}

async function r3ROIForDay(day, counts = {}) {
    const users = new Map();
    let cursor = null;
    let failed = 0;
    while (true) {
        let query = r3EntitlementQuery(day);
        if (cursor) query = query.startAfter(cursor);
        const page = await query.get();
        if (page.empty) break;
        for (const doc of page.docs) {
            const uid = doc.data().UID;
            if (typeof uid !== 'string' || !uid || uid.includes('/')) {
                failed++;
                console.error('[R3 ROI] Invalid contract UID:', doc.id);
                continue;
            }
            if (!users.has(uid)) users.set(uid, []);
            users.get(uid).push(doc.ref);
        }
        cursor = page.docs[page.docs.length - 1];
    }
    for (const [uid, refs] of users) {
        try {
            const result = await r3PayUserDay(uid, refs, day);
            if (result.paid) counts.roiPaidCount = (counts.roiPaidCount || 0) + 1;
            if (result.skipped === 'orphan-account') {
                counts.orphanSkippedCount = (counts.orphanSkippedCount || 0) + 1;
                if (result.reviewCreated) {
                    console.warn('[R3 ROI] Orphan review opened; ROI withheld and financial records retained:', uid, day);
                }
            }
        }
        catch (error) {
            if (r3GlobalOutage(error)) throw error;
            failed++;
            console.error('[R3 ROI] Pending user/day:', uid, day, error.message);
        }
    }
    return failed === 0;
}

async function r3MatureContracts() {
    let cursor = null;
    const now = Date.now();
    while (true) {
        let query = db.collection('Staking_Contracts').where('status', '==', 'Active')
            .where('unlockTime', '<=', now).orderBy('unlockTime')
            .orderBy(r3FieldPath.documentId()).limit(100);
        if (cursor) query = query.startAfter(cursor);
        const page = await query.get();
        if (page.empty) break;
        for (const doc of page.docs) {
            const uid = await db.runTransaction(async t => {
                const current = await t.get(doc.ref);
                if (!current.exists) return null;
                const row = current.data();
                const unlock = Number(row.unlockTime);
                if (row.status !== 'Active' || !Number.isSafeInteger(unlock) || unlock <= 0 || unlock > Date.now()) return null;
                t.update(doc.ref, { status: 'Matured' });
                return row.UID;
            });
            if (typeof uid === 'string' && uid) await invalidateStakingWalletCache(uid);
        }
        cursor = page.docs[page.docs.length - 1];
    }
}

async function r3RunRecovery(options = {}) {
    const manual = options.manual === true;
    const counts = { resetCount: 0, roiPaidCount: 0 };
    if (r3Recovery.running) {
        return { complete: false, status: 409, message: 'Settlement recovery is already running.', ...counts };
    }
    if (!manual && Date.now() < r3Recovery.retryAt) return;
    const start = process.env.TCM_RECOVERY_START_DAY;
    if (!r3ValidDay(start)) {
        if (!r3Recovery.configurationWarned) console.error('[R3] Set TCM_RECOVERY_START_DAY before enabling settlement.');
        r3Recovery.configurationWarned = true;
        return {
            complete: false,
            status: 503,
            message: 'A valid TCM_RECOVERY_START_DAY is required before settlement recovery.',
            ...counts
        };
    }
    r3Recovery.running = true;
    let incomplete = false;
    try {
        const now = Date.now();
        const today = r3Day(now);
        const lastDue = new Date(Math.floor(now / 86400000) * 86400000).toISOString().slice(0, 10);
        if (manual) {
            if (start > today) {
                return { complete: false, status: 503,
                    message: 'Recovery start day is later than today. Review the configuration.', ...counts };
            }
            // Recheck today's durable wallet/ROI markers, even if the dispatch cache says complete.
            // The existing transactions prevent duplicate settlement across server instances.
            const resetComplete = await r3ResetDay(today, counts);
            const roiDeferred = today > lastDue;
            const roiComplete = roiDeferred || await r3ROIForDay(today, counts);
            const complete = resetComplete && roiComplete;
            return {
                complete,
                status: complete ? 200 : 503,
                message: complete ? 'Settlement recovery completed' :
                    'Settlement recovery is incomplete. Some accounts require review; see server logs.',
                roiDeferred,
                ...counts
            };
        }
        const tasks = [{ kind: 'reset', day: today }];
        for (let day = start; day <= lastDue; day = r3NextDay(day)) tasks.push({ kind: 'roi', day });
        let performedROI = false;
        const dispatch = async task => {
            const key = `tcm:r3:complete:${start}:${task.kind}:${task.day}`;
            if (r3Recovery.completed.has(key)) return { work: false, complete: true };
            if (await m2RedisCommand(() => redisClient.get(key)) === '1') {
                r3Recovery.completed.add(key);
                return { work: false, complete: true };
            }
            const complete = task.kind === 'reset' ? await r3ResetDay(task.day)
                : task.kind === 'maturity' ? (await r3MatureContracts(), true) : await r3ROIForDay(task.day);
            if (task.kind === 'roi') performedROI = true;
            if (complete) {
                r3Recovery.completed.add(key);
                await m2RedisCommand(() => redisClient.set(key, '1'));
            }
            return { work: true, complete };
        };
        if (!(await dispatch(tasks[0])).complete) incomplete = true;
        if (r3Recovery.priorityToday === true && today <= lastDue && today >= start) {
            const outcome = await dispatch({ kind: 'roi', day: today });
            if (outcome.complete) r3Recovery.priorityToday = false;
            else incomplete = true;
        }
        const roiTasks = tasks.slice(1);
        let work = 0;
        if (r3Recovery.cursor >= roiTasks.length) r3Recovery.cursor = 0;
        for (let index = r3Recovery.cursor; index < roiTasks.length; index++) {
            const outcome = await dispatch(roiTasks[index]);
            r3Recovery.cursor = index + 1;
            if (!outcome.complete) incomplete = true;
            if (outcome.work && ++work >= 3 && index + 1 < roiTasks.length) {
                incomplete = true;
                break;
            }
        }
        // A completed later day never erases an unresolved earlier day.
        if (r3Recovery.cursor >= roiTasks.length) r3Recovery.cursor = 0;
        if (r3Recovery.cursor === 0 && roiTasks.some(task => !r3Recovery.completed.has(
            `tcm:r3:complete:${start}:${task.kind}:${task.day}`))) incomplete = true;
        if (lastDue >= start && !(await dispatch({ kind: 'maturity', day: lastDue })).complete) incomplete = true;
        r3Recovery.outage = false;
        r3Recovery.failures = incomplete ? r3Recovery.failures + 1 : 0;
        r3Recovery.retryAt = incomplete ? Date.now() + 300000 : 0;
    } catch (error) {
        r3Recovery.failures++;
        r3Recovery.outage = r3GlobalOutage(error);
        const delay = Math.min(3600000, 30000 * 2 ** Math.min(r3Recovery.failures - 1, 7));
        r3Recovery.retryAt = Date.now() + delay + Math.floor(Math.random() * 5000);
        console.error('[R3 RECOVERY] Pending; retry scheduled:', error.code || 'UNKNOWN', error.message);
        if (manual) {
            return {
                complete: false,
                status: 503,
                message: e4MissingIndex(error)
                    ? 'Settlement recovery is pending while Firestore indexes build. Already committed settlements remain safe.'
                    : 'Settlement recovery is incomplete. Check database availability and server logs before retrying.',
                ...counts
            };
        }
    } finally {
        r3Recovery.running = false;
    }
}

cron.schedule('0 0 * * *', () => { r3Recovery.retryAt = 0; void r3RunRecovery(); }, { timezone: 'Asia/Kolkata' });
cron.schedule('30 5 * * *', () => {
    r3Recovery.priorityToday = true;
    r3Recovery.retryAt = 0;
    void r3RunRecovery();
}, { timezone: 'Asia/Kolkata' });
setTimeout(() => { void r3RunRecovery(); }, 1000);
setInterval(() => { void r3RunRecovery(); }, 60000).unref();

app.post('/api/admin/system/trigger-recovery', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const uid = req.authenticatedUid;
    const snapshot = req.authenticatedUserDoc;
    const authorization = req.headers.authorization || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const actor = snapshot && snapshot.exists && snapshot.id === uid ? snapshot.data() : null;
    if (!uid || !token || !actor || actor.Token !== token) {
        return res.status(401).json({ success: false, message: 'Session expired. Please sign in again.' });
    }
    if (actor.Role !== 'Admin' || actor.Status !== 'Active') {
        return res.status(403).json({ success: false, message: 'Active administrator privileges required.' });
    }
    try {
        const result = await r3RunRecovery({ manual: true });
        return res.status(result.status).json({
            success: result.complete === true,
            message: result.message,
            resetCount: result.resetCount,
            roiPaidCount: result.roiPaidCount,
            roiDeferred: result.roiDeferred === true
        });
    } catch (error) {
        console.error('[R3 MANUAL] Coordinator failure:', error.message);
        return res.status(503).json({ success: false,
            message: 'Recovery result is unavailable. Check server logs before retrying.' });
    }
});

// ============================================================================
// 💎 MODULE 8.1: STAKE / BUY CARD API (FIXES 404 ERROR & BALANCE SYNC)
// ============================================================================
app.post('/api/finance/stake', async (req, res) => {
    try {
        const { amount, durationDays, dailyRoi, cardNumber } = req.body;
        const uid = req.authenticatedUid;

        if (!uid) {
            return res.status(401).json({
                success: false,
                message: "Authenticated account is required."
            });
        }

        if (req.body.uid !== undefined && req.body.uid !== uid) {
            return res.status(403).json({
                success: false,
                message: "Account ownership mismatch."
            });
        }

        // MEMO TCM-STK-001 | 2026-10-09 22:31 IST | Asia/Kolkata
        // Validate inputs before selecting the wallet-owned staking plan.
        const isDecimalInput = value =>
            (typeof value === "string" || typeof value === "number") &&
            /^\d+(?:\.\d+)?$/.test(String(value).trim());

        if (
            !isDecimalInput(amount) ||
            !isDecimalInput(durationDays) ||
            !isDecimalInput(dailyRoi) ||
            typeof cardNumber !== "string" ||
            !cardNumber.trim()
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid staking parameters!"
            });
        }

        const stakeMicro = admS2Micro(amount, 'staking amount', false);
        const stakeAmt = admS2Money(stakeMicro);
        const requestedDays = Number(String(durationDays).trim());
        const requestedRoi = Number(String(dailyRoi).trim());
        const cleanCardNumber = cardNumber.trim();

        if (
            !Number.isFinite(stakeAmt) ||
            stakeAmt <= 0 ||
            !Number.isInteger(requestedDays) ||
            requestedDays <= 0 ||
            !Number.isFinite(requestedRoi) ||
            requestedRoi <= 0
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid staking parameters!"
            });
        }

        const stakingPlans = {
            silver: { days: 7, roi: 1.2, minimum: 10 },
            gold: { days: 15, roi: 1.5, minimum: 50 },
            platinum: { days: 30, roi: 2.0, minimum: 100 },
            diamond: { days: 60, roi: 2.5, minimum: 500 }
        };

        const customOrderId = generateOrderId('STK');
        const contractRef = db.collection("Staking_Contracts").doc(customOrderId);

        await db.runTransaction(async (t) => {
            const uRef = db.collection("Users").doc(uid);
            const wRef = db.collection("Wallets").doc(uid);

            const uSnap = await t.get(uRef);
            const wSnap = await t.get(wRef);

            if (!uSnap.exists || !wSnap.exists) throw new Error("User or wallet not found!");

            // MEMO TCM-STK-001 | 2026-10-09 22:31 IST | Asia/Kolkata
            // Ownership and plan checks must complete before financial writes.
            const wData = wSnap.data();
            const cards = wData.cards;

            if (!cards || typeof cards !== "object" || Array.isArray(cards)) {
                throw new Error("Staking cards are not available for this wallet.");
            }

            const matchedTiers = Object.keys(stakingPlans).filter(tier =>
                typeof cards[tier] === "string" &&
                cards[tier].trim() === cleanCardNumber
            );

            if (matchedTiers.length !== 1) {
                throw new Error("Invalid or ambiguous staking card ownership.");
            }

            const plan = stakingPlans[matchedTiers[0]];
            const days = plan.days;
            const roi = plan.roi;

            if (requestedDays !== days || requestedRoi !== roi) {
                throw new Error("Staking plan does not match the selected card.");
            }

            if (stakeAmt < plan.minimum) {
                throw new Error(`This staking card requires at least ${plan.minimum} USDT.`);
            }

            const mainMicro = admS2Balance(wData, 'Main_Balance');
            const lifetimeMicro = admS2Balance(wData, 'Lifetime_Stake');

            if (mainMicro < stakeMicro) {
                throw new Error(`Insufficient Main Balance! You need at least ${stakeAmt} ?.`);
            }

            const newMainBal = admS2Money(mainMicro - stakeMicro);
            const newLifetimeStake = admS2Money(lifetimeMicro + stakeMicro);

            // Update Wallet Balance & Lifetime Stake
            t.update(wRef, moneyV7Updates(wSnap.data(), {
                ...t8MainEntry(t, uid, wSnap.data(), newMainBal, 'Staking principal locked', customOrderId),
                Main_Balance: newMainBal,
                Lifetime_Stake: newLifetimeStake
            }, 'Wallet', 'update'));

            // Create Staking Contract Document
            let issueTime = Date.now();
            let expiryTime = issueTime + (days * 24 * 3600 * 1000);

            t.set(contractRef, {
                Order_ID: customOrderId,
                Card_Number: cleanCardNumber,
                UID: uid,
                amount: stakeAmt,
                amount_micro: stakeMicro.toString(),
                duration: days,
                dailyRoi: roi,
                Plan_Version: 'TCM-PLANS-1',
                Plan_Tier: matchedTiers[0],
                Plan_Rate_Bps: Math.round(roi * 100),
                Plan_Duration_Days: days,
                startTime: issueTime,
                unlockTime: expiryTime,
                status: 'Active'
            });

            t.update(uRef, {
                "counters.txCount": nextStakingTxCount(uSnap.data())
            });

            // Audit Transaction Record
            const txRef = db.collection("Transactions").doc(customOrderId);
            t.set(txRef, t9Record(t, {
                Amount_micro: stakeMicro.toString(),

                Date: new Date().toISOString(),
                UID: uid,
                Type: "Staking Lock",
                Amount: stakeAmt,
                Status: "Success",
                Order_ID: customOrderId,
                Details: `Staked ${stakeAmt} ₮ for ${days} Days (${roi}% Daily ROI)`,
                timestamp: FieldValue.serverTimestamp()
            }));
        });

        await clearUserCache(uid);

        res.status(200).json({
            success: true,
            stakeId: customOrderId,
            message: "Staking contract successfully created!"
        });
    } catch (error) {
        console.error("Staking API Error:", error);
        res.status(400).json({ success: false, message: error.message });
    }
});

// =================================================================================
// 🚀 MODULE: FETCH ACTIVE STAKES FOR CARD (SERVER-SIDE 24H FILTER)
// =================================================================================
app.get('/api/finance/get-active-stakes', async (req, res) => {
    try {
        const { cardNumber } = req.query;
        if (!cardNumber) return res.status(400).json({ success: false, message: "Card number is required" });

        const uid = req.authenticatedUid;

        if (!uid) {
            return res.status(401).json({
                success: false,
                message: "Authenticated account is required."
            });
        }

        if (typeof cardNumber !== "string") {
            return res.status(400).json({
                success: false,
                message: "Invalid card number."
            });
        }

        const cleanCard = cardNumber.trim();
        const walletSnap = await db.collection("Wallets").doc(uid).get();

        if (!walletSnap.exists) {
            return res.status(404).json({
                success: false,
                message: "Wallet not found."
            });
        }

        const cards = walletSnap.data().cards;
        const ownsCard = cards && typeof cards === "object" &&
            Object.values(cards).some(value =>
                typeof value === "string" && value.trim() === cleanCard
            );

        if (!ownsCard) {
            return res.status(403).json({
                success: false,
                message: "You do not own this staking card."
            });
        }

        const stakesSnap = await db.collection("Staking_Contracts")
            .where("UID", "==", uid)
            .where("Card_Number", "==", cleanCard)
            .where("status", "in", ["Active", "Matured"])
            .get();

        let activeContracts = [];
        const now = Date.now();

        stakesSnap.forEach(doc => {
            // 🛡️ Safe Immutable Fix: নতুন অবজেক্ট তৈরি করে আইডি যুক্ত করা হলো
            const data = { id: doc.id, ...doc.data() }; 
            const unlockTime = Number(data.unlockTime || 0);
            if ((unlockTime - now) <= 86400000) {
                activeContracts.push(data);
            }
        });

        res.status(200).json({ success: true, data: activeContracts });
    } catch (error) {
        console.error("Fetch Active Stakes Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// =================================================================================
// 🚀 MODULE: CLAIM MATURED STAKING PROFIT (UX ANIMATION & EXPLOIT FIX)
// =================================================================================
app.post('/api/finance/claim-stake', async (req, res) => {
    try {
        const uid = req.authenticatedUid;
        const { stakeId } = req.body;

        if (!uid) {
            return res.status(401).json({
                success: false,
                message: "Authenticated account is required."
            });
        }

        if (req.body.uid !== undefined && req.body.uid !== uid) {
            return res.status(403).json({
                success: false,
                message: "Account ownership mismatch."
            });
        }

        if (typeof stakeId !== "string" || !stakeId.trim() || stakeId.includes("/")) {
            return res.status(400).json({
                success: false,
                message: "Invalid stake ID."
            });
        }

        let updatedState = {};

        const claimResult = await db.runTransaction(async (t) => {
            const wRef = db.collection('Wallets').doc(uid);
            const stkRef = db.collection('Staking_Contracts').doc(stakeId);
            const uRef = db.collection("Users").doc(uid);

            const uSnap = await t.get(uRef);
            if (!uSnap.exists) throw new Error("User not found.");

            const txCount = nextStakingTxCount(uSnap.data());
            const wSnap = await t.get(wRef);
            const stkSnap = await t.get(stkRef);
            
            if (!wSnap.exists) throw new Error("Wallet not found");
            if (!stkSnap.exists) throw new Error("Stake contract not found");

            let wallet = wSnap.data();
            let stk = stkSnap.data();

            if (stk.UID !== uid) {
                throw new Error("You do not own this stake contract.");
            }

            if (stk.status === 'Completed') throw new Error("Stake already claimed!");
            if (!['Active', 'Matured'].includes(stk.status)) throw new Error("Invalid stake status for claim!");
            if (Date.now() < stk.unlockTime) throw new Error("Contract not matured yet! Please wait.");

            // 🔥 শুধুমাত্র আসল মূলধন (Principal) ফেরত যাবে
            const principalMicro = moneyV7Amount(stk, 'amount', 'amount_micro', 'staking principal');
            if (principalMicro <= 0n) throw admS2Error('Invalid staking principal.');
            const principal = admS2Money(principalMicro);

            // ১. স্ট্যাটাস পরিবর্তন
            t.update(stkRef, { status: 'Completed' });

            // ২. ফায়ারবেস ওয়ালেট ব্যালেন্স আপডেট (Principal -> Locked Vault for 30 Mins)
            const newLockedBal = admS2Money(admS2Balance(wallet, 'Locked_Balance') + principalMicro);
            const unlockTime = Date.now() + (30 * 60 * 1000); // 30 Mins from now
            
            const lockEntry = {
                amount: principal,
                amount_micro: principalMicro.toString(),
                unlockTime: unlockTime,
                txId: stakeId
            };

            t.update(wRef, moneyV7Updates(wallet, {
                Locked_Balance: newLockedBal,
                Locked_Withdrawals: FieldValue.arrayUnion(lockEntry)
            }, 'Wallet', 'update'));

            // ৩. ফ্রন্টএন্ডের জন্য আপডেট ডেটা সেভ (Main_Balance অপরিবর্তিত থাকবে)
            updatedState = {
                Locked_Balance: newLockedBal,
                Locked_Withdrawals: [...(wallet.Locked_Withdrawals || []), lockEntry]
            };

            // ৪. ট্রানজ্যাকশন হিস্ট্রি সেভ করা
            const txRef = db.collection('Transactions').doc();
            const recordedAt = Date.now();

            const historyTransaction = {
                ...t9UnchangedSnapshot(wallet),
                id: txRef.id,
                Date: new Date(recordedAt).toISOString(),
                UID: uid,
                Type: "Stake Unlocked",
                Amount: principal, Amount_micro: principalMicro.toString(),
                Status: "Success",
                Order_ID: stakeId,
                Details: "Principal Moved to TCM Locked Vault (30 Mins Cooling Period)",
                timestamp: recordedAt
            };

            const { id, ...ledgerData } = historyTransaction;

            t.set(txRef, {
                ...ledgerData,
                timestamp: FieldValue.serverTimestamp()
            });

            t.update(uRef, { "counters.txCount": txCount });

            return {
                updatedBalances: updatedState,
                injectionData: historyTransaction,
                txCount
            };
        });

        await clearUserCache(uid); 
        // 🔥 ফ্রন্টএন্ডে রিয়েল-টাইম আপডেটের জন্য updatedBalances পাঠানো হচ্ছে
        res.json({ 
            success: true, 
            message: "Principal successfully moved to TCM Locked Vault for 30 minutes.",
            updatedBalances: claimResult.updatedBalances,
            injectionData: claimResult.injectionData,
            txCount: claimResult.txCount
        });
    } catch(e) {
        console.error("Claim Error:", e);
        res.status(400).json({ success: false, message: e.message });
    }
});

// =========================================================
// 🚀 MODULE 6: PROFILE, DASHBOARD INIT (🔥 Lazy Reset & Health Engine)
// =========================================================
app.get('/api/user/init-data', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        // MEMO TCM-STK-005 | 2026-10-10 00:05 IST | Asia/Kolkata
        const uid = req.authenticatedUid;

        if (typeof uid !== "string" || !uid.trim() || uid.includes("/")) {
            return res.status(401).json({
                success: false,
                message: "Authenticated account is required."
            });
        }

        if (req.query.uid !== undefined && req.query.uid !== uid) {
            return res.status(403).json({
                success: false,
                message: "Account ownership mismatch."
            });
        }

        const clientTxCount = parseInt(req.query.clientTxCount) || 0;

        const cacheKey = `init_data_full_${uid}`;
        // An authenticated authoritative refresh must not reuse stale Redis state.
        const forceFresh = req.query.fresh === '1';
        let cachedData = forceFresh ? null : await getCache(cacheKey);
        if (cachedData?.historyReaderVersion !== 'MINT-HISTORY-1') cachedData = null;
        
        let tz = "Asia/Kolkata";
        if (cachedData && cachedData.user && cachedData.user.TimeZone) tz = cachedData.user.TimeZone;

        let userLocalTime = moment().tz(tz);
        
        // 🔥 ক্যাশ ব্লক উইন্ডো: ভোর ৫:২৮ থেকে ৫:৩২ (প্রফিট ডিস্ট্রিবিউশনের সময় কেউ পুরোনো ক্যাশ দেখবে না)
        const h = userLocalTime.hours();
        const m = userLocalTime.minutes();
        const isResetWindow = (h === 5 && m >= 28 && m <= 32);

        // 🛡️ FIX: Lazy Reset Boundary এখন ঠিক রাত ১২:০০ টা (00:00) করা হয়েছে
        let resetBoundary = userLocalTime.clone().hours(0).minutes(0).seconds(0).milliseconds(0);
        let activeResetDate = resetBoundary.format("YYYY-MM-DD");

        if (isResetWindow || (cachedData && cachedData.wallet.Last_Reset_Day !== activeResetDate)) {
            cachedData = null; 
        }

        // MEMO TCM-STK-007 | 2026-10-10 00:14 IST | Asia/Kolkata
        const cachedLocks = cachedData && cachedData.wallet
            ? cachedData.wallet.Locked_Withdrawals
            : null;
        const cacheCheckTime = Date.now();

        const hasExpiredCachedLock = Array.isArray(cachedLocks) &&
            cachedLocks.some((entry) => {
                const rawUnlockTime = entry && entry.unlockTime;

                if (
                    typeof rawUnlockTime !== "number" &&
                    typeof rawUnlockTime !== "string"
                ) return false;

                const unlockTime = Number(rawUnlockTime);

                return Number.isFinite(unlockTime) &&
                    unlockTime > 0 &&
                    cacheCheckTime >= unlockTime;
            });

        if (cachedData && !isResetWindow && !hasExpiredCachedLock) {
            return res.json({
                success: true,
                source: 'redis_cache',
                data: { ...cachedData, transactions: await teamBonusIdentity.enrich(db, cachedData.transactions, uid), wallet: moneyV7View(cachedData.wallet), user: tcmAuthPublicUser(cachedData.user) }
            });
        }

        const [userDoc, walletDoc, stakesSnap] = await Promise.all([
            Promise.resolve(req.authenticatedUserDoc), 
            db.collection("Wallets").doc(uid).get(),
            // MEMO TCM-STK-006 | 2026-10-10 00:07 IST | Asia/Kolkata
            db.collection("Staking_Contracts").where("UID", "==", uid).where("status", "in", ["Active", "Matured"]).get()
        ]);

        if (!userDoc || !userDoc.exists || userDoc.id !== uid || !walletDoc.exists) {
            throw new Error("Account data not found.");
        }

        let userData = userDoc.data();
        let walletData = moneyV7View(walletDoc.data());

        let activeStakesMicro = 0n;
        let activeStakesArr = [];
        if (stakesSnap && !stakesSnap.empty) {
            stakesSnap.forEach(d => {
                let sData = { id: d.id, ...d.data() };
                activeStakesMicro += moneyV7Amount(sData, 'amount', 'amount_micro', 'active staking principal');
                activeStakesArr.push(sData);
            });
        }
        walletData.Active_Stakes_Capital = admS2Money(activeStakesMicro);
        walletData.Active_Stakes = activeStakesArr;

        // MEMO TCM-STK-002-R1 | 2026-10-09 23:07 IST | Asia/Kolkata
        // Preserve lock objects and release valid expired entries atomically.
        const parseVaultNumber = (value) => {
            if (
                typeof value !== "number" &&
                typeof value !== "string"
            ) {
                return NaN;
            }

            if (typeof value === "string" && value.trim() === "") {
                return NaN;
            }

            return Number(value);
        };

        const releaseNow = Date.now();
        const existingLocks = Array.isArray(walletData.Locked_Withdrawals)
            ? walletData.Locked_Withdrawals
            : [];

        const hasExpiredLocks = existingLocks.some((entry) => {
            const unlockTime = parseVaultNumber(entry && entry.unlockTime);
            return Number.isFinite(unlockTime) &&
                unlockTime > 0 &&
                releaseNow >= unlockTime;
        });

        if (hasExpiredLocks) {
            const releaseWalletRef = db.collection("Wallets").doc(uid);

            const releasedWalletState = await db.runTransaction(async (t) => {
                const snapshot = await t.get(releaseWalletRef);
                if (!snapshot.exists) return null;

                const currentWallet = snapshot.data();
                const locks = currentWallet.Locked_Withdrawals;

                const unchangedState = {
                    Main_Balance: currentWallet.Main_Balance,
                    Locked_Balance: currentWallet.Locked_Balance,
                    Locked_Withdrawals: locks
                };

                if (!Array.isArray(locks)) return unchangedState;

                let releasedMicro = 0n;
                const remainingLocks = [];

                for (const entry of locks) {
                    const unlockTime = parseVaultNumber(entry && entry.unlockTime);
                    if (!Number.isFinite(unlockTime) || unlockTime <= 0 || releaseNow < unlockTime) {
                        remainingLocks.push(entry);
                        continue;
                    }
                    let amountMicro;
                    try {
                        amountMicro = moneyV7Amount(entry, 'amount', 'amount_micro', 'vault lock amount');
                    } catch (error) {
                        remainingLocks.push(entry);
                        continue;
                    }
                    if (amountMicro <= 0n) {
                        remainingLocks.push(entry);
                        continue;
                    }
                    releasedMicro += amountMicro;
                }

                if (releasedMicro === 0n) return unchangedState;

                let mainMicro, lockedMicro;
                try {
                    mainMicro = admS2Balance(currentWallet, 'Main_Balance');
                    lockedMicro = admS2Balance(currentWallet, 'Locked_Balance');
                } catch (error) {
                    return unchangedState;
                }
                // Never credit more than the existing locked balance can fund.
                if (releasedMicro > lockedMicro) return unchangedState;

                const nextMainBalance = admS2Money(mainMicro + releasedMicro);
                const nextLockedBalance = admS2Money(lockedMicro - releasedMicro);

                const updatedBalances = moneyV7Updates(currentWallet, {
                    ...t8MainEntry(t, uid, currentWallet, nextMainBalance, 'Cooling vault released to Main Balance'),
                    Main_Balance: nextMainBalance,
                    Locked_Balance: nextLockedBalance,
                    Locked_Withdrawals: remainingLocks
                }, 'Wallet', 'view');

                t.update(releaseWalletRef, updatedBalances);
                return updatedBalances;
            });

            if (releasedWalletState) {
                walletData = { ...walletData, ...releasedWalletState };
            }
        }

        // 🛡️ FIX: ডাবল রি-ক্যালকুলেশন বাউন্ডারি আপডেট (রাত ১২:০০ টা)
        tz = userData.TimeZone || "Asia/Kolkata";
        userLocalTime = moment().tz(tz);
        resetBoundary = userLocalTime.clone().hours(0).minutes(0).seconds(0).milliseconds(0);
        activeResetDate = resetBoundary.format("YYYY-MM-DD");

        // MEMO TCM-STK-006 | 2026-10-10 00:07 IST | Asia/Kolkata
        // Init-data must not reset or overwrite daily income counters.

        const tDep = admS2Balance(walletData, 'Total_Deposit');
        const tWd = admS2Balance(walletData, 'Total_Withdraw');
        const tTeamDep = admS2Balance(walletData, 'Total_Team_Deposit');
        let healthScore = 100;
        if (tWd > 0n) {
            const score = ((tDep * 10n + tTeamDep) * 10n) / tWd;
            healthScore = Number(score > 100n ? 100n : score);
        }
        if (tWd > tDep && tTeamDep < 100000000n) healthScore = Math.min(healthScore, 35);
        walletData.Health_Score = healthScore; 

        userData.counters = userData.counters || { txCount: 1, teamCount: 1, activeReservations: 1, unreadP2P: 0 };
        let dbTxCount = parseInt(userData.counters.txCount || 0);
        // A count alone cannot prove that Pending -> Success statuses are unchanged.
        // On an init-cache miss, load a bounded cached head instead of trusting that count.
        const head = await e4LoadDashboardHead(uid, dbTxCount);
        const historyStatus = head.status;
        const isUpToDate = historyStatus === 'unavailable';
        const txs = await teamBonusIdentity.enrich(db, head.records, uid);

        const safeUserData = tcmAuthPublicUser(userData);

        const responsePayload = {
            user: safeUserData, wallet: walletData, transactions: txs,
            isUpToDate, historyStatus, historyReaderVersion: head.readerVersion || '',
            historyCursor: head.nextCursor || '', historyHasMore: head.hasMore === true, serverTime: Date.now()
        };

        // 🛡️ Only cache to Redis when transactions are populated or on regular updates
        if (!isResetWindow && historyStatus === 'ready') {
            await setCache(cacheKey, responsePayload, 300);
        }
        res.json({ success: true, source: 'firestore_db', data: responsePayload });
    } catch(e) { res.status(400).json({ success: false, message: e.message }); }
});
// =========================================================
// 🌐 MODULE 6.5: GLOBAL LIVE FEED ENGINE (Zero-Billing & Avatar Sync)
// =========================================================
app.get('/api/feed/global', async (req, res) => {
    try {
        const cacheKey = 'global_live_feed';
        const cachedFeed = await getCache(cacheKey);
        if (cachedFeed) return res.json({ success: true, source: 'redis', data: cachedFeed });

        const snap = await db.collection("Transactions").orderBy("timestamp", "desc").limit(40).get();
        let tempFeed = [];
        const validTypes = ["Deposit", "Withdraw", "P2P Sent", "P2P Received"];
        let uidsToFetch = new Set();
        
        snap.forEach(doc => {
            const data = doc.data();
            if (validTypes.includes(data.Type)) {
                tempFeed.push(data);
                if (data.UID) uidsToFetch.add(data.UID);
            }
        });

        let userAvatars = {};
        for (let uid of uidsToFetch) {
            let avCacheKey = `avatar_${uid}`;
            let cachedAv = await getCache(avCacheKey);
            if (cachedAv) {
                userAvatars[uid] = cachedAv; 
            } else {
                let uDoc = await db.collection("Users").doc(uid).get();
                if (uDoc.exists) {
                    let avUrl = uDoc.data().Avatar || "";
                    userAvatars[uid] = avUrl;
                    await setCache(avCacheKey, avUrl, 86400); 
                }
            }
        }

        const feedWithAvatars = tempFeed.map(tx => ({ ...tx, Avatar: userAvatars[tx.UID] || "" }));
        const finalFeed = feedWithAvatars.slice(0, 20);
        await setCache(cacheKey, finalFeed, 120); 
        res.json({ success: true, source: 'db', data: finalFeed });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

// =========================================================
// 🚀 MODULE 7: TEAM & NETWORK ENGINE
// =========================================================
app.get('/api/team/network', async (req, res) => {
    // MEMO: TCM-TEAM-CORE-R1 | 2026-10-10 | Asia/Kolkata
    const uid = req.authenticatedUid;
    if (typeof uid !== "string" || !uid.trim() || uid.includes("/")) {
        return res.status(401).json({ success: false, message: "Authenticated account is required." });
    }
    if (req.query.uid !== undefined && req.query.uid !== uid) {
        return res.status(403).json({ success: false, message: "Account ownership mismatch." });
    }

    try {
        const accountSnapshot = req.authenticatedUserDoc;
        if (!accountSnapshot || !accountSnapshot.exists || accountSnapshot.id !== uid) {
            return res.status(401).json({ success: false, message: "Authenticated account no longer exists." });
        }
        if (accountSnapshot.data().Status === "Banned") {
            return res.status(403).json({ success: false, message: "Account access is blocked." });
        }
        const cacheKey = `team_network_full_${uid}`;
        const cachedData = await getCache(cacheKey);
        if (cachedData) return res.json({ success: true, source: 'redis', data: cachedData });

        const fetchHand = async (sponsorField) => {
            const userSnap = await db.collection("Users").where(sponsorField, "==", uid).get();
            let childUids = [];
            let userMap = {};

            userSnap.forEach(doc => {
                const uData = doc.data(); 
                const childUid = uData.UID || doc.id; 
                childUids.push(childUid);
                userMap[childUid] = { name: uData.Name || 'TCM User', uid: childUid, rank: uData.Rank || 0, balance: null, walletDataAvailable: false };
            });

            if (childUids.length === 0) return { count: 0, volume: 0, users: [] };

            const chunkSize = 30;
            const uidChunks = [];
            for (let i = 0; i < childUids.length; i += chunkSize) uidChunks.push(childUids.slice(i, i + chunkSize));

            const walletPromises = uidChunks.map(chunk => db.collection("Wallets").where("UID", "in", chunk).get());
            const walletSnaps = await Promise.all(walletPromises);
            
            let totalVolume = 0;
            walletSnaps.forEach(snap => {
                snap.forEach(doc => {
                    const wData = moneyV7View(doc.data());
                    const wUid = wData.UID || doc.id;
                    const balance = parseFloat(wData.Main_Balance || 0);
                    
                    if (userMap[wUid]) { 
                        const parseTeamTotal = (value) => {
                            if (value === null || value === undefined || value === "") return null;
                            if (typeof value !== "number" && typeof value !== "string") return null;
                            if (typeof value === "string" && !value.trim()) return null;
                            const parsed = Number(value);
                            return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
                        };
                        userMap[wUid].balance = parseTeamTotal(wData.Main_Balance);
                        userMap[wUid].totalDeposit = parseTeamTotal(wData.Total_Deposit);
                        userMap[wUid].totalEarn = parseTeamTotal(wData.Total_Comp ?? wData.Total_Earn);
                        userMap[wUid].totalWithdraw = parseTeamTotal(wData.Total_Withdraw);
                        userMap[wUid].walletDataAvailable = [
                            userMap[wUid].balance,
                            userMap[wUid].totalDeposit,
                            userMap[wUid].totalEarn,
                            userMap[wUid].totalWithdraw
                        ].every(value => value !== null);
                        
                        totalVolume += balance; 
                    }
                });
            });

            const users = Object.values(userMap);
            return { count: users.length, volume: totalVolume, users };
        };
        
        const [handA, handB, handC] = await Promise.all([ fetchHand("Sponsor_A"), fetchHand("Sponsor_B"), fetchHand("Sponsor_C") ]);
        const teamData = { handA, handB, handC };
        
        await setCache(cacheKey, teamData, 300);
        res.json({ success: true, source: 'db', data: teamData });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

app.get('/api/team/bonuses', async (req, res) => {
    // MEMO: TCM-TEAM-CORE-R1 | 2026-10-10 | Asia/Kolkata
    const uid = req.authenticatedUid;
    if (typeof uid !== "string" || !uid.trim() || uid.includes("/")) {
        return res.status(401).json({ success: false, message: "Authenticated account is required." });
    }
    if (req.query.uid !== undefined && req.query.uid !== uid) {
        return res.status(403).json({ success: false, message: "Account ownership mismatch." });
    }

    try {
        const accountSnapshot = req.authenticatedUserDoc;
        if (!accountSnapshot || !accountSnapshot.exists || accountSnapshot.id !== uid) {
            return res.status(401).json({ success: false, message: "Authenticated account no longer exists." });
        }
        if (accountSnapshot.data().Status === "Banned") {
            return res.status(403).json({ success: false, message: "Account access is blocked." });
        }
        const cacheKey = `team_bonuses_${uid}`;
        const cachedData = await getCache(cacheKey);
        if (cachedData) return res.json({ success: true, source: 'redis', data: await teamBonusIdentity.enrich(db, cachedData, uid) });

        const bonusTypes = ["Team Bonus (A-Hand)", "Team Bonus (B-Hand)", "Team Bonus (C-Hand)"];
        const snap = await db.collection("Transactions").where("UID", "==", uid).where("Type", "in", bonusTypes).get();

        let bonuses = [];
        snap.forEach(d => bonuses.push(d.data()));
        bonuses.sort((a, b) => parseSafeTimestamp(b.timestamp || b.Date) - parseSafeTimestamp(a.timestamp || a.Date));

        await setCache(cacheKey, bonuses, 300);
        res.json({ success: true, data: await teamBonusIdentity.enrich(db, bonuses, uid) });
    } catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

// ============================================================================
// 💬 MODULE 8: CHAT ENGINE & FRIENDS
// ============================================================================
// MODULE15: authenticated chat adaptation; no wallet or NFT handler changes.
let profileDirectoryEpoch = 0;
const chatProfiles = require('./lib/chat-profile.cjs')({app,db,io,invalidate:async uid=>{
    profileDirectoryEpoch++;f1DirectoryRAM.clear();
    await Promise.allSettled([clearUserCache(uid),m2RedisCommand(()=>redisClient.incr('friend_profiles_epoch'))]);
}});
const chatModule15 = require('./lib/chat-module15.cjs')({app, db, io, FieldValue,
    invalidate: async (...uids) => {
        await f1Invalidate(...uids);
        const keys=['chat_msgs_global'];
        if(uids.length>1)keys.push('chat_msgs_private_'+[...uids].sort().join('_'));
        await m2RedisCommand(()=>redisClient.del(keys));
    }, verifySocket: verifyDashboardSocketSession});

app.post('/api/chat/send-global', async (req, res) => {
    try {
        const { senderUid, senderName, avatar, message, clientMessageId } = req.body;
        if (clientMessageId !== undefined &&
            !/^temp-[a-f0-9-]{36}$/i.test(clientMessageId)) {
            throw new Error('Invalid client message ID.');
        }
        const ref = await db.collection('Global_Chat').add({
            senderUid, senderName, avatar, message,
            timestamp: FieldValue.serverTimestamp(), deletedFor: [], status: 'sent'
        });
        const committed = {
            id: ref.id, senderUid, senderName, avatar, message,
            clientMessageId: clientMessageId || null,
            timestamp: new Date().toISOString(), deletedFor: [], status: 'sent'
        };
        await m2RedisCommand(() => redisClient.del('chat_msgs_global'));
        io.emit('receive_global_message', committed);
        res.json({ success: true, data: committed });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

app.post('/api/chat/send-private', async (req, res) => {
    try {
        const { senderUid, receiverUid, senderName, avatar, message } = req.body;
        const chatId = senderUid < receiverUid ? `${senderUid}_${receiverUid}` : `${receiverUid}_${senderUid}`;
        const batch = db.batch();
        const msgRef = db.collection("Private_Chats").doc(chatId).collection("Messages").doc();
        batch.set(msgRef, { senderUid, senderName, avatar, message, timestamp: FieldValue.serverTimestamp(), deletedFor: [], status: 'sent' });
        batch.set(db.collection("Users").doc(senderUid).collection("Friends").doc(receiverUid), { lastMsg: "You: " + message, lastMsgTime: FieldValue.serverTimestamp() }, { merge: true });
        batch.set(db.collection("Users").doc(receiverUid).collection("Friends").doc(senderUid), { unreadCount: FieldValue.increment(1), lastMsg: message, lastMsgTime: FieldValue.serverTimestamp() }, { merge: true });
        await batch.commit(); res.json({ success: true });
    } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});

app.post('/api/chat/delete-message', async (req, res) => {
    try {
        const { uid, receiverUid, msgIds, mode, deleteType } = req.body;
        let colRef = mode === 'global' ? db.collection("Global_Chat") : db.collection("Private_Chats").doc(uid < receiverUid ? `${uid}_${receiverUid}` : `${receiverUid}_${uid}`).collection("Messages");
        const batch = db.batch();
        msgIds.forEach(msgId => { const docRef = colRef.doc(msgId); if (deleteType === 'me') batch.update(docRef, { deletedFor: FieldValue.arrayUnion(uid) }); else if (deleteType === 'everyone') batch.delete(docRef); });
        await batch.commit(); res.json({ success: true });
    } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});

app.get('/api/chat/friends', async (req, res) => {
    try { 
        const uid = req.query.uid; 
        const cacheKey = `chat_friends_${uid}_${f1ListEpochs.get(uid) || 0}`;
        const cachedData = await getCache(cacheKey);
        if (cachedData) return res.json({ success: true, source: 'redis', data: cachedData });

        const snap = await db.collection("Users").doc(uid).collection("Friends").get(); 
        let friends = []; 
        snap.forEach(d => friends.push(d.data())); 
        
        await setCache(cacheKey, friends, 3); 
        res.json({ success: true, source: 'db', data: friends }); 
    } catch(e) { res.status(400).json({ success: false, message: e.message }); }
});

app.get('/api/chat/requests', async (req, res) => {
    try { 
        const uid = req.query.uid; 
       const cacheKey = `chat_req_${uid}_${f1ListEpochs.get(uid) || 0}`;
        const cachedData = await getCache(cacheKey);
        if (cachedData) return res.json({ success: true, source: 'redis', count: cachedData.length, data: cachedData });

        const snap = await db.collection("Friend_Requests").where("receiverUid", "==", uid).get(); 
        let requests = []; 
        snap.forEach(d => requests.push({ id: d.id, ...d.data() })); 
        
        await setCache(cacheKey, requests, 3); 
        res.json({ success: true, source: 'db', count: requests.length, data: requests }); 
    } catch(e) { res.status(400).json({ success: false, message: e.message }); }
});

async function chatResetPrivateUnread(uid, target) {
    a0Uid(target);
    const ref = db.collection('Users').doc(uid).collection('Friends').doc(target);
    await db.runTransaction(async transaction => {
        const friend = await transaction.get(ref);
        if (friend.exists && Number(friend.data().unreadCount || 0) !== 0) {
            transaction.update(ref, { unreadCount: 0 });
        }
    });
    await f1Invalidate(uid);
}

app.post('/api/chat/read-private', async (req, res) => {
    try {
        const uid = req.authenticatedUid;
        if (!uid || (req.body.uid !== undefined && req.body.uid !== uid)) {
            return res.status(403).json({ success: false, message: 'Account ownership mismatch.' });
        }
        await chatResetPrivateUnread(uid, req.body.target);
        res.json({ success: true });
    } catch (error) { return a0Failure(res, error); }
});

app.get('/api/chat/messages', async (req, res) => {
    try {
        const { mode, target } = req.query;
        const uid = req.authenticatedUid;
        const cacheKey = mode === 'global' ? `chat_msgs_global` : `chat_msgs_private_${uid < target ? `${uid}_${target}` : `${target}_${uid}`}`;
        
        const cachedData = await getCache(cacheKey);
        if (cachedData) return res.json({ success: true, source: 'redis', data: cachedData });

        let msgs = [];
        if(mode === 'global') { 
            const snap = await db.collection("Global_Chat").orderBy("timestamp", "asc").limitToLast(50).get(); 
            snap.forEach(d => msgs.push({ id: d.id, ...d.data() })); 
        } else if (mode === 'private' && target && uid) { 
            const chatId = uid < target ? `${uid}_${target}` : `${target}_${uid}`; 
            const snap = await db.collection("Private_Chats").doc(chatId).collection("Messages").orderBy("timestamp", "asc").limitToLast(50).get(); 
            snap.forEach(d => msgs.push({ id: d.id, ...d.data() })); 
        }
        
        await setCache(cacheKey, msgs, 2); 
        res.json({ success: true, source: 'db', data: msgs });
    } catch(e) { res.status(400).json({ success: false, message: e.message }); }
});


// FRIENDS-R1: Public directory uses bounded cursor reads; mutations use verified identities.
const f1DirectoryRAM = new Map();
const f1DirectoryFlights = new Map();
const f1RateWindows = new Map();
const f1ListEpochs = new Map();
function f1RequestId(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,257}$/.test(value)) {
        throw Object.assign(new Error('Invalid friend request ID.'), { status: 400 });
    }
    return value;
}
function f1Rate(uid, kind, maximum) {
    const key = kind + ':' + uid;
    const now = Date.now();
    let state = f1RateWindows.get(key);
    if (!state || state.until <= now) state = { until: now + 60000, count: 0 };
    f1RateWindows.delete(key);
    f1RateWindows.set(key, state);
    while (f1RateWindows.size > 5000) f1RateWindows.delete(f1RateWindows.keys().next().value);
    if (++state.count > maximum) throw Object.assign(new Error('Please wait before trying again.'), { status: 429 });
}
function f1Public(doc) {
    const data = doc.data();
    return { uid: doc.id, name: String(data.Name || 'TCM member').slice(0, 120),
        avatar: typeof data.Avatar === 'string' ? data.Avatar : '', abdar: typeof data.abdar === 'string' ? data.abdar : '', profileVersion: data.Profile_Version || 0, profileUpdatedAt: data.Profile_Updated_At || 0 };
}
function f1Actor(doc, req) {
    const user = doc.exists ? doc.data() : null;
    if (!user || user.Token !== r3Bearer(req)) {
        throw Object.assign(new Error('Your session changed. Sign in again.'), { status: 401 });
    }
    if (user.Status !== 'Active' || user.Account_Deleted === true) {
        throw Object.assign(new Error('This account cannot perform friend actions.'), { status: 403 });
    }
    return user;
}
function f1Notify(uid, name, data) {
    try { io.to(uid).emit(name, data); }
    catch (error) { console.warn('[FRIENDS] Live notification could not be delivered.'); }
}
async function f1Invalidate(...uids) {
    for (const uid of uids) {
        f1ListEpochs.set(uid, (f1ListEpochs.get(uid) || 0) + 1);
    }
    while (f1ListEpochs.size > 5000) f1ListEpochs.delete(f1ListEpochs.keys().next().value);
    await m2RedisCommand(() => redisClient.del(uids.flatMap(uid => [`chat_friends_${uid}`, `chat_req_${uid}`])));
}
async function f1DirectoryRead(after, limit) {
    const epoch = await m2RedisCommand(()=>redisClient.get('friend_profiles_epoch'));
    const key = `friend_directory_v2_${epoch || 0}_${profileDirectoryEpoch}_${limit}_${after || 'head'}`;
    const memory = f1DirectoryRAM.get(key);
    if (memory && memory.until > Date.now()) return memory.data;
    if (f1DirectoryFlights.has(key)) return f1DirectoryFlights.get(key);
    if (f1DirectoryFlights.size >= 100) throw Object.assign(new Error('Directory is busy. Try again shortly.'), { status: 503 });
    const pending = (async () => {
        const cached = await m2RedisCommand(() => redisClient.get(key));
        if (cached) {
            try {
                const value = JSON.parse(cached);
                if (Array.isArray(value.data)) return value;
            } catch (error) {}
        }
        let query = db.collection('Users').where('Status', '==', 'Active')
            .orderBy(m1FieldPath.documentId()).select('Name', 'Avatar', 'abdar', 'Profile_Version', 'Profile_Updated_At').limit(limit);
        if (after) query = query.startAfter(after);
        const snap = await query.get();
        const result = { data: snap.docs.map(f1Public),
            nextCursor: snap.empty ? after : snap.docs[snap.docs.length - 1].id,
            hasMore: snap.size === limit };
        await m2RedisCommand(() => redisClient.setEx(key, 120, JSON.stringify(result)));
        return result;
    })().then(result => {
        f1DirectoryRAM.delete(key);
        f1DirectoryRAM.set(key, { until: Date.now() + 30000, data: result });
        while (f1DirectoryRAM.size > 256) f1DirectoryRAM.delete(f1DirectoryRAM.keys().next().value);
        return result;
    }).finally(() => f1DirectoryFlights.delete(key));
    f1DirectoryFlights.set(key, pending);
    return pending;
}
app.get('/api/chat/directory', async (req, res) => {
    try {
        const uid = req.authenticatedUid;
        if (!uid) return res.status(401).json({ success: false, message: 'Sign in required.' });
        f1Rate(uid, 'directory', 180);
        const after = req.query.after ? a0Uid(req.query.after) : '';
        const query = typeof req.query.q === 'string' ? req.query.q.trim().toUpperCase() : '';
        if (query) {
            a0Uid(query);
            const direct = await db.collection('Users').doc(query).get();
            let user = direct.exists ? direct : null;
            if (!user) {
                const fallback = await db.collection('Users').where('UID', '==', query).limit(2).get();
                if (fallback.size > 1) throw Object.assign(new Error('UID is ambiguous. Contact support.'), { status: 409 });
                user = fallback.docs[0] || null;
            }
            const active = user && user.data().Status === 'Active' && user.data().Account_Deleted !== true;
            return res.json({ success: true, data: active ? [f1Public(user)] : [], hasMore: false, nextCursor: '' });
        }
        const limit = after ? 1 : 20;
        const result = await f1DirectoryRead(after, limit);
        return res.json({ success: true, ...result });
    } catch (error) {
        if (typeof e4MissingIndex === 'function' && e4MissingIndex(error)) {
            return res.status(503).json({ success: false, message: 'Member directory index is building. Please try again shortly.' });
        }
        return a0Failure(res, error);
    }
});
app.post('/api/friends/send-request', async (req, res) => {
    try {
        const uid = req.authenticatedUid;
        const receiverUid = a0Uid(req.body.receiverUid);
        if (receiverUid === uid) throw Object.assign(new Error('You cannot add yourself.'), { status: 400 });
        f1Rate(uid, 'send', 10);
        const ref = db.collection('Friend_Requests').doc(`${uid}_${receiverUid}`);
        const reverse = db.collection('Friend_Requests').doc(`${receiverUid}_${uid}`);
        const result = await db.runTransaction(async t => {
            const [actor, target, friend, pending, incoming] = await t.getAll(
                db.collection('Users').doc(uid), db.collection('Users').doc(receiverUid),
                db.collection('Users').doc(uid).collection('Friends').doc(receiverUid), ref, reverse);
            const sender = f1Actor(actor, req);
            if (!target.exists || target.data().Status !== 'Active' || target.data().Account_Deleted === true) {
                throw Object.assign(new Error('This member is unavailable.'), { status: 409 });
            }
            if (friend.exists) return { state: 'friends', changed: false };
            if (incoming.exists) return { state: 'incoming', changed: false, reqId: incoming.id, requestVersion: incoming.data().requestVersion || null };
            if (pending.exists) return { state: 'pending', changed: false, reqId: ref.id, requestVersion: pending.data().requestVersion || null };
            const data = { senderUid: uid, senderName: String(sender.Name || 'TCM member').slice(0, 120),
                senderAvatar: typeof sender.Avatar === 'string' ? sender.Avatar : '', receiverUid, requestVersion: r3Crypto.randomUUID() };
            t.create(ref, { ...data, timestamp: FieldValue.serverTimestamp() });
            return { state: 'pending', changed: true, reqId: ref.id, requestVersion: data.requestVersion, request: data };
        });
        if (result.changed) {
            await f1Invalidate(receiverUid);
            f1Notify(receiverUid, 'new_friend_request', { id: result.reqId, ...result.request, timestamp: new Date().toISOString() });
        }
        return res.json({ success: true, message: result.state === 'friends' ? 'You are already friends.' :
            result.state === 'incoming' ? 'This member has already requested you. Review your bell.' : 'Friend request is pending.', data: result });
    } catch (error) { return a0Failure(res, error); }
});
app.post('/api/friends/accept-request', async (req, res) => {
    try {
        const uid = req.authenticatedUid;
        f1Rate(uid, 'decision', 60);
        const reqId = f1RequestId(req.body.reqId);
        const ref = db.collection('Friend_Requests').doc(reqId);
        const result = await db.runTransaction(async t => {
            const request = await t.get(ref);
            if (!reqId.endsWith('_' + uid) || (request.exists && request.data().receiverUid !== uid)) {
                throw Object.assign(new Error('You cannot accept this request.'), { status: 403 });
            }
            const senderUid = a0Uid(request.exists ? request.data().senderUid : reqId.slice(0, -(uid.length + 1)));
            if (senderUid === uid || reqId !== `${senderUid}_${uid}`) {
                throw Object.assign(new Error('Invalid friend request identity.'), { status: 400 });
            }
            const mine = db.collection('Users').doc(uid).collection('Friends').doc(senderUid);
            const theirs = db.collection('Users').doc(senderUid).collection('Friends').doc(uid);
            const reverse = db.collection('Friend_Requests').doc(`${uid}_${senderUid}`);
            const [actor, sender, oldMine, oldTheirs, otherRequest] = await t.getAll(
                db.collection('Users').doc(uid), db.collection('Users').doc(senderUid), mine, theirs, reverse);
            const receiverData = f1Actor(actor, req);
            if (!request.exists) {
                if (oldMine.exists && oldTheirs.exists) return { changed: false, senderUid };
                throw Object.assign(new Error('Request no longer exists.'), { status: 404 });
            }
            if (!sender.exists || sender.data().Status !== 'Active' || sender.data().Account_Deleted === true) {
                throw Object.assign(new Error('The sender is unavailable. Reject this request.'), { status: 409 });
            }
            const makeFriend = (memberUid, member, previous) => ({ uid: memberUid,
                name: String(member.Name || 'TCM member').slice(0, 120),
                avatar: typeof member.Avatar === 'string' ? member.Avatar : '',
                addedAt: previous.addedAt || FieldValue.serverTimestamp(),
                unreadCount: previous.unreadCount || 0, lastMsg: previous.lastMsg || 'Say Hello! 👋',
                lastMsgTime: previous.lastMsgTime || FieldValue.serverTimestamp() });
            t.set(mine, makeFriend(senderUid, sender.data(), oldMine.exists ? oldMine.data() : {}), { merge: true });
            t.set(theirs, makeFriend(uid, receiverData, oldTheirs.exists ? oldTheirs.data() : {}), { merge: true });
            t.delete(ref);
            if (otherRequest.exists) t.delete(reverse);
            return { changed: true, senderUid, requestVersion: request.data().requestVersion || null, reverseId: otherRequest.exists ? reverse.id : null, reverseVersion: otherRequest.exists ? otherRequest.data().requestVersion || null : null };
        });
        await f1Invalidate(uid, result.senderUid);
        const notice = { reqId, receiverUid: uid, senderUid: result.senderUid, requestVersion: result.requestVersion, action: 'accepted' };
        if (result.changed) {
            f1Notify(uid, 'friend_request_resolved', notice);
            f1Notify(result.senderUid, 'friend_request_resolved', notice);
            if (result.reverseId) {
                const reverseNotice = { reqId: result.reverseId, receiverUid: result.senderUid, senderUid: uid, requestVersion: result.reverseVersion, action: 'accepted' };
                f1Notify(uid, 'friend_request_resolved', reverseNotice);
                f1Notify(result.senderUid, 'friend_request_resolved', reverseNotice);
            }
        }
        return res.json({ success: true, message: 'Friend request accepted.', data: result });
    } catch (error) { return a0Failure(res, error); }
});
app.post('/api/friends/reject-request', async (req, res) => {
    try {
        const uid = req.authenticatedUid;
        f1Rate(uid, 'decision', 60);
        const reqId = f1RequestId(req.body.reqId);
        const result = await db.runTransaction(async t => {
            const ref = db.collection('Friend_Requests').doc(reqId);
            const [actor, request] = await t.getAll(db.collection('Users').doc(uid), ref);
            f1Actor(actor, req);
            if (!reqId.endsWith('_' + uid) || (request.exists && request.data().receiverUid !== uid)) {
                throw Object.assign(new Error('You cannot reject this request.'), { status: 403 });
            }
            const senderUid = a0Uid(request.exists ? request.data().senderUid : reqId.slice(0, -(uid.length + 1)));
            if (request.exists) t.delete(ref);
            return { changed: request.exists, senderUid, requestVersion: request.exists ? request.data().requestVersion || null : null };
        });
        await f1Invalidate(uid);
        if (result.changed) {
            const notice = { reqId, receiverUid: uid, senderUid: result.senderUid, requestVersion: result.requestVersion, action: 'rejected' };
            f1Notify(uid, 'friend_request_resolved', notice);
            f1Notify(result.senderUid, 'friend_request_resolved', notice);
        }
        return res.json({ success: true, message: 'Friend request rejected.', data: result });
    } catch (error) { return a0Failure(res, error); }
});
app.post('/api/friends/unfriend', async (req, res) => {
    try {
        const uid = req.authenticatedUid;
        const targetUid = a0Uid(req.body.targetUid);
        if (uid === targetUid) throw Object.assign(new Error('Invalid member.'), { status: 400 });
        f1Rate(uid, 'decision', 60);
        const refs = [db.collection('Users').doc(uid).collection('Friends').doc(targetUid),
            db.collection('Users').doc(targetUid).collection('Friends').doc(uid),
            db.collection('Friend_Requests').doc(`${uid}_${targetUid}`),
            db.collection('Friend_Requests').doc(`${targetUid}_${uid}`)];
        const changed = await db.runTransaction(async t => {
            const [actor, ...records] = await t.getAll(db.collection('Users').doc(uid), ...refs);
            f1Actor(actor, req);
            records.forEach((record, index) => { if (record.exists) t.delete(refs[index]); });
            return records.some(record => record.exists);
        });
        const notice = { actorUid: uid, targetUid, operationId: r3Crypto.randomUUID() };
        if (changed) {
            await f1Invalidate(uid, targetUid);
            f1Notify(uid, 'friendship_removed', notice);
            f1Notify(targetUid, 'friendship_removed', notice);
        }
        return res.json({ success: true, message: 'Friend removed.', data: notice });
    } catch (error) { return a0Failure(res, error); }
});

// =========================================================
// 💬 SUPPORT DESK API: Fetch User Support Conversation
// =========================================================
app.get('/api/support/messages', (req, res) => supportConsole.userMessages(req, res));
// ============================================================================
// 📸 MODULE 8.5: USER AVATAR ENGINE
// ============================================================================
app.post('/api/user/upload-avatar', async (req, res) => {
    try {
        const { uid, avatar } = req.body;
        if (!uid || !avatar) throw new Error("Missing data");
        await chatProfiles.update(req, { Avatar: avatar });
        await setCache(`avatar_${uid}`, avatar, 86400); 
        await clearUserCache(uid); // 🔥 FIX: মেইন ক্যাশ ক্লিয়ার করা হলো
        res.json({ success: true });
    } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});

app.post('/api/user/remove-avatar', async (req, res) => {
    try {
        const { uid } = req.body;
        await chatProfiles.update(req, { Avatar: "" });
        await setCache(`avatar_${uid}`, "", 86400); 
        await clearUserCache(uid); // 🔥 FIX: মেইন ক্যাশ ক্লিয়ার করা হলো
        res.json({ success: true });
    } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});

// ============================================================================
// 👁️ MODULE 9: USER PRESENCE & RANK AUTOMATION
// ============================================================================
app.post('/api/user/presence', async (req, res) => {
    try { await db.collection("Users").doc(req.body.uid).update({ lastActive: FieldValue.serverTimestamp() }); res.json({ success: true }); } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});

app.post('/api/user/typing', async (req, res) => {
    try { await db.collection("Users").doc(req.body.uid).update({ typingTo: req.body.targetUid }); res.json({ success: true }); } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});

app.post('/api/notifications/clear-all', async (req, res) => {
    try { const snap = await db.collection("Users").doc(req.body.uid).collection("Notifications").get(); const batch = db.batch(); snap.forEach(doc => batch.delete(doc.ref)); await batch.commit(); res.json({ success: true }); } catch (error) { res.status(400).json({ success: false, message: error.message }); }
});

app.post('/api/automation/verify-rank', async (req, res) => {
    try {
        // MEMO: TCM-DASH-RANK-R1 | 2026-10-10 | Asia/Kolkata
        const uid = req.authenticatedUid;
        if (typeof uid !== "string" || !uid.trim() || uid.includes("/")) {
            return res.status(401).json({ success: false, message: "Authenticated account is required." });
        }
        if (req.body && req.body.uid !== undefined && req.body.uid !== uid) {
            return res.status(403).json({ success: false, message: "Account ownership mismatch." });
        }

        const verification = await db.runTransaction(async (t) => {
            const uRef = db.collection("Users").doc(uid);
            const wRef = db.collection("Wallets").doc(uid);
            const uSnap = await t.get(uRef);
            if (!uSnap.exists) throw new Error("Account data not found.");
            const uData = uSnap.data();
            if (uData.Account_Deleted === true) {
                return { rank: 0, updated: false };
            }
            const wSnap = await t.get(wRef);
            if (!wSnap.exists) throw Object.assign(new Error('Wallet record is missing. Rank was not recalculated. Contact support with your UID.'), { statusCode: 409, code: 'WALLET_RECORD_MISSING' });
            const wData = wSnap.data();
            let rank = parseInt(uData.Rank || 0);
            let updated = false;

            // Preserve the existing active-stake eligibility and rank thresholds.
            const stakesSnap = await t.get(
                db.collection("Staking_Contracts")
                    .where("UID", "==", uid)
                    .where("status", "==", "Active")
            );
            const activeStakes = [];
            stakesSnap.forEach(doc => activeStakes.push(doc.data()));
            wData.Active_Stakes = activeStakes;

            const rankCalc = calculateRankUpdates(uData, wData);
            if (rankCalc.Rank !== undefined) {
                t.update(uRef, { Rank: rankCalc.Rank });
                rank = rankCalc.Rank;
                updated = true;
            }
            if (rankCalc.Points !== undefined) {
                t.update(wRef, { Points: rankCalc.Points });
                updated = true;
            }
            // Return only the final committed attempt's outcome.
            return { rank, updated };
        });

        if (verification.updated) {
            try {
                await clearUserCache(uid);
            } catch (error) {
                console.warn("Rank committed; cache invalidation is pending.");
            }
        }
        return res.json({ success: true, rank: verification.rank });
    } catch (error) {
        if (error.code !== 'WALLET_RECORD_MISSING') console.error("Rank Verify Error:", error);
        return res.status(error.statusCode || 400).json({ success: false, code: error.code || 'RANK_VERIFICATION_FAILED',
            message: error.message, ...(error.code === 'WALLET_RECORD_MISSING' ? { uid: req.authenticatedUid } : {}) });
    }
});
// A0: Browser Firestore access is replaced by authenticated server actions.
function a0Uid(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
        throw Object.assign(new Error('A valid account UID is required.'), { status: 400 });
    }
    return value;
}
function a0Text(value, label, maximum) {
    if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
        throw Object.assign(new Error('Invalid ' + label + '.'), { status: 400 });
    }
    return value.trim();
}
function a0Failure(res, error) {
    return res.status(error.status || 503).json({ success: false,
        message: error.status ? error.message : 'Action could not complete. Check the current state before retrying.' });
}
async function a0AdminActor(t, req) {
    const snapshot = await t.get(db.collection('Users').doc(req.authenticatedUid));
    const actor = snapshot.exists ? snapshot.data() : null;
    if (!actor || actor.Token !== r3Bearer(req) || actor.Role !== 'Admin' || actor.Status !== 'Active') {
        throw Object.assign(new Error('An active administrator session is required.'), { status: 403 });
    }
    return actor;
}
function a0RequireAdmin(req, res) {
    if (!m1RequireAdmin(req, res)) return false;
    if (req.authenticatedUserDoc.data().Status !== 'Active') {
        res.status(403).json({ success: false, message: 'An active administrator session is required.' });
        return false;
    }
    return true;
}
function a0PublishSupport(uid, detail = {}) {
    for (const stream of m1Streams) {
        if (typeof stream.sendSupport === 'function') void stream.sendSupport(uid, detail);
    }
}
const supportConsole = require('./lib/support-console.cjs')({ app, db, FieldValue, FieldPath: m2FieldPath, Timestamp: m2Timestamp,
    requireAdmin: a0RequireAdmin, readActor: a0AdminActor, publish: a0PublishSupport });
// R3: bounded admin history and order lookup. Existing financial handlers are unchanged.
require('./lib/admin-records.cjs')({ app, db, Filter: m1Filter, FieldPath: m1FieldPath,
    FieldValue, requireAdmin: a0RequireAdmin, readActor: a0AdminActor });

// R4: durable announcements. Existing support and financial handlers stay unchanged.
require('./lib/announcements.cjs')({ app, db, io, FieldValue,
    requireAdmin: a0RequireAdmin, readAdmin: a0AdminActor });
async function a0ArchiveRows(req, docs) {
    return db.runTransaction(async t => {
        const actor = await a0AdminActor(t, req);
        const snapshots = [];
        for (const doc of docs) snapshots.push(await t.get(doc.ref));
        const selected = snapshots.filter(doc => doc.exists && doc.data().Admin_Archived !== true);
        for (const doc of selected) {
            const status = String(doc.data().Status || doc.data().status || '').toLowerCase();
            if (!['rejected', 'cancelled', 'locked'].includes(status)) {
                throw Object.assign(new Error('Only archive-list entries can be hidden.'), { status: 409 });
            }
        }
        for (const doc of selected) t.update(doc.ref, {
            Admin_Archived: true, Admin_Archived_By: req.authenticatedUid,
            Admin_Archived_At: FieldValue.serverTimestamp()
        });
        if (selected.length) t.create(db.collection('AdminLogs').doc(), {
            Admin_Name: actor.Name || req.authenticatedUid, Actor_UID: req.authenticatedUid,
            Action_Type: 'Ledger Display Archived', Transaction_IDs: selected.map(doc => doc.id),
            timestamp: FieldValue.serverTimestamp()
        });
        return selected.length;
    });
}
app.post('/api/admin/archive-action', async (req, res) => {
    if (!a0RequireAdmin(req, res)) return;
    try {
        const docId = a0Uid(req.body.docId);
        const count = await a0ArchiveRows(req, [{ ref: db.collection('Transactions').doc(docId) }]);
        return res.json({ success: true, count, message: 'Hidden from the archive list; financial record retained.' });
    } catch (error) { return a0Failure(res, error); }
});
app.post('/api/admin/archive-page', async (req, res) => {
    if (!a0RequireAdmin(req, res)) return;
    try {
        const cursor = req.body.cursor ? a0Uid(req.body.cursor) : null;
        let query = m1StatusQuery(['Rejected', 'Cancelled', 'Locked', 'rejected', 'cancelled', 'locked'])
            .orderBy(m1FieldPath.documentId()).limit(100);
        if (cursor) query = query.startAfter(cursor);
        const page = await query.get();
        const count = await a0ArchiveRows(req, page.docs);
        return res.json({ success: true, count,
            nextCursor: page.size === 100 ? page.docs[99].id : null });
    } catch (error) { return a0Failure(res, error); }
});

// ============================================================================
// ⚡ MODULE 9.5: WEBSOCKET CHAT ENGINE (Private & Support Gateway)
// ============================================================================
// MEMO: TCM-DASH-PHASE-A | 2026-10-10 | Asia/Kolkata
function dashboardSocketError(status, message) {
    const error = new Error(message);
    error.data = { status, message };
    return error;
}

async function invalidateDashboardSockets(uid, options = {}) {
    try {
        const sockets = await io.in(uid).fetchSockets();
        if (options.keepToken) {
            const current = await db.collection('Users').doc(uid).get();
            if (!current.exists || current.data().Token !== options.keepToken) return;
        }
        for (const socket of sockets) {
            const token = socket.data.sessionToken;
            if (options.keepToken && token === options.keepToken) continue;
            if (options.onlyToken && token !== options.onlyToken) continue;
            socket.emit('session_error', {
                status: options.status || 401,
                message: options.message || 'Session expired. Please sign in again.'
            });
            socket.disconnect(true);
        }
    } catch (error) {
        console.warn('[SOCKET] Session invalidation could not complete.');
    }
}

app.post('/api/auth/logout', async (req, res) => {
    try {
        const uid = req.authenticatedUid;
        const token = r3Bearer(req);
        await db.runTransaction(async transaction => {
            const ref = db.collection('Users').doc(uid);
            const current = await transaction.get(ref);
            if (current.exists && current.data().Token === token) {
                transaction.update(ref, { Token: FieldValue.delete() });
            }
        });
        await invalidateDashboardSockets(uid, { onlyToken: token });
        res.json({ success: true });
    } catch (error) { return a0Failure(res, error); }
});

async function verifyDashboardSocketSession(socket) {
    const current = await db.collection('Users').doc(socket.data.authenticatedUid).get();
    const user = current.exists ? current.data() : null;
    if (!user || user.Account_Deleted === true || user.Token !== socket.data.sessionToken) {
        throw dashboardSocketError(401, 'Session expired. Please sign in again.');
    }
    if (user.Status === 'Banned' || deletionV3AccessExpired(user)) {
        socket.disconnect(true);
        throw dashboardSocketError(403, 'Account access is blocked.');
    }
    socket.data.sessionUser = user;
    return user;
}

io.use(async (socket, next) => {
    try {
        const token = socket.handshake.auth && socket.handshake.auth.token;
        if (typeof token !== 'string' || !token.trim() || token.length > 1024) {
            return next(dashboardSocketError(401, 'Authentication token required.'));
        }
        const result = await db.collection('Users').where('Token', '==', token).limit(2).get();
        if (result.size !== 1) {
            return next(dashboardSocketError(401, 'Session expired. Please sign in again.'));
        }
        socket.data.authenticatedUid = result.docs[0].id;
        socket.data.sessionToken = token;
        await verifyDashboardSocketSession(socket);
        return next();
    } catch (error) {
        return next(error.data ? error : dashboardSocketError(503, 'Session verification is temporarily unavailable.'));
    }
});

io.on('connection', socket => {
    const uid = socket.data.authenticatedUid;
    // Idle sockets perform no scheduled Firestore session reads.

    const stopSupportListener = () => {
        if (socket.supportUnsub) {
            socket.supportUnsub();
            socket.supportUnsub = null;
        }
    };
    const endSession = error => {
        stopSupportListener();
        socket.emit('session_error', error.data || { status: 503, message: 'Session verification unavailable.' });
        socket.disconnect(true);
    };

    // Recheck each incoming application packet, not only the initial handshake.
    socket.use(async (packet, next) => {
        try {
            await verifyDashboardSocketSession(socket);
            next();
        } catch (error) {
            next(error);
            endSession(error);
        }
    });
    socket.on('error', error => {
        console.warn('Dashboard socket packet rejected:', error.data ? error.data.status : 'unknown');
    });

    // Incoming packets still verify the session.
    // Login, password reset, ban and logout explicitly invalidate sockets.
    // Account deletion retains its existing socket disconnect.

    Promise.resolve(socket.join(uid)).then(() => {
        if (!socket.connected) return;
        socket.emit('p2p_channel_ready', {
            authenticatedUid: uid,
            socketId: socket.id,
            serverTime: Date.now()
        });
    }).catch(error => {
        console.warn('[P2P CHANNEL] Room join failed:', error.message);
    });
    socket.on('join_my_room', () => {
        // A client-supplied UID is never used as the room identity.
        socket.join(uid);
    });

    let scanCancelWindow = 0;
    let scanCancelCount = 0;
    socket.on('p2p_scan_cancel', (data = {}) => {
        if (!data || typeof data !== 'object') return;
        const receiverUid = data.receiverUid;
        const scanEventId = data.scanEventId;
        if (typeof receiverUid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(receiverUid) ||
            receiverUid === uid || typeof scanEventId !== 'string' ||
            !/^[a-f0-9-]{36}$/i.test(scanEventId)) return;
        const now = Date.now();
        if (now - scanCancelWindow >= 10000) {
            scanCancelWindow = now;
            scanCancelCount = 0;
        }
        if (++scanCancelCount > 20) return;
        io.to(receiverUid).emit('p2p_scan_cancelled', {
            senderUid: uid,
            receiverUid,
            scanEventId
        });
    });

    chatModule15.attach(socket);

    socket.on('send_private_message', async (data = {}, acknowledgement) => {
        try {
            const sender = socket.data.sessionUser;
            const receiverUid = data.receiverUid;
            const message = data.message;
            if (
                typeof receiverUid !== 'string' || !receiverUid || receiverUid.includes('/') ||
                receiverUid === uid || typeof message !== 'string' ||
                !message.trim() || message.length > 4000
            ) {
                throw new Error('Invalid private message.');
            }
            const receiver = await db.collection('Users').doc(receiverUid).get();
            if (!receiver.exists || receiver.data().Status === 'Banned') {
                throw new Error('Recipient is unavailable.');
            }
            const senderName = typeof sender.Name === 'string' ? sender.Name : 'TCM User';
            const avatar = typeof sender.Avatar === 'string' ? sender.Avatar : '';
            const chatId = uid < receiverUid ? `${uid}_${receiverUid}` : `${receiverUid}_${uid}`;
            const batch = db.batch();
            const messageRef = db.collection('Private_Chats').doc(chatId).collection('Messages').doc();
            batch.set(messageRef, {
                senderUid: uid, senderName, avatar, message,
                timestamp: FieldValue.serverTimestamp(), deletedFor: [], status: 'sent'
            });
            batch.set(db.collection('Users').doc(uid).collection('Friends').doc(receiverUid), {
                lastMsg: 'You: ' + message, lastMsgTime: FieldValue.serverTimestamp()
            }, { merge: true });
            batch.set(db.collection('Users').doc(receiverUid).collection('Friends').doc(uid), {
                unreadCount: FieldValue.increment(1), lastMsg: message,
                lastMsgTime: FieldValue.serverTimestamp()
            }, { merge: true });
            await batch.commit();
            try { await f1Invalidate(uid, receiverUid); } catch (_) {}
            io.to(uid).emit('chat_v15_private_sent', { target: receiverUid });
            io.to(receiverUid).emit('receive_new_message', {
                senderUid: uid, receiverUid, senderName, avatar, message,
                id: messageRef.id, timestamp: new Date().toISOString()
            });
            if (typeof acknowledgement === 'function') acknowledgement({ success: true, id: messageRef.id });
        } catch (error) {
            if (typeof acknowledgement === 'function') acknowledgement({ success: false, message: error.message });
            console.warn('Private message rejected:', error.message);
        }
    });

    socket.on('join_support_chat', () => {
        stopSupportListener();
        let initial = true;
        socket.supportUnsub = db.collection('Support_Chats').doc(uid).collection('Messages')
            .orderBy('timestamp', 'desc').limit(1).onSnapshot(async snapshot => {
                if (initial) {
                    initial = false;
                    return;
                }
                try {
                    await verifyDashboardSocketSession(socket);
                    if (!socket.connected || !socket.supportUnsub) return;
                    for (const change of snapshot.docChanges()) {
                        if (change.type === 'added' && change.doc.data().sender === 'admin') {
                            socket.emit('receive_support_message', { id: change.doc.id, ...change.doc.data() });
                        }
                    }
                } catch (error) {
                    endSession(error);
                }
            }, error => console.warn('Support listener failed:', error.code || error.name));
    });
    socket.on('leave_support_chat', stopSupportListener);

    socket.on('send_support_message', async (data = {}, acknowledgement) => {
        try {
            const result = await supportConsole.sendUser(uid, socket.data.sessionToken, data);
            if (typeof acknowledgement === 'function') acknowledgement(result);
        } catch (error) {
            if (typeof acknowledgement === 'function') acknowledgement({success:false,status:error.status||503,message:error.status?error.message:'Support message could not be confirmed. Retry the same send.'});
        }
    });

    socket.on('disconnect', () => {
        // No idle session timer to clear.
        stopSupportListener();
    });
});

// ==============================================================
// 🚀 STEP 1: ADD BONUS TO REDIS & PUSH LIVE SOCKET (In server.js)
// ==============================================================
// ==============================================================
// 🚀 STEP 1: ADD BONUS TO REDIS & DYNAMIC ROLL-UP (In server.js)
// ==============================================================
async function processTeamBonus(leaderUid, commissionAmount, sourceUid = "Unknown", eventId) {
    // eventId must identify the source order AND the commission hand/type.
    // Persist before returning; retries must reuse exactly the same eventId.
    const jobId = await moneyV6CreateJob(leaderUid, commissionAmount, sourceUid, eventId);
    setImmediate(() => { void syncRedisToFirebase(); });
    return { queued: true, jobId };
}

// ==============================================================
// ⚙️ STEP 2: BACKGROUND SYNC & GRACEFUL SHUTDOWN (Render Fix)
// ==============================================================
// MEMO TCM-STK-012-P2 | 2026-10-10 01:23 IST | Asia/Kolkata
// MONEY-V6: Durable bonus jobs. Redis is only a legacy import source.
function moneyV6JobId(parts) {
    return require('crypto').createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function moneyV6Uid(raw) {
    if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(raw)) {
        throw admS2Error('Invalid team bonus UID.');
    }
    return raw;
}

async function moneyV6CreateJob(leaderUid, commissionAmount, sourceUid, eventId) {
    const uid = !leaderUid || String(leaderUid).toUpperCase() === 'SYSTEM'
        ? 'SYSTEM' : moneyV6Uid(leaderUid);
    if (typeof sourceUid !== 'string' || !sourceUid.trim() || sourceUid.length > 200 ||
        typeof eventId !== 'string' || !eventId.trim() || eventId.length > 200) {
        throw admS2Error('A stable source event ID and source UID are required for team bonus jobs.');
    }
    const micro = admS2Micro(commissionAmount, 'team bonus amount', false);
    const amount = admS2Money(micro);
    const id = moneyV6JobId(['EVENT-V1', eventId]);
    const fingerprint = moneyV6JobId([uid, eventId, sourceUid, micro.toString()]);
    const ref = db.collection('Team_Bonus_Jobs').doc(id);
    await db.runTransaction(async t => {
        const current = await t.get(ref);
        if (current.exists) {
            if (current.data().Fingerprint !== fingerprint) throw admS2Error('Team bonus event ID conflict.', 409);
            return;
        }
        if (uid !== 'SYSTEM') {
            const user = await t.get(db.collection('Users').doc(uid));
            if (!user.exists || user.data().Account_Deleted === true ||
                ['Banned', 'Pending_Deletion'].includes(user.data().Status)) {
                throw admS2Error('Team bonus recipient is unavailable.', 409);
            }
        }
        t.create(ref, {
            Version: 1, UID: uid, Source_UID: sourceUid, Event_ID: eventId,
            Fingerprint: fingerprint, Amount: amount, Amount_micro: micro.toString(),
            Origin: 'Event', Ledger_ID: 'TX-TEAM-V6-' + id, State: 'Pending',
            Cache_Invalidation_Pending: false, Created_At: FieldValue.serverTimestamp()
        });
    });
    return id;
}

async function moneyV6ImportBatch(uid, batch, rawBatch) {
    moneyV6Uid(uid);
    if (batch.uid !== uid || typeof batch.id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(batch.id) ||
        typeof batch.amount !== 'string' || !batch.amount.trim()) {
        throw admS2Error('Invalid legacy team bonus batch.');
    }
    const id = moneyV6JobId(['LEGACY-V1', uid, batch.id]);
    const ref = db.collection('Team_Bonus_Jobs').doc(id);
    const fingerprint = moneyV6JobId([uid, rawBatch]);
    const ledgerId = 'TX-TEAM-' + batch.id;
    await db.runTransaction(async t => {
        const current = await t.get(ref);
        const ledger = await t.get(db.collection('Transactions').doc(ledgerId));
        if (current.exists) {
            if (current.data().Fingerprint !== fingerprint) throw admS2Error('Legacy bonus job conflict.', 409);
            return;
        }
        let micro = null;
        try {
            micro = moneyV1ReadLegacy(batch.amount, 'legacy team bonus').micro;
            if (micro <= 0n) micro = null;
        } catch (error) { /* Keep the original amount for explicit review. */ }
        if (ledger.exists) {
            const old = ledger.data();
            if (old.UID !== uid || old.Status !== 'Success' || old.Type !== 'Team Reservation Bonus' ||
                !Number.isFinite(Number(batch.amount)) || Number(batch.amount) <= 0 ||
                old.Amount !== Number(batch.amount)) {
                throw admS2Error('Legacy team bonus ledger conflict.', 409);
            }
        }
        const job = {
            Version: 1, UID: uid, Source_UID: 'Legacy Redis batch', Event_ID: batch.id,
            Fingerprint: fingerprint, Origin: 'Legacy_Redis', Legacy_Amount: batch.amount,
            Ledger_ID: ledgerId, State: ledger.exists ? 'Credited' : micro === null ? 'Needs_Review' : 'Pending',
            Cache_Invalidation_Pending: ledger.exists, Created_At: FieldValue.serverTimestamp()
        };
        if (micro !== null) {
            job.Amount_micro = micro.toString();
            job.Amount = admS2Money(micro);
        } else {
            job.Review_Code = 'LEGACY_AMOUNT_RECONCILIATION';
        }
        t.create(ref, job);
    });
    return id;
}

async function moneyV6SettleJob(ref) {
    return db.runTransaction(async t => {
        incomeDayStates.delete(t);
        const snapshot = await t.get(ref);
        if (!snapshot.exists) return false;
        const job = snapshot.data();
        if (job.State !== 'Pending') return false;
        const review = message => Object.assign(admS2Error(message, 409), { teamReview: true });
        if (job.Version !== 1 || typeof job.Amount_micro !== 'string' ||
            !/^[1-9]\d{0,15}$/.test(job.Amount_micro) ||
            typeof job.Ledger_ID !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(job.Ledger_ID)) {
            throw review('Invalid durable team bonus job.');
        }
        let uid;
        try { uid = moneyV6Uid(job.UID); } catch (error) { throw review('Invalid team bonus recipient.'); }
        const micro = BigInt(job.Amount_micro);
        let amount;
        try { amount = admS2Money(micro); } catch (error) { throw review('Team bonus amount requires reconciliation.'); }
        if (job.Amount !== amount) throw review('Team bonus amount evidence mismatch.');
        const ledgerRef = db.collection('Transactions').doc(job.Ledger_ID);
        const ledger = await t.get(ledgerRef);
        if (ledger.exists) {
            const old = ledger.data();
            if (job.Origin === 'Legacy_Redis' && old.UID === uid && old.Status === 'Success' &&
                old.Type === 'Team Reservation Bonus' && old.Amount === Number(job.Legacy_Amount)) {
                t.update(ref, { State: 'Credited', Credited_At: FieldValue.serverTimestamp(),
                    Cache_Invalidation_Pending: true });
                return false;
            }
            throw review('Unexpected existing team bonus ledger.');
        }
        if (uid === 'SYSTEM') {
            const treasuryRef = db.collection('Admin_Data').doc('TCM_TREASURY');
            const treasury = await t.get(treasuryRef);
            const data = treasury.exists ? treasury.data() : {};
            let updates;
            try {
                updates = {
                    Missed_Bonus_Pool: admS2Money(admS2Balance(data, 'Missed_Bonus_Pool') + micro),
                    Total_Breakage_Profit: admS2Money(admS2Balance(data, 'Total_Breakage_Profit') + micro)
                };
            } catch (error) { throw review('Breakage treasury requires reconciliation.'); }
            t.set(treasuryRef, moneyV7Updates(data, updates, 'Treasury', 'merge'), { merge: true });
            t.create(db.collection('Missed_Bonus_Logs').doc(ref.id), {
                Target_UID: 'SYSTEM', Missed_Amount: amount, Amount_micro: micro.toString(),
                Reason: 'No Sponsor Provided', Origin_UID: job.Source_UID,
                Date: new Date().toISOString(), timestamp: FieldValue.serverTimestamp()
            });
        } else {
            const walletRef = db.collection('Wallets').doc(uid);
            const userRef = db.collection('Users').doc(uid);
            const wallet = await t.get(walletRef);
            const user = await t.get(userRef);
            if (!wallet.exists || !user.exists || user.data().Account_Deleted === true || user.data().Status === 'Banned') {
                throw review('Team bonus account requires review.');
            }
            let updates;
            try {
                const data = wallet.data();
                updates = {
                    Main_Balance: admS2Money(admS2Balance(data, 'Main_Balance') + micro),
                    Total_Team: admS2Money(admS2Balance(data, 'Total_Team') + micro),
                    Total_Comp: admS2Money(admS2Balance(data, 'Total_Comp') + micro),
                    ...moneyV4NFTDailyUpdates(t, walletRef, data, { Daily_Team: amount, Daily_Comp: amount })
                };
            } catch (error) { throw review('Team bonus wallet requires reconciliation.'); }
            t.update(walletRef, moneyV7Updates(wallet.data(), { ...updates,
                ...t8MainEntry(t, uid, wallet.data(), updates.Main_Balance, 'Team reservation bonus', job.Event_ID) }, 'Wallet', 'update'));
            t.update(userRef, { 'counters.txCount': nextStakingTxCount(user.data()) });
        }
        t.create(ledgerRef, t9Record(t, {
            UID: uid === 'SYSTEM' ? 'TCM_TREASURY' : uid,
            Type: uid === 'SYSTEM' ? 'Team Bonus Breakage' : 'Team Reservation Bonus',
            Amount: amount, Amount_micro: micro.toString(), Status: 'Success',
            Order_ID: 'TEAM-' + (job.Origin === 'Legacy_Redis' ? job.Event_ID : ref.id),
            Job_ID: ref.id, Event_ID: job.Event_ID,
            Date: new Date().toISOString(), timestamp: FieldValue.serverTimestamp()
        }));
        t.update(ref, { State: 'Credited', Credited_At: FieldValue.serverTimestamp(),
            Cache_Invalidation_Pending: uid !== 'SYSTEM' });
        return true;
    });
}

async function moneyV6ReviewJob(ref) {
    await db.runTransaction(async t => {
        const snapshot = await t.get(ref);
        if (snapshot.exists && snapshot.data().State === 'Pending') {
            t.update(ref, { State: 'Needs_Review', Review_Code: 'SETTLEMENT_RECONCILIATION',
                Review_At: FieldValue.serverTimestamp() });
        }
    });
}

async function moneyV6RunJobs() {
    const pending = await db.collection('Team_Bonus_Jobs').where('State', '==', 'Pending').limit(50).get();
    for (const job of pending.docs) {
        try { await moneyV6SettleJob(job.ref); }
        catch (error) {
            if (error.teamReview === true) await moneyV6ReviewJob(job.ref);
            else console.warn('[TEAM V6] Durable job retained for retry:', job.id);
        }
    }
    const cached = await db.collection('Team_Bonus_Jobs')
        .where('Cache_Invalidation_Pending', '==', true).limit(50).get();
    for (const job of cached.docs) {
        try {
            await clearUserCache(job.data().UID);
            await job.ref.update({ Cache_Invalidation_Pending: false });
        } catch (error) { console.warn('[TEAM V6] Cache invalidation retained for retry:', job.id); }
    }
}

let teamBonusSyncPromise = null;

const syncRedisToFirebase = () => {
    if (teamBonusSyncPromise) return teamBonusSyncPromise;
    teamBonusSyncPromise = (async () => {
        const claimScript = `
            local current = redis.call('GET', KEYS[2])
            if current then return current end

            local amount = redis.call('GET', KEYS[1])
            if not amount then return false end

            local numeric = tonumber(amount)
            if not numeric or numeric <= 0 then
                return redis.error_reply('INVALID_PENDING_BONUS')
            end

            local batch = cjson.decode(ARGV[1])
            batch.amount = amount
            local encoded = cjson.encode(batch)

            redis.call('SET', KEYS[2], encoded)
            redis.call('DEL', KEYS[1])
            return encoded
        `;

        const acknowledgeScript = `
            if redis.call('GET', KEYS[1]) == ARGV[1] then
                return redis.call('DEL', KEYS[1])
            end
            return 0
        `;
        if (redisClient && redisClient.isReady) {
            try {
                const users = new Set();
                for (const prefix of ['pending_team_bonus:', 'processing_team_bonus:']) {
                    let cursor = '0';
                    do {
                        const page = await redisClient.scan(cursor, { MATCH: prefix + '*', COUNT: 100 });
                        cursor = page.cursor;
                        for (const key of page.keys) users.add(String(key).slice(prefix.length));
                    } while (String(cursor) !== '0');
                }
                for (const uid of users) {
                    try {
                        moneyV6Uid(uid);
                        const pendingKey = 'pending_team_bonus:' + uid;
                        const processingKey = 'processing_team_bonus:' + uid;
                        const claimed = await redisClient.eval(claimScript, {
                            keys: [pendingKey, processingKey],
                            arguments: [JSON.stringify({ id: require('crypto').randomUUID(), uid, createdAt: Date.now() })]
                        });
                        if (!claimed) continue;
                        const rawBatch = String(claimed);
                        await moneyV6ImportBatch(uid, JSON.parse(rawBatch), rawBatch);
                        // The durable job now owns recovery, even if Redis disappears.
                        await redisClient.eval(acknowledgeScript, { keys: [processingKey], arguments: [rawBatch] });
                    } catch (error) {
                        console.warn('[TEAM V6] Legacy account retained for retry:', uid);
                    }
                }
            } catch (error) { console.warn('[TEAM V6] Legacy Redis scan deferred. Durable jobs continue.'); }
        }
        await moneyV6RunJobs();
    })().catch(error => {
        console.warn('[TEAM V6] Durable recovery deferred; jobs retained.');
    }).finally(() => { teamBonusSyncPromise = null; });
    return teamBonusSyncPromise;
};

// ⏳ ৫ মিনিট অন্তর অন্তর রেগুলার সিঙ্ক হবে
setInterval(syncRedisToFirebase, 5 * 60 * 1000);

// 🔥 Render.com Sleep / Restart Data Loss Fix (Graceful Shutdown)
process.on('SIGTERM', async () => {
    console.log('⚠️ SIGTERM received from Render! Saving Redis memory data to Firebase before shutting down...');
    await syncRedisToFirebase();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('⚠️ SIGINT received! Saving Redis memory data to Firebase before shutting down...');
    await syncRedisToFirebase();
    process.exit(0);
});

// =========================================================
// 🗑️ MODULE 12: ACCOUNT DELETION ENGINE
// =========================================================

async function deletionV1IssueOtp(req, res, purpose) {
    let issueKey;
    let issueOwner;
    let otpKey;
    let proof;
    try {
        tcmAuthResetKey();
        const uid = req.authenticatedUid;
        const actor = req.authenticatedUserDoc;
        const hash = req.deletionSessionHash;
        if (!uid || !hash || !actor?.exists || actor.id !== uid) {
            throw deletionV1Error(401, 'Session unavailable. Sign in again.');
        }
        if (req.body?.uid !== undefined && req.body.uid !== uid) {
            throw deletionV1Error(403, 'Account ownership mismatch.');
        }
        const user = actor.data();
        if (purpose === 'cancel' && user.Status !== 'Pending_Deletion') {
            throw deletionV1Error(409, 'There is no pending deletion to cancel.');
        }
        if (typeof user.Email !== 'string' || !user.Email.includes('@')) {
            throw deletionV1Error(400, 'Account email unavailable.');
        }
        issueKey = 'tcm:del:v1:issuing:' + hash + ':' + purpose;
        issueOwner = r3Crypto.randomUUID();
        const locked = await r3SecurityRedis(() => redisClient.set(issueKey, issueOwner, { NX: true, EX: 45 }));
        if (locked !== 'OK') throw deletionV1Error(409, 'An OTP request is already in progress.');
        const otp = String(r3Crypto.randomInt(100000, 1000000));
        const id = r3Crypto.randomUUID();
        proof = { id, uid, purpose, attempts: 0, issuedAt: Date.now(), expiresAt: Date.now() + 600000,
            digest: deletionV1OtpDigest(uid, hash, purpose, id, otp) };
        otpKey = 'tcm:del:v1:otp:' + hash + ':' + purpose;
        await r3SecurityRedis(() => redisClient.setEx(otpKey, 600, JSON.stringify(proof)));
        let mailTimer;
        try {
            await Promise.race([
                transporter.sendMail({
                    from: '"TCM Security" <' + process.env.EMAIL_USER + '>',
                    to: user.Email,
                    subject: purpose === 'delete' ? 'TCM account deletion verification' : 'TCM cancel deletion verification',
                    ...tcmSecurityEmail({ name: user.Name,
                        title: purpose === 'delete' ? 'Account deletion verification' : 'Cancel deletion verification',
                        action: purpose === 'delete' ? 'account deletion' : 'cancelling account deletion',
                        otp, minutes: 10 })
                }),
                new Promise((_, reject) => {
                    mailTimer = setTimeout(() => reject(new Error('Mail delivery timed out.')), 10000);
                })
            ]);
        } catch (error) {
            await r3SecurityRedis(() => redisClient.eval(`
                local raw = redis.call('GET', KEYS[1])
                if not raw then return 0 end
                local value = cjson.decode(raw)
                if value.id ~= ARGV[1] then return 0 end
                redis.call('DEL', KEYS[1])
                return 1`, { keys: [otpKey], arguments: [proof.id] }));
            throw deletionV1Error(503, 'The verification email could not be confirmed. Request a new code.');
        } finally {
            clearTimeout(mailTimer);
        }
        res.json({ success: true, otpRequestId: id, expiresIn: 600,
            message: 'Verification code sent. It expires in 10 minutes.' });
    } catch (error) {
        res.status(error.statusCode || 503).json({ success: false,
            code: error.code || 'DELETION_VERIFICATION',
            message: error.statusCode ? error.message : 'Deletion OTP service is unavailable.' });
    } finally {
        if (issueKey && issueOwner) {
            try {
                await r3SecurityRedis(() => redisClient.eval(`
                    if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
                    redis.call('DEL', KEYS[1])
                    return 1`, { keys: [issueKey], arguments: [issueOwner] }));
            } catch (error) {
                console.warn('[DELETE] OTP issue lock cleanup deferred.');
            }
        }
    }
}

async function deletionV1ClaimOtp(req, purpose) {
    const uid = req.authenticatedUid;
    const hash = req.deletionSessionHash;
    const { otp, otpRequestId } = req.body || {};
    if (typeof otp !== 'string' || !/^\d{6}$/.test(otp) ||
        typeof otpRequestId !== 'string' || !/^[a-f0-9-]{36}$/.test(otpRequestId)) {
        throw deletionV1Error(400, 'Request a fresh verification code in this modal.');
    }
    const key = 'tcm:del:v1:otp:' + hash + ':' + purpose;
    const lease = r3Crypto.randomUUID();
    const now = Date.now();
    const digest = deletionV1OtpDigest(uid, hash, purpose, otpRequestId, otp);
    const result = Number(await r3SecurityRedis(() => redisClient.eval(`
        local raw = redis.call('GET', KEYS[1])
        if not raw then return 0 end
        local value = cjson.decode(raw)
        local now = tonumber(ARGV[5])
        if value.id ~= ARGV[1] or value.uid ~= ARGV[2] or value.purpose ~= ARGV[3] then return 0 end
        if not value.expiresAt or value.expiresAt <= now then redis.call('DEL', KEYS[1]); return 0 end
        if not value.attempts or value.attempts >= 5 then return 0 end
        if value.digest ~= ARGV[4] then
            value.attempts = value.attempts + 1
            redis.call('SET', KEYS[1], cjson.encode(value), 'KEEPTTL')
            return 0
        end
        if value.lease and value.leaseUntil and value.leaseUntil > now then return 2 end
        value.lease = ARGV[6]
        value.leaseUntil = now + 120000
        redis.call('SET', KEYS[1], cjson.encode(value), 'KEEPTTL')
        return tostring(value.expiresAt)`, {
        keys: [key], arguments: [otpRequestId, uid, purpose, digest, String(now), lease]
    })));
    if (result === 2) throw deletionV1Error(409, 'Verification is being processed. Check the account state before retrying.');
    if (!Number.isFinite(result) || result <= now) throw deletionV1Error(400, 'Verification code is invalid, expired or already used.');
    return { key, lease, id: otpRequestId, expiresAt: result, leaseUntil: now + 120000 };
}

async function deletionV1FinishOtp(proof, consume) {
    await r3SecurityRedis(() => redisClient.eval(`
        local raw = redis.call('GET', KEYS[1])
        if not raw then return 0 end
        local value = cjson.decode(raw)
        if value.id ~= ARGV[1] or value.lease ~= ARGV[2] then return 0 end
        if ARGV[3] == 'consume' then redis.call('DEL', KEYS[1]); return 1 end
        value.lease = nil
        value.leaseUntil = nil
        redis.call('SET', KEYS[1], cjson.encode(value), 'KEEPTTL')
        return 1`, { keys: [proof.key], arguments: [proof.id, proof.lease, consume ? 'consume' : 'release'] }));
}

function deletionV2Money(raw) {
    try {
        const parsed = moneyV1ReadLegacy(raw, 'deletion balance');
        return { micro: parsed.micro, exactZero: parsed.exactZero, amount: parsed.amount };
    } catch (error) {
        return null;
    }
}

function deletionV1WalletClear(wallet) {
    const fields = [
        ['Main_Balance', 'Main balance', 'Withdraw the remaining available balance.'],
        ['Locked_Balance', 'Locked balance', 'Complete the existing unlock or settlement process.'],
        ['Admin_Locked_Balance', 'Admin locked balance', 'Contact support about this locked balance.'],
        ['Debt', 'Debt', 'Complete the outstanding account adjustment.']
    ];
    const rows = fields.map(([key, label, action]) => {
        const raw = wallet && wallet[key] === undefined && key !== 'Main_Balance'
            ? 0 : wallet?.[key];
        let parsed;
        try {
            if (wallet && moneyV7Canonical(wallet, 'Wallet')) {
                const micro = admS2Balance(wallet, key);
                parsed = { micro, exactZero: micro === 0n, amount: moneyV1Text(micro) };
            } else parsed = deletionV2Money(raw);
        } catch (error) { parsed = null; }
        if (!parsed) {
            return { key, label, status: 'unknown', detail: 'Balance needs verification or reconciliation.' };
        }
        const dust = key === 'Main_Balance' && !parsed.exactZero && parsed.micro < 10000n;
        const status = parsed.exactZero ? 'clear' : dust ? 'dust' : 'blocked';
        let detail = status === 'clear' ? 'No outstanding balance.' : action;
        if (dust) {
            detail = 'Below 0.01 USDT. Closure is allowed only when all other obligations are clear. The residual remains recorded in the retained wallet.';
        } else if (!parsed.exactZero && parsed.micro === 0n) {
            detail = 'A positive balance below one micro-unit remains. Reconciliation is required.';
        }
        return { key, label, status, amount: parsed.amount, detail };
    });
    const locks = wallet?.Locked_Withdrawals;
    const validLocks = !!wallet && (locks === undefined || Array.isArray(locks));
    rows.push({
        key: 'Locked_Withdrawals', label: 'Withdrawal locks',
        status: !validLocks ? 'unknown' : locks?.length ? 'blocked' : 'clear',
        detail: !validLocks ? 'Withdrawal locks could not be verified.' : locks?.length
            ? 'Complete the outstanding withdrawal locks.' : 'No outstanding withdrawal locks.'
    });
    return rows;
}

async function deletionV2CollectClearance(reader, uid, walletRef, preview = false) {
    let wallet;
    let walletState = 'unavailable';
    try {
        const snapshot = await reader.get(walletRef);
        wallet = snapshot.exists ? snapshot.data() : null;
        walletState = snapshot.exists ? 'available' : 'missing';
    } catch (error) {
        if (!preview) throw error;
        wallet = null;
    }
    const rows = deletionV1WalletClear(wallet);
    if (walletState === 'missing') {
        for (const row of rows) if (row.status === 'unknown') {
            row.detail = 'Wallet record is missing. The balance is not assumed to be zero. Contact support with your UID.';
        }
    }
    const checks = [
        {
            key: 'staking', label: 'Staking contracts',
            query: db.collection('Staking_Contracts').where('UID', '==', uid)
                .where('status', 'in', ['Active', 'Matured']).limit(1),
            blocked: 'At least one active or matured unclaimed contract remains. Complete maturity and claiming.',
            clear: 'No active or matured unclaimed contracts.'
        },
        {
            key: 'nfts', label: 'Reserved NFTs',
            query: db.collection('NFT_Gallery').where('Owner_UID', '==', uid)
                .where('Status', '==', 'Reserved').limit(1),
            blocked: 'At least one reserved NFT remains. Complete its normal settlement process.',
            clear: 'No reserved NFTs.'
        },
        {
            key: 'transactions', label: 'Pending transactions',
            query: db.collection('Transactions').where('UID', '==', uid)
                .where('Status', 'in', ['Pending', 'Processing']).limit(1),
            blocked: 'At least one transaction is pending or processing. Wait for its final result.',
            clear: 'No pending or processing transactions.'
        },
        {
            key: 'durable_bonuses', label: 'Durable bonus jobs',
            query: db.collection('Team_Bonus_Jobs').where('UID', '==', uid)
                .where('State', 'in', ['Pending', 'Needs_Review']).limit(1),
            blocked: 'A durable bonus job is pending or requires reconciliation.',
            clear: 'No outstanding durable bonus jobs.'
        }
    ];
    for (const check of checks) {
        try {
            const snapshot = await reader.get(check.query);
            rows.push({ key: check.key, label: check.label,
                status: snapshot.empty ? 'clear' : 'blocked',
                detail: snapshot.empty ? check.clear : check.blocked });
        } catch (error) {
            if (!preview) throw error;
            rows.push({ key: check.key, label: check.label, status: 'unknown',
                detail: 'Could not verify this category. Please retry later.' });
        }
    }
    try {
        const queued = Number(await r3SecurityRedis(() => redisClient.exists([
            'pending_team_bonus:' + uid, 'processing_team_bonus:' + uid
        ])));
        if (!Number.isInteger(queued) || queued < 0 || queued > 2) {
            throw deletionV1Error(503, 'Bonus settlement status is unavailable.');
        }
        rows.push({ key: 'bonuses', label: 'Bonus settlement',
            status: queued ? 'blocked' : 'clear',
            detail: queued ? 'A bonus settlement is pending. Wait for completion.' : 'No queued bonus settlement.' });
    } catch (error) {
        if (!preview) throw error;
        rows.push({ key: 'bonuses', label: 'Bonus settlement', status: 'unknown',
            detail: 'Could not verify queued bonuses. Please retry later.' });
    }
    return {
        version: 1,
        checkedAt: new Date().toISOString(),
        verified: rows.every(row => row.status !== 'unknown'),
        canDelete: rows.every(row => row.status === 'clear' || row.status === 'dust'),
        dustThreshold: '0.010000',
        walletState,
        rows
    };
}

async function deletionV1ReadObligations(transaction, uid, walletRef) {
    const clearance = await deletionV2CollectClearance(transaction, uid, walletRef);
    if (!clearance.canDelete) {
        const error = deletionV1Error(clearance.verified ? 409 : 503,
            clearance.verified ? 'Review the settlement breakdown before deleting the account.'
                : 'Some account balances could not be verified. Contact support or retry later.',
            clearance.verified ? 'DELETION_OBLIGATIONS' : 'DELETION_CLEARANCE_UNAVAILABLE');
        error.clearance = clearance;
        throw error;
    }
    return clearance;
}

app.get('/api/user/deletion-clearance', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const uid = req.authenticatedUid;
        const actor = req.authenticatedUserDoc;
        if (!uid || !actor?.exists || actor.id !== uid) {
            throw deletionV1Error(401, 'Sign in required.');
        }
        if (req.query.uid !== undefined && req.query.uid !== uid) {
            throw deletionV1Error(403, 'Account ownership mismatch.');
        }
        if (actor.data().Status === 'Banned' || actor.data().Account_Deleted === true) {
            throw deletionV1Error(403, 'Account access is blocked.', 'ACCOUNT_BLOCKED');
        }
        await r3SecurityRate(req, 'clearance-preview', 12, 300);
        const clearance = await deletionV2CollectClearance(
            { get: reference => reference.get() }, uid, db.collection('Wallets').doc(uid), true
        );
        const user = actor.data();
        const savedRank = (typeof user.Rank === 'number' && Number.isInteger(user.Rank) || typeof user.Rank === 'string' && /^[0-6]$/.test(user.Rank))
            && Number(user.Rank) >= 0 && Number(user.Rank) <= 6 ? Number(user.Rank) : null;
        clearance.account = { uid, name: typeof user.Name === 'string' ? user.Name.slice(0, 120) : null,
            status: typeof user.Status === 'string' ? user.Status.slice(0, 40) : null, rank: savedRank };
        res.json({ success: true, clearance });
    } catch (error) {
        res.status(error.statusCode || 503).json({ success: false,
            code: error.code || 'DELETION_CLEARANCE_UNAVAILABLE',
            message: error.statusCode ? error.message : 'Settlement preview is temporarily unavailable.' });
    }
});

function deletionV1CheckUser(snapshot, req) {
    if (!snapshot.exists) throw deletionV1Error(401, 'Account unavailable.');
    const user = snapshot.data();
    if (user.Token !== r3Bearer(req)) throw deletionV1Error(401, 'Session changed. Sign in again.');
    if (user.Status === 'Banned') throw deletionV1Error(403, 'Account access is blocked.', 'ACCOUNT_BLOCKED');
    const code = req.body?.code2FA;
    if (typeof code !== 'string' || !/^\d{6}$/.test(code) || !user['2FA_Key'] ||
        !authenticator.verify({ token: code, secret: user['2FA_Key'] })) {
        throw deletionV1Error(400, 'Invalid 2FA code. Your email OTP remains available until it expires.');
    }
    return user;
}

app.post('/api/user/deletion-otp', (req, res) => deletionV1IssueOtp(req, res, 'delete'));
app.post('/api/user/cancel-deletion-otp', (req, res) => deletionV1IssueOtp(req, res, 'cancel'));

async function deletionV1Action(req, res, purpose) {
    let proof;
    let committed = false;
    try {
        const uid = req.authenticatedUid;
        if (!uid || !req.deletionSessionHash) throw deletionV1Error(401, 'Sign in required.');
        if (req.body?.uid !== undefined && req.body.uid !== uid) {
            throw deletionV1Error(403, 'Account ownership mismatch.');
        }
        proof = await deletionV1ClaimOtp(req, purpose);
        const userRef = db.collection('Users').doc(uid);
        const result = await db.runTransaction(async transaction => {
            const snapshot = await transaction.get(userRef);
            const user = deletionV1CheckUser(snapshot, req);
            if (Date.now() >= proof.expiresAt || Date.now() >= proof.leaseUntil) {
                throw deletionV1Error(409, 'Verification expired while processing. Check the account state and request a new code.');
            }
            if (purpose === 'cancel') {
                if (user.Status === 'Active' && user.Deletion_Cancel_Id === proof.id) {
                    return { cancelled: true };
                }
                if (user.Status !== 'Pending_Deletion') throw deletionV1Error(409, 'No pending deletion to cancel.');
                transaction.update(userRef, { Delete_At: FieldValue.delete(), Status: 'Active',
                    Deletion_Request_Id: FieldValue.delete(), Deletion_Cancel_Id: proof.id,
                    Deletion_Requested_At: FieldValue.delete(), Deletion_Deadline: FieldValue.delete(),
                    DeletionCleanupCode: FieldValue.delete(), DeletionCleanupReasons: FieldValue.delete(),
                    DeletionCleanupAttemptedAt: FieldValue.delete() });
                return { cancelled: true };
            }
            if (user.Status === 'Pending_Deletion' && Number.isFinite(user.Delete_At)) {
                return { deleteTime: user.Delete_At };
            }
            if (user.Status !== 'Active') throw deletionV1Error(409, 'Account status does not allow deletion.');
            await deletionV1ReadObligations(transaction, uid, db.collection('Wallets').doc(uid));
            const deadline = Date.now() + 86400000;
            transaction.update(userRef, { Delete_At: deadline, Status: 'Pending_Deletion',
                Deletion_Request_Id: proof.id, Deletion_Cancel_Id: FieldValue.delete(),
                Deletion_Requested_At: deadline - 86400000, Deletion_Deadline: deadline,
                DeletionCleanupCode: FieldValue.delete(), DeletionCleanupReasons: FieldValue.delete(),
                DeletionCleanupAttemptedAt: FieldValue.delete() });
            return { deleteTime: deadline };
        });
        committed = true;
        try { await deletionV1FinishOtp(proof, true); } catch (error) {
            console.warn('[DELETE] Committed action; OTP acknowledgement deferred.');
        }
        try { await clearUserCache(uid); } catch (error) {
            console.warn('[DELETE] Committed action; cache invalidation deferred.');
        }
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(error.statusCode || 503).json({ success: false,
            code: error.code || 'DELETION_VERIFICATION',
            message: error.statusCode ? error.message : 'Deletion could not complete. Check the account state before retrying.',
            ...(error.clearance ? { clearance: error.clearance } : {})
        });
    } finally {
        if (proof && !committed) {
            try { await deletionV1FinishOtp(proof, false); } catch (error) {
                console.warn('[DELETE] OTP verification lease will expire automatically.');
            }
        }
    }
}

app.post('/api/user/request-delete', (req, res) => deletionV1Action(req, res, 'delete'));
app.post('/api/user/cancel-delete', (req, res) => deletionV1Action(req, res, 'cancel'));

// Personal profile erasure keeps a non-login UID tombstone and all financial records.
let deletionV1CleanerRunning = false;
let deletionV1CleanerCursor = null;
async function deletionV1CleanAccount(uid) {
    const userRef = db.collection('Users').doc(uid);
    const result = await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(userRef);
        if (!snapshot.exists) return null;
        const user = snapshot.data();
        if (user.Account_Deleted === true && user.AuthCleanupPending === true) return { uid, erased: false };
        if (user.Status !== 'Pending_Deletion' || !Number.isFinite(user.Delete_At) || user.Delete_At > Date.now()) return null;
        const walletRef = db.collection('Wallets').doc(uid);
        await deletionV1ReadObligations(transaction, uid, walletRef);
        transaction.update(walletRef, { Points: 0 });
        transaction.set(userRef, { UID: uid, abdar: '', Name: 'Deleted account', Role: 'User', Status: 'Banned',
            Account_Deleted: true, Deleted_At: FieldValue.serverTimestamp(),
            Delete_At: user.Delete_At, AuthCleanupPending: true,
            Deletion_Deadline: user.Delete_At,
            Deletion_Requested_At: user.Deletion_Requested_At ?? user.Delete_At - 86400000 });
        transaction.create(db.collection('AdminLogs').doc('ACCOUNT-DELETE-' + uid), {
            Admin_Name: 'System', Actor_UID: 'SYSTEM', Target_UID: uid,
            Action_Type: 'Account Profile Deleted',
            Details: 'Personal profile erased; UID reserved; wallet and financial ledgers retained.',
            timestamp: FieldValue.serverTimestamp()
        });
        return { uid, erased: true };
    });
    if (!result) return null;
    try { await clearUserCache(uid); } catch (error) { console.warn('[DELETE] Erasure cache cleanup deferred.'); }
    try { if (global.io) global.io.in(uid).disconnectSockets(true); } catch (error) {
        console.warn('[DELETE] Erasure socket cleanup deferred.');
    }
    try {
        try { await require('firebase-admin/auth').getAuth().deleteUser(uid); } catch (error) {
            if (error.code !== 'auth/user-not-found') throw error;
        }
        await db.runTransaction(async transaction => {
            const snapshot = await transaction.get(userRef);
            if (snapshot.exists && snapshot.data().Account_Deleted === true) {
                transaction.update(userRef, { AuthCleanupPending: false, Delete_At: FieldValue.delete(),
                    AuthCleanupError: FieldValue.delete(), AuthCleanupAttemptedAt: FieldValue.serverTimestamp() });
            }
        });
    } catch (error) {
        const code = String(error.code || 'AUTH_CLEANUP_UNAVAILABLE').replace(/[^a-zA-Z0-9_/-]/g, '').slice(0, 100);
        console.warn('[DELETE] Firebase Auth cleanup deferred:', uid, code, '; account remains blocked.');
        try {
            await db.runTransaction(async transaction => {
                const snapshot = await transaction.get(userRef);
                if (snapshot.exists && snapshot.data().Account_Deleted === true &&
                    snapshot.data().AuthCleanupPending === true) {
                    transaction.update(userRef, { AuthCleanupError: code,
                        AuthCleanupAttemptedAt: FieldValue.serverTimestamp() });
                }
            });
        } catch (auditError) {
            console.warn('[DELETE] Auth cleanup diagnostic write deferred:', uid);
        }
    }
    return result;
}

async function deletionV1RunCleaner() {
    if (deletionV1CleanerRunning) return;
    deletionV1CleanerRunning = true;
    let erased = 0;
    try {
        let cursor = deletionV1CleanerCursor;
        for (let page = 0; page < 4; page++) {
            let query = db.collection('Users').where('Delete_At', '<=', Date.now())
                .orderBy('Delete_At').orderBy(r3FieldPath.documentId()).limit(25);
            if (cursor) query = query.startAfter(cursor);
            const snapshot = await query.get();
            if (snapshot.empty) { deletionV1CleanerCursor = null; break; }
            for (const doc of snapshot.docs) {
                try {
                    const result = await deletionV1CleanAccount(doc.id);
                    if (result?.erased) erased++;
                } catch (error) {
                    const blocked = Array.isArray(error.clearance?.rows)
                        ? error.clearance.rows.filter(row => !['clear', 'dust'].includes(row.status))
                            .map(row => row.key + ':' + row.status).join(',') : 'unavailable';
                    console.warn('[DELETE] Account cleanup deferred:', doc.id,
                        error.code || error.statusCode || 'UNAVAILABLE', 'clearance=' + blocked);
                    try {
                        await db.runTransaction(async transaction => {
                            const current = await transaction.get(doc.ref);
                            if (current.exists && current.data().Status === 'Pending_Deletion' &&
                                current.data().Delete_At === doc.data().Delete_At) {
                                transaction.update(doc.ref, {
                                    DeletionCleanupCode: String(error.code || 'CLEANUP_UNAVAILABLE').slice(0, 100),
                                    DeletionCleanupReasons: blocked.split(',').slice(0, 10),
                                    DeletionCleanupAttemptedAt: FieldValue.serverTimestamp()
                                });
                            }
                        });
                    } catch (auditError) {
                        console.warn('[DELETE] Clearance diagnostic write deferred:', doc.id);
                    }
                }
            }
            cursor = snapshot.docs[snapshot.docs.length - 1];
            deletionV1CleanerCursor = cursor;
            if (snapshot.size < 25) { deletionV1CleanerCursor = null; break; }
        }
        if (erased) console.log('[DELETE] Personal profiles erased:', erased, '; financial records retained.');
    } catch (error) {
        console.warn('[DELETE] Scheduled cleanup deferred:',
            String(error.code || 'UNAVAILABLE').replace(/[^a-zA-Z0-9_/-]/g, '').slice(0, 100),
            '; no unsafe deletion fallback.');
    } finally {
        deletionV1CleanerRunning = false;
    }
}

cron.schedule('*/5 * * * *', deletionV1RunCleaner);
setTimeout(() => { void deletionV1RunCleaner(); }, 1500).unref();
// ============================================================================
// 👑 MODULE 12.5: ADMIN SUPERVISOR ENGINE (DIVIDEND SPLITTER & TREASURY)
// ============================================================================

// MEMO TCM-ADM-014-S4-A | 2026-10-10 03:34 IST | Asia/Kolkata
// Depends on the integrated TCM-ADM-014-S2-B helpers.
const admS4Fields = [
    'Withdrawal_Fee_Wallet', 'P2P_Fee_Wallet', 'Withdrawal_Pending_Fees',
    'Dividend_Pool_Wallet', 'Total_Revenue', 'Total_Breakage_Profit'
];

function admS4Hash(value) {
    return require('crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function admS4Decimal(value) {
    return (value / 1000000n).toString() + '.' +
        (value % 1000000n).toString().padStart(6, '0');
}

function admS4Treasury(data) {
    const micro = {}, balances = {};
    for (const field of admS4Fields) {
        micro[field] = admS2Balance(data, field);
        balances[field] = admS2Money(micro[field]);
    }
    const available = micro.Withdrawal_Fee_Wallet - micro.Withdrawal_Pending_Fees;
    if (available < 0n) {
        throw admS2Error('Pending withdrawal reserve exceeds withdrawal fees.', 409);
    }
    return { micro, balances, available };
}

function admS4Roster(data) {
    const rows = data.Dividend_Shareholders;
    if (!Array.isArray(rows) || rows.length !== 10) {
        throw admS2Error('Configure exactly ten Dividend_Shareholders on the server.');
    }

    const seen = new Set();
    const roster = rows.map(row => {
        const uid = admS2Uid(row?.uid);
        const pctMicro = admS2Micro(row.pct, 'shareholder percentage', false);
        if (seen.has(uid) || pctMicro > 100000000n) {
            throw admS2Error('Shareholder UIDs must be unique and percentages valid.');
        }
        seen.add(uid);
        return { uid, pctMicro };
    }).sort((a, b) => a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0);

    if (roster.reduce((sum, row) => sum + row.pctMicro, 0n) !== 100000000n) {
        throw admS2Error('Shareholder percentages must total exactly 100%.');
    }

    const version = admS4Hash(
        roster.map(row => [row.uid, row.pctMicro.toString()])
    );
    return { roster, version };
}

function admS4Split(amount, roster) {
    const rows = roster.map(row => {
        const product = amount * row.pctMicro;
        return {
            ...row,
            amountMicro: product / 100000000n,
            remainder: product % 100000000n
        };
    });

    let remainder = amount - rows.reduce((sum, row) => sum + row.amountMicro, 0n);
    const priority = [...rows].sort((a, b) =>
        a.remainder > b.remainder ? -1 : a.remainder < b.remainder ? 1 :
        a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0
    );

    for (const row of priority) {
        if (remainder === 0n) break;
        row.amountMicro += 1n;
        remainder -= 1n;
    }

    if (remainder !== 0n ||
        rows.reduce((sum, row) => sum + row.amountMicro, 0n) !== amount) {
        throw admS2Error('Dividend conservation failed.', 409);
    }

    return rows.map(row => ({
        uid: row.uid,
        pct: admS4Decimal(row.pctMicro),
        amountMicro: row.amountMicro.toString(),
        amount: admS2Money(row.amountMicro)
    }));
}

function admS4RequestId(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(value)) {
        throw admS2Error('A valid requestId is required.');
    }
    return value;
}

function admS4PoolMicro(value) {
    if (typeof value !== 'string' || !/^[1-9]\d{0,15}$/.test(value) ||
        BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw admS2Error('A positive, canonical expectedPoolMicro string is required.');
    }
    return BigInt(value);
}

function admS4Replay(snap, uid, fingerprint) {
    if (!snap.exists) return null;
    const receipt = snap.data();
    if (receipt.Actor_UID !== uid ||
        receipt.Fingerprint !== fingerprint || !receipt.Result) {
        throw admS2Error('requestId already belongs to a different operation.', 409);
    }
    return { ...receipt.Result, replayed: true };
}

async function admS4ClearCaches(rows) {
    await Promise.allSettled(rows.map(async row => clearUserCache(row.uid)));
}

async function admS4Failure(res, error, operationRef, uid) {
    let operationCreated = operationRef ? null : false;
    if (operationRef) {
        try {
            const receipt = await operationRef.get();
            operationCreated = receipt.exists && receipt.data().Actor_UID === uid;
            if (operationCreated &&
                Array.isArray(receipt.data().Result?.allocations)) {
                await admS4ClearCaches(receipt.data().Result.allocations);
            }
        } catch (lookupError) {
            operationCreated = null;
        }
    }
    return res.status(error.httpStatus || 503).json({
        success: false,
        message: error.httpStatus ? error.message :
            'Outcome could not be confirmed. Retry the same requestId.',
        operationCreated
    });
}

app.get('/api/admin/treasury-status', async (req, res) => {
    try {
        const uid = req.authenticatedUid;
        if (!uid) throw admS2Error('Authentication required.', 401);

        const actor = req.authenticatedUserDoc;
        if (!actor || !actor.exists || actor.id !== uid || actor.data().Role !== 'Admin' ||
            actor.data().Status === 'Banned') {
            throw admS2Error('Active administrator privileges required.', 403);
        }

        const snap = await db.collection('Admin_Data').doc('TCM_TREASURY').get();
        if (!snap.exists) throw admS2Error('Treasury document not found.', 409);

        const data = snap.data(), treasury = admS4Treasury(data);
        let shareholders = [], rosterVersion = null, configurationError = null;

        try {
            const config = admS4Roster(data);
            rosterVersion = config.version;
            shareholders = admS4Split(
                treasury.micro.Dividend_Pool_Wallet, config.roster
            );
        } catch (error) {
            if (error.httpStatus !== 400) throw error;
            configurationError = error.message;
        }

        res.set('Cache-Control', 'no-store');
        return res.json({
            success: true,
            treasury: treasury.balances,
            treasuryMicro: Object.fromEntries(
                Object.entries(treasury.micro)
                    .map(([key, value]) => [key, value.toString()])
            ),
            availableWithdrawalFeeMicro: treasury.available.toString(),
            shareholders,
            rosterVersion,
            configurationError,
            distributionReady:
                !configurationError && treasury.micro.Dividend_Pool_Wallet > 0n
        });
    } catch (error) {
        return admS4Failure(res, error, null, req.authenticatedUid);
    }
});

app.post('/api/admin/treasury-transfer', async (req, res) => {
    let operationRef;
    const uid = req.authenticatedUid;

    try {
        if (!uid) throw admS2Error('Authentication required.', 401);

        const requestId = admS4RequestId(req.body?.requestId);
        const sourceWallet = req.body.sourceWallet;
        if (![
            'Withdrawal_Fee_Wallet', 'P2P_Fee_Wallet', 'Total_Breakage_Profit'
        ].includes(sourceWallet)) {
            throw admS2Error('Invalid source wallet.');
        }

        const amount = admS2Micro(req.body.amount, 'transfer amount', false);
        operationRef = db.collection('AdminOperations')
            .doc('TREASURY-' + requestId);
        const fingerprint = admS4Hash([
            'transfer', sourceWallet, amount.toString()
        ]);

        const result = await db.runTransaction(async t => {
            const actor = await admS2ReadAdmin(t, uid);
            const receipt = await t.get(operationRef);
            const replay = admS4Replay(receipt, uid, fingerprint);
            if (replay) return replay;

            const treasuryRef = db.collection('Admin_Data').doc('TCM_TREASURY');
            const snap = await t.get(treasuryRef);
            if (!snap.exists) throw admS2Error('Treasury document not found.', 409);

            const treasury = admS4Treasury(snap.data());
            const available = sourceWallet === 'Withdrawal_Fee_Wallet'
                ? treasury.available : treasury.micro[sourceWallet];
            if (amount > available) {
                throw admS2Error(
                    'Insufficient spendable funds; pending fees are reserved.', 409
                );
            }

            const nextSource = admS2Money(treasury.micro[sourceWallet] - amount);
            const nextPool = admS2Money(
                treasury.micro.Dividend_Pool_Wallet + amount
            );
            const amountMoney = admS2Money(amount);
            const result = {
                success: true,
                requestId,
                replayed: false,
                message: 'Funds transferred to the dividend pool.',
                amountMicro: amount.toString()
            };

            t.update(treasuryRef, moneyV7Updates(snap.data(), {
                [sourceWallet]: nextSource,
                Dividend_Pool_Wallet: nextPool
            }, 'Treasury', 'update'));

            t.create(
                db.collection('Transactions').doc('TX-TREASURY-' + requestId),
                {
                    UID: 'TCM_TREASURY',
                    Type: 'Internal Treasury Transfer',
                    Amount: amountMoney,
                    Amount_micro: amount.toString(),
                    Status: 'Success',
                    Source_Wallet: sourceWallet,
                    Destination_Wallet: 'Dividend_Pool_Wallet',
                    Order_ID: 'TRF-' + requestId,
                    Request_ID: requestId,
                    Date: new Date().toISOString(),
                    timestamp: FieldValue.serverTimestamp()
                }
            );

            t.create(
                db.collection('AdminLogs').doc('TREASURY-' + requestId),
                admS2Audit(actor, uid, {
                    Action_Type: 'Treasury Transfer',
                    Source_Wallet: sourceWallet,
                    Amount: amountMoney,
                    Amount_micro: amount.toString(),
                    Request_ID: requestId
                })
            );

            t.create(operationRef, {
                Actor_UID: uid,
                Fingerprint: fingerprint,
                Kind: 'Treasury Transfer',
                Result: result,
                timestamp: FieldValue.serverTimestamp()
            });
            return result;
        });

        return res.json(result);
    } catch (error) {
        return admS4Failure(res, error, operationRef, uid);
    }
});

app.post('/api/admin/distribute-dividend', async (req, res) => {
    let operationRef;
    const uid = req.authenticatedUid;

    try {
        if (!uid) throw admS2Error('Authentication required.', 401);

        const requestId = admS4RequestId(req.body?.requestId);
        const expectedPool = admS4PoolMicro(req.body.expectedPoolMicro);
        const expectedVersion = req.body.rosterVersion;
        if (typeof expectedVersion !== 'string' ||
            !/^[a-f0-9]{64}$/.test(expectedVersion)) {
            throw admS2Error('A valid rosterVersion is required.');
        }

        operationRef = db.collection('AdminOperations')
            .doc('DIVIDEND-' + requestId);
        const fingerprint = admS4Hash([
            'dividend', expectedPool.toString(), expectedVersion
        ]);

        const result = await db.runTransaction(async t => {
            incomeDayStates.delete(t);
            const actor = await admS2ReadAdmin(t, uid);
            const receipt = await t.get(operationRef);
            const replay = admS4Replay(receipt, uid, fingerprint);
            if (replay) return replay;

            const treasuryRef = db.collection('Admin_Data').doc('TCM_TREASURY');
            const snap = await t.get(treasuryRef);
            if (!snap.exists) throw admS2Error('Treasury document not found.', 409);

            const treasury = admS4Treasury(snap.data());
            const config = admS4Roster(snap.data());
            if (treasury.micro.Dividend_Pool_Wallet !== expectedPool ||
                config.version !== expectedVersion) {
                throw admS2Error(
                    'Pool or shareholder configuration changed. Refresh the preview.',
                    409
                );
            }

            const allocations = admS4Split(expectedPool, config.roster);
            const updates = [];

            for (const row of allocations) {
                const userRef = db.collection('Users').doc(row.uid);
                const walletRef = db.collection('Wallets').doc(row.uid);
                const user = await t.get(userRef);
                const wallet = await t.get(walletRef);

                if (!user.exists || !wallet.exists) {
                    throw admS2Error(
                        'Missing shareholder account or wallet: ' + row.uid, 409
                    );
                }

                if (user.data().Account_Deleted === true ||
                    ['Pending_Deletion', 'Banned'].includes(user.data().Status)) {
                    throw admS2Error('Shareholder account cannot receive funds: ' + row.uid, 409);
                }
                const walletData = wallet.data();
                const credit = BigInt(row.amountMicro);
                const income = buildISTDailyIncomeUpdates(t, walletRef, walletData, {
                    Daily_Dividend: row.amount,
                    Daily_Comp: row.amount
                });
                updates.push({
                    row,
                    userRef,
                    walletRef,
                    count: nextStakingTxCount(user.data()),
                    income,
                    nextDividend: admS2Money(admS2Balance(walletData, 'Total_Dividend') + credit),
                    nextComp: admS2Money(admS2Balance(walletData, 'Total_Comp') + credit),
                    auditWallet: walletData,
                    nextMain: admS2Money(admS2Balance(walletData, 'Main_Balance') + credit)
                });
            }

            const result = {
                success: true,
                requestId,
                replayed: false,
                message: 'Dividend distribution committed.',
                totalMicro: expectedPool.toString(),
                rosterVersion: config.version,
                allocations
            };

            t.update(treasuryRef, moneyV7Updates(snap.data(), { Dividend_Pool_Wallet: 0 }, 'Treasury', 'update'));

            updates.forEach((item, index) => {
                t.update(item.walletRef, moneyV7Updates(item.auditWallet, {
                    ...item.income,
                    ...t8MainEntry(t, item.row.uid, item.auditWallet, item.nextMain, 'Company dividend', requestId),
                    Main_Balance: item.nextMain,
                    Total_Dividend: item.nextDividend,
                    Total_Comp: item.nextComp
                }, 'Wallet', 'update'));
                t.update(item.userRef, { 'counters.txCount': item.count });

                t.create(
                    db.collection('Transactions')
                        .doc('TX-DIV-' + requestId + '-' + index),
                    t9Record(t, {
                        UID: item.row.uid,
                        Type: 'Company Profit Share',
                        Amount: item.row.amount,
                        Amount_micro: item.row.amountMicro,
                        Share_Percentage: item.row.pct,
                        Status: 'Success',
                        Order_ID: 'DIV-' + requestId + '-' + index,
                        Request_ID: requestId,
                        Date: new Date().toISOString(),
                        Admin_Remarks: 'Dividend Distributed by Admin',
                        timestamp: FieldValue.serverTimestamp()
                    })
                );
            });

            t.create(
                db.collection('AdminLogs').doc('DIVIDEND-' + requestId),
                admS2Audit(actor, uid, {
                    Action_Type: 'Dividend Distribution',
                    Amount: admS2Money(expectedPool),
                    Amount_micro: expectedPool.toString(),
                    Request_ID: requestId,
                    Roster_Version: config.version,
                    Allocations: allocations,
                    Pool_Before_micro: expectedPool.toString(),
                    Pool_After_micro: '0'
                })
            );

            t.create(operationRef, {
                Actor_UID: uid,
                Fingerprint: fingerprint,
                Kind: 'Dividend Distribution',
                Result: result,
                timestamp: FieldValue.serverTimestamp()
            });
            return result;
        });

        await admS4ClearCaches(result.allocations);
        return res.json(result);
    } catch (error) {
        return admS4Failure(res, error, operationRef, uid);
    }
});
// ============================================================================
// ⚠️ MODULE 13: GLOBAL 404 HANDLER (Fixes Network Errors)
// ============================================================================

// ============================================================================
// ⚙️ MODULE 11: SERVER LISTENER
// ============================================================================
const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});

