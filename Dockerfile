# MediKiosk — deterministic Docker build (Railway auto-detects this over Railpack/Nixpacks)
# ffmpeg is REQUIRED: the server converts mic audio (webm) → wav before speech-to-text.
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# install deps first (cached layer — faster rebuilds)
COPY package*.json ./
COPY server/package*.json ./server/
COPY client/package*.json ./client/
RUN npm install

# then the source
COPY . .

# build the React client into client/dist
RUN npm run build

ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "server/index.js"]
