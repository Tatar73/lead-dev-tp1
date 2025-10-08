/**
 * Token Bucket Rate Limiter
 * Algorithme du token bucket pour limiter les requêtes par IP
 * Utilise Redis pour stocker les buckets de tokens (compatible avec scalabilité horizontale)
 */

const { createClient } = require('redis');
require('dotenv').config();

// Configuration
const TOKENS_PER_SECOND = 1;
const MAX_TOKENS = 10;
const TOKEN_COST = 10;

// Configuration Redis
const redisClient = createClient({
  username: process.env.REDIS_USERNAME,
  password: process.env.REDIS_PASSWORD,
  socket: {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT
  }
});

// Gestion des événements Redis
redisClient.on('error', (err) => console.error('Redis Client Error', err));
redisClient.on('connect', () => console.log('Connected to Redis'));

// Connexion à Redis
let isRedisConnected = false;
redisClient.connect().then(() => {
  isRedisConnected = true;
}).catch(err => {
  console.error('Failed to connect to Redis:', err);
});


function getClientIP(req) {
  return req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
}

async function getBucketFromRedis(ip) {
  if (!isRedisConnected) {
    return null;
  }
  
  try {
    const bucketData = await redisClient.get(`rate_limit:${ip}`);
    return bucketData ? JSON.parse(bucketData) : null;
  } catch (error) {
    console.error('Error getting bucket from Redis:', error);
    return null;
  }
}

async function saveBucketToRedis(ip, bucket) {
  if (!isRedisConnected) {
    return;
  }
  
  try {
    // Expire après 1 heure d'inactivité
    await redisClient.setEx(
      `rate_limit:${ip}`,
      3600,
      JSON.stringify(bucket)
    );
  } catch (error) {
    console.error('Error saving bucket to Redis:', error);
  }
}

async function calculateAvailableTokens(ip) {
  const now = Date.now();
  
  const bucket = await getBucketFromRedis(ip);
  
  if (!bucket) {
    return {
      lastRefill: now,
      tokens: MAX_TOKENS
    };
  }

  const timeDiff = (now - bucket.lastRefill) / 1000;
  const tokensToAdd = timeDiff * TOKENS_PER_SECOND;
  const availableTokens = Math.min(bucket.tokens + tokensToAdd, MAX_TOKENS);
  
  return {
    lastRefill: bucket.lastRefill,
    tokens: availableTokens
  };
}

async function rateLimiter(req, res, next) {
  const ip = getClientIP(req);
  
  if (!ip) {
    console.warn('Unable to determine client IP, allowing request');
    return next();
  }

  // Si Redis n'est pas connecté, on laisse passer (fallback gracieux)
  if (!isRedisConnected) {
    console.warn('Redis not connected, allowing request (fallback mode)');
    return next();
  }

  const now = Date.now();
  const { tokens } = await calculateAvailableTokens(ip);
  
  if (tokens >= TOKEN_COST) {
    const remainingTokens = tokens - TOKEN_COST;
    
    // Sauvegarder le bucket dans Redis avec le timestamp actuel
    await saveBucketToRedis(ip, {
      lastRefill: now,
      tokens: remainingTokens
    });
    
    console.log(`Request allowed for IP ${ip} - Remaining tokens: ${remainingTokens.toFixed(2)}`);
    return next();
  } else {
    // Mettre à jour le bucket avec l'état actuel même en cas de refus
    await saveBucketToRedis(ip, {
      lastRefill: now,
      tokens: tokens
    });
    
    const tokensNeeded = TOKEN_COST - tokens;
    const waitTimeSeconds = Math.ceil(tokensNeeded / TOKENS_PER_SECOND);
    
    console.log(`Request DENIED for IP ${ip} - Available: ${tokens.toFixed(2)}, Required: ${TOKEN_COST}, Wait: ${waitTimeSeconds}s`);
    
    return res.status(429).json({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Please wait ${waitTimeSeconds} second(s) before trying again.`,
      retryAfter: waitTimeSeconds,
      availableTokens: tokens.toFixed(2),
      requiredTokens: TOKEN_COST
    });
  }
}

async function getBucketStats(ip) {
  const { lastRefill, tokens } = await calculateAvailableTokens(ip);
  return {
    ip,
    availableTokens: tokens.toFixed(2),
    maxTokens: MAX_TOKENS,
    tokensPerSecond: TOKENS_PER_SECOND,
    tokenCost: TOKEN_COST,
    lastRefill: new Date(lastRefill).toISOString()
  };
}

/**
 * Ferme proprement la connexion Redis
 */
async function closeRedisConnection() {
  if (isRedisConnected) {
    await redisClient.quit();
    isRedisConnected = false;
    console.log('🔌 Redis connection closed');
  }
}


module.exports = {
  rateLimiter,
  getClientIP,
  getBucketStats,
  closeRedisConnection,
  redisClient
};
