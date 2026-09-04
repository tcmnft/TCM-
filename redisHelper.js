// backend/utils/redisHelper.js
const { createClient } = require('redis');

// Redis Connection Setup
const redisClient = createClient({ 
    url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    socket: {
        reconnectStrategy: (retries) => {
            // যদি ৩ বারের বেশি কানেক্ট করতে না পারে, তবে আর চেষ্টা করবে না (Silent Fallback)
            if (retries > 3) {
                console.log('[REDIS] ⚠️ Redis Server not found. Running in Fallback (Direct Firebase) mode.');
                return new Error('Redis connection aborted');
            }
            return Math.min(retries * 50, 500); // Retry delay
        }
    }
});

let isRedisConnected = false;

redisClient.on('error', (err) => {
    // শুধুমাত্র কানেক্টেড অবস্থায় এরর আসলে দেখাবে, বারবার ECONNREFUSED দেখাবে না
    if (isRedisConnected) console.error('[REDIS] Client Error:', err.message);
});

redisClient.on('connect', () => {
    isRedisConnected = true;
    console.log('[REDIS] ✅ Connected Successfully');
});

// Start connection silently
redisClient.connect().catch(() => {
    isRedisConnected = false;
});

const DEFAULT_TTL = 300; // 5 Minutes SWR Base Time

// Get Cache
async function getCache(key) {
    if (!isRedisConnected) return null; // Fallback to DB directly
    try {
        const data = await redisClient.get(key);
        return data ? JSON.parse(data) : null;
    } catch (e) {
        return null; 
    }
}

// Set Cache
async function setCache(key, data, ttl = DEFAULT_TTL) {
    if (!isRedisConnected) return; 
    try {
        await redisClient.setEx(key, ttl, JSON.stringify(data));
    } catch (e) {
        // Silent fail
    }
}

// Clear Cache (Instant Invalidation)
async function clearUserCache(uid) {
    if (!isRedisConnected) return;
    try {
        let cursor = '0';
        let totalDeleted = 0;

        do {
            const reply = await redisClient.scan(cursor, {
                MATCH: `*_${uid}*`,
                COUNT: 100 
            });
            
            cursor = reply.cursor;
            const keys = reply.keys;

            if (keys.length > 0) {
                const pipeline = redisClient.multi();
                keys.forEach(key => pipeline.del(key));
                await pipeline.exec();
                totalDeleted += keys.length;
            }
        } while (cursor !== '0');

        console.log(`[REDIS] Cache Invalidated Securely for User: ${uid}`);
    } catch (e) {
        console.error(`[REDIS] Clear Error for User ${uid}:`, e);
    }
}

module.exports = { redisClient, getCache, setCache, clearUserCache };