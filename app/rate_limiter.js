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

console.log('[Rate Limiter] Configuration:', {
  tokensPerSecond: TOKENS_PER_SECOND,
  maxTokens: MAX_TOKENS,
  tokenCost: TOKEN_COST,
  redisHost: process.env.REDIS_HOST,
  redisPort: process.env.REDIS_PORT,
  redisUsername: process.env.REDIS_USERNAME ? '***' : 'undefined',
  redisPassword: process.env.REDIS_PASSWORD ? '***' : 'undefined'
});

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
redisClient.on('error', (err) => {
  console.error('[Redis] Client Error:', err.message);
  console.error('[Redis] Full error:', err);
});
redisClient.on('connect', () => {
  console.log('[Redis] Connected to Redis');
  console.log('[Redis] Connection details:', {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT
  });
});
redisClient.on('ready', () => console.log('[Redis] Client ready'));
redisClient.on('reconnecting', () => console.log('[Redis] Reconnecting...'));
redisClient.on('end', () => console.log('[Redis] Connection ended'));

// Connexion à Redis
let isRedisConnected = false;
console.log('[Redis] Attempting to connect...');
redisClient.connect().then(() => {
  isRedisConnected = true;
  console.log('[Redis] Connection established successfully');
}).catch(err => {
  console.error('[Redis] Failed to connect:', err.message);
  console.error('[Redis] Full error:', err);
  console.warn('[Rate Limiter] WARNING: Will run in fallback mode (no rate limiting)');
});

function getClientIP(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  const remoteAddress = req.socket.remoteAddress;
  const ip = forwardedFor || remoteAddress || null;
  
  console.log('[Rate Limiter] Getting client IP:', {
    'x-forwarded-for': forwardedFor,
    'socket.remoteAddress': remoteAddress,
    'resolved IP': ip
  });
  
  return ip;
}

async function getBucketFromRedis(ip) {
  if (!isRedisConnected) {
    console.warn(`[Rate Limiter] WARNING: Redis not connected, returning null bucket for IP: ${ip}`);
    return null;
  }
  
  try {
    console.log(`[Redis] Getting bucket for IP: ${ip}`);
    const bucketData = await redisClient.get(`rate_limit:${ip}`);
    
    if (bucketData) {
      const parsedBucket = JSON.parse(bucketData);
      console.log(`[Redis] Bucket found for IP ${ip}:`, parsedBucket);
      return parsedBucket;
    } else {
      console.log(`[Redis] No bucket found for IP ${ip} (new IP)`);
      return null;
    }
  } catch (error) {
    console.error(`[Redis] ERROR: Failed to get bucket for IP ${ip}:`, error.message);
    console.error('[Redis] Full error:', error);
    return null;
  }
}

async function saveBucketToRedis(ip, bucket) {
  if (!isRedisConnected) {
    console.warn(`[Rate Limiter] WARNING: Redis not connected, cannot save bucket for IP: ${ip}`);
    return;
  }
  
  try {
    console.log(`[Redis] Saving bucket for IP ${ip}:`, bucket);
    // Expire après 1 heure d'inactivité
    await redisClient.setEx(
      `rate_limit:${ip}`,
      3600,
      JSON.stringify(bucket)
    );
    console.log(`[Redis] Bucket saved successfully for IP ${ip}`);
  } catch (error) {
    console.error(`[Redis] ERROR: Failed to save bucket for IP ${ip}:`, error.message);
    console.error('[Redis] Full error:', error);
  }
}

async function calculateAvailableTokens(ip) {
  const now = Date.now();
  
  const bucket = await getBucketFromRedis(ip);
  
  if (!bucket) {
    console.log(`[Rate Limiter] Creating new bucket for IP ${ip} with ${MAX_TOKENS} tokens`);
    return {
      lastRefill: now,
      tokens: MAX_TOKENS
    };
  }

  const timeDiff = (now - bucket.lastRefill) / 1000;
  const tokensToAdd = timeDiff * TOKENS_PER_SECOND;
  const availableTokens = Math.min(bucket.tokens + tokensToAdd, MAX_TOKENS);
  
  console.log(`[Rate Limiter] Token calculation for IP ${ip}:`, {
    timeSinceLastRefill: `${timeDiff.toFixed(2)}s`,
    tokensToAdd: tokensToAdd.toFixed(2),
    previousTokens: bucket.tokens.toFixed(2),
    availableTokens: availableTokens.toFixed(2),
    maxTokens: MAX_TOKENS
  });
  
  return {
    lastRefill: bucket.lastRefill,
    tokens: availableTokens
  };
}

async function rateLimiter(req, res, next) {
  console.log('[Rate Limiter] Middleware triggered');
  console.log('[Rate Limiter] Request details:', {
    method: req.method,
    path: req.path,
    url: req.url
  });
  
  const ip = getClientIP(req);
  
  if (!ip) {
    console.warn('[Rate Limiter] WARNING: Unable to determine client IP, allowing request');
    return next();
  }

  // Si Redis n'est pas connecté, on laisse passer (fallback gracieux)
  if (!isRedisConnected) {
    console.warn(`[Rate Limiter] WARNING: Redis not connected, allowing request from IP ${ip} (fallback mode)`);
    return next();
  }

  console.log(`[Rate Limiter] Checking rate limit for IP: ${ip}`);
  const now = Date.now();
  const { tokens } = await calculateAvailableTokens(ip);
  
  console.log(`[Rate Limiter] Token check for IP ${ip}: Available=${tokens.toFixed(2)}, Required=${TOKEN_COST}`);
  
  if (tokens >= TOKEN_COST) {
    const remainingTokens = tokens - TOKEN_COST;
    
    // Sauvegarder le bucket dans Redis avec le timestamp actuel
    await saveBucketToRedis(ip, {
      lastRefill: now,
      tokens: remainingTokens
    });
    
    console.log(`[Rate Limiter] Request ALLOWED for IP ${ip} - Remaining tokens: ${remainingTokens.toFixed(2)}`);
    return next();
  } else {
    // Mettre à jour le bucket avec l'état actuel même en cas de refus
    await saveBucketToRedis(ip, {
      lastRefill: now,
      tokens: tokens
    });
    
    const tokensNeeded = TOKEN_COST - tokens;
    const waitTimeSeconds = Math.ceil(tokensNeeded / TOKENS_PER_SECOND);
    
    console.log(`[Rate Limiter] Request DENIED for IP ${ip}:`, {
      available: tokens.toFixed(2),
      required: TOKEN_COST,
      needed: tokensNeeded.toFixed(2),
      waitTime: `${waitTimeSeconds}s`
    });
    
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
    console.log('[Redis] Closing connection...');
    await redisClient.quit();
    isRedisConnected = false;
    console.log('[Redis] Connection closed successfully');
  } else {
    console.log('[Redis] Connection already closed');
  }
}


module.exports = {
  rateLimiter,
  getClientIP,
  getBucketStats,
  closeRedisConnection,
  redisClient
};
