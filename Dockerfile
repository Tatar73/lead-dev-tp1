
FROM node:alpine
COPY . /app
WORKDIR /app
CMD ls && node ./app/server.js