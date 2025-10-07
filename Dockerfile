
FROM node:alpine
COPY . /app
WORKDIR /app
CMD ls && node server.js