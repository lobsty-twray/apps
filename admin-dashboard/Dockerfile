FROM node:20-alpine
RUN apk add --no-cache git && git config --global --add safe.directory /host-apps
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
