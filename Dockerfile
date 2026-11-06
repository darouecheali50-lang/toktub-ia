FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /app/data && chown -R node:node /app/data
# Le serveur démarre en root uniquement pour attribuer le disque persistant (/app/data)
# à l'utilisateur « node », puis abandonne immédiatement les droits root (voir server.js).
ENV NODE_ENV=production PORT=3000 DROP_TO_USER=node
EXPOSE 3000
CMD ["node", "server.js"]
