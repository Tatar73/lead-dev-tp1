
FROM node:20-alpine AS build
WORKDIR /app

# Install production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy app sources
COPY . .

FROM node:20-alpine AS runtime
WORKDIR /app

# Copy built app and dependencies from build stage
COPY --from=build /app /app

# Create non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

ENV NODE_ENV=production
EXPOSE 3000

# Start the server
CMD ["node", "app/server.js"]
