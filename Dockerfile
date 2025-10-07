
FROM node:20-alpine
WORKDIR /app

# Install production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy app sources
COPY . /app

# Start the server
CMD ["node", "app/server.js"]
