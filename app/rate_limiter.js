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

console.log('🔧 Rate Limiter Configuration:', {
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
  console.error('❌ Redis Client Error:', err.message);
  console.error('Full error:', err);
});
redisClient.on('connect', () => {
  console.log('✅ Connected to Redis');
  console.log('Redis connection details:', {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT
  });
});
redisClient.on('ready', () => console.log('✅ Redis client ready'));
redisClient.on('reconnecting', () => console.log('🔄 Redis reconnecting...'));
redisClient.on('end', () => console.log('🔌 Redis connection ended'));

// Connexion à Redis
let isRedisConnected = false;
console.log('🔄 Attempting to connect to Redis...');
redisClient.connect().then(() => {
  isRedisConnected = true;
  console.log('✅ Redis connection established successfully');
}).catch(err => {
  console.error('❌ Failed to connect to Redis:', err.message);
  console.error('Full error:', err);
  console.warn('⚠️  Rate limiter will run in fallback mode (no rate limiting)');
});

function getClientIP(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  const remoteAddress = req.socket.remoteAddress;
  const ip = forwardedFor || remoteAddress || null;
  
  console.log('🔍 Getting client IP:', {
    'x-forwarded-for': forwardedFor,
    'socket.remoteAddress': remoteAddress,
    'resolved IP': ip
  });
  
  return ip;
}

async function getBucketFromRedis(ip) {
  if (!isRedisConnected) {
    console.warn('⚠️  Redis not connected, returning null bucket for IP:', ip);
    return null;
  }
  
  try {
    console.log(`📥 Getting bucket from Redis for IP: ${ip}`);
    const bucketData = await redisClient.get(`rate_limit:${ip}`);
    
    if (bucketData) {
      const parsedBucket = JSON.parse(bucketData);
      console.log(`✅ Bucket found for IP ${ip}:`, parsedBucket);
      return parsedBucket;
    } else {
      console.log(`ℹ️  No bucket found for IP ${ip} (new IP)`);
      return null;
    }
  } catch (error) {
    console.error(`❌ Error getting bucket from Redis for IP ${ip}:`, error.message);
    console.error('Full error:', error);
    return null;
  }
}

async function saveBucketToRedis(ip, bucket) {
  if (!isRedisConnected) {
    console.warn('⚠️  Redis not connected, cannot save bucket for IP:', ip);
    return;
  }
  
  try {
    console.log(`💾 Saving bucket to Redis for IP ${ip}:`, bucket);
    // Expire après 1 heure d'inactivité
    await redisClient.setEx(
      `rate_limit:${ip}`,
      3600,
      JSON.stringify(bucket)
    );
    console.log(`✅ Bucket saved successfully for IP ${ip}`);
  } catch (error) {
    console.error(`❌ Error saving bucket to Redis for IP ${ip}:`, error.message);
    console.error('Full error:', error);
  }
}

async function calculateAvailableTokens(ip) {
  const now = Date.now();
  
  const bucket = await getBucketFromRedis(ip);
  
  if (!bucket) {
    console.log(`🆕 Creating new bucket for IP ${ip} with ${MAX_TOKENS} tokens`);
    return {
      lastRefill: now,
      tokens: MAX_TOKENS
    };
  }

  const timeDiff = (now - bucket.lastRefill) / 1000;
  const tokensToAdd = timeDiff * TOKENS_PER_SECOND;
  const availableTokens = Math.min(bucket.tokens + tokensToAdd, MAX_TOKENS);
  
  console.log(`⏱️  Token calculation for IP ${ip}:`, {
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
  console.log('🚦 Rate limiter middleware triggered');
  console.log('Request details:', {
    method: req.method,
    path: req.path,
    url: req.url
  });
  
  const ip = getClientIP(req);
  
  if (!ip) {
    console.warn('⚠️  RateLimiter: Unable to determine client IP, allowing request');
    return next();
  }

  // Si Redis n'est pas connecté, on laisse passer (fallback gracieux)
  if (!isRedisConnected) {
    console.warn(`⚠️  RateLimiter: Redis not connected, allowing request from IP ${ip} (fallback mode)`);
    return next();
  }

  console.log(`🔍 Checking rate limit for IP: ${ip}`);
  const now = Date.now();
  const { tokens } = await calculateAvailableTokens(ip);
  
  console.log(`💰 Token check for IP ${ip}: Available=${tokens.toFixed(2)}, Required=${TOKEN_COST}`);
  
  if (tokens >= TOKEN_COST) {
    const remainingTokens = tokens - TOKEN_COST;
    
    // Sauvegarder le bucket dans Redis avec le timestamp actuel
    await saveBucketToRedis(ip, {
      lastRefill: now,
      tokens: remainingTokens
    });
    
    console.log(`✅ Request ALLOWED for IP ${ip} - Remaining tokens: ${remainingTokens.toFixed(2)}`);
    return next();
  } else {
    // Mettre à jour le bucket avec l'état actuel même en cas de refus
    await saveBucketToRedis(ip, {
      lastRefill: now,
      tokens: tokens
    });
    
    const tokensNeeded = TOKEN_COST - tokens;
    const waitTimeSeconds = Math.ceil(tokensNeeded / TOKENS_PER_SECOND);
    
    console.log(`❌ Request DENIED for IP ${ip}:`, {
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
    console.log('🔌 Closing Redis connection...');
    await redisClient.quit();
    isRedisConnected = false;
    console.log('✅ Redis connection closed successfully');
  } else {
    console.log('ℹ️  Redis connection already closed');
  }
}


module.exports = {
  rateLimiter,
  getClientIP,
  getBucketStats,
  closeRedisConnection,
  redisClient
};
