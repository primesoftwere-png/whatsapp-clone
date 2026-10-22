const Redis = require('ioredis');

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
let isRedisConnected = false;
let redisClient = null;

// In-memory fallback storage when Redis is unavailable
const fallbackStore = new Map();
const fallbackSetStore = new Map();

try {
  redisClient = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    connectTimeout: 3000,
    retryStrategy(times) {
      if (times > 3) {
        // Stop reconnecting aggressively to avoid flooding logs
        return null;
      }
      return Math.min(times * 1000, 3000);
    },
    lazyConnect: false
  });

  redisClient.on('connect', () => {
    console.log('[Redis] Connecting to Redis server...');
  });

  redisClient.on('ready', () => {
    isRedisConnected = true;
    console.log('[Redis] Connected and ready');
  });

  redisClient.on('error', (err) => {
    isRedisConnected = false;
    // Log once or quietly without crashing application
    console.warn(`[Redis] Connection warning: ${err.message}. Falling back to in-memory store.`);
  });

  redisClient.on('close', () => {
    isRedisConnected = false;
  });
} catch (err) {
  console.warn(`[Redis] Initialization warning: ${err.message}. Falling back to in-memory store.`);
  isRedisConnected = false;
}

// Resilient wrapper helpers
const redisService = {
  isAvailable: () => isRedisConnected && redisClient && redisClient.status === 'ready',

  async get(key) {
    if (this.isAvailable()) {
      try {
        return await redisClient.get(key);
      } catch (e) {
        return fallbackStore.get(key) || null;
      }
    }
    return fallbackStore.get(key) || null;
  },

  async set(key, value, expireInSeconds) {
    if (this.isAvailable()) {
      try {
        if (expireInSeconds) {
          return await redisClient.set(key, value, 'EX', expireInSeconds);
        }
        return await redisClient.set(key, value);
      } catch (e) {
        fallbackStore.set(key, value);
        return 'OK';
      }
    }
    fallbackStore.set(key, value);
    return 'OK';
  },

  async del(key) {
    if (this.isAvailable()) {
      try {
        return await redisClient.del(key);
      } catch (e) {
        fallbackStore.delete(key);
        return 1;
      }
    }
    fallbackStore.delete(key);
    return 1;
  },

  async sadd(key, ...members) {
    if (this.isAvailable()) {
      try {
        return await redisClient.sadd(key, ...members);
      } catch (e) {
        if (!fallbackSetStore.has(key)) fallbackSetStore.set(key, new Set());
        const set = fallbackSetStore.get(key);
        members.forEach((m) => set.add(m));
        return members.length;
      }
    }
    if (!fallbackSetStore.has(key)) fallbackSetStore.set(key, new Set());
    const set = fallbackSetStore.get(key);
    members.forEach((m) => set.add(m));
    return members.length;
  },

  async srem(key, ...members) {
    if (this.isAvailable()) {
      try {
        return await redisClient.srem(key, ...members);
      } catch (e) {
        if (fallbackSetStore.has(key)) {
          const set = fallbackSetStore.get(key);
          members.forEach((m) => set.delete(m));
        }
        return members.length;
      }
    }
    if (fallbackSetStore.has(key)) {
      const set = fallbackSetStore.get(key);
      members.forEach((m) => set.delete(m));
    }
    return members.length;
  },

  async smembers(key) {
    if (this.isAvailable()) {
      try {
        return await redisClient.smembers(key);
      } catch (e) {
        if (fallbackSetStore.has(key)) {
          return Array.from(fallbackSetStore.get(key));
        }
        return [];
      }
    }
    if (fallbackSetStore.has(key)) {
      return Array.from(fallbackSetStore.get(key));
    }
    return [];
  },

  getClient: () => redisClient
};

module.exports = redisService;
