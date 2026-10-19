FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
VOLUME /data
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
