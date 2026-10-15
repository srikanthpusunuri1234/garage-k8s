FROM node:22-alpine

WORKDIR /usr/src/app

# Install production dependencies as root, then lock down permissions
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# Copy application source and frontend assets
COPY server.js ./
COPY public ./public

# Run as non-root node user (UID 1000) on port 5000
USER 1000:1000
ENV NODE_ENV=production
ENV PORT=5000
EXPOSE 5000

CMD ["node", "server.js"]
