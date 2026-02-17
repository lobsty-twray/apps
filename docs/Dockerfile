FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY . .

RUN addgroup -g 1001 -S nodejs && \
    adduser -S lobsty -u 1001 -G nodejs

RUN chown -R lobsty:nodejs /app

USER lobsty

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/auth/me', (res) => { process.exit(res.statusCode === 401 ? 0 : (res.statusCode === 200 ? 0 : 1)) }).on('error', () => process.exit(1))"

CMD ["npm", "start"]
