FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install --production

# Server and analytics page
COPY server.js analytics.html ./

# Static files into public/
COPY index.html public/index.html
COPY favicons/ public/favicons/

# Version pages
COPY v1/ public/v1/
COPY v2/ public/v2/
COPY v3/ public/v3/
COPY v4/ public/v4/
COPY v5/ public/v5/
COPY v6/ public/v6/
COPY v7/ public/v7/
COPY v8/ public/v8/
COPY v9/ public/v9/
COPY v10/ public/v10/
COPY v11/ public/v11/
COPY v12/ public/v12/
COPY v14/ public/v14/

# Copy favicons to version dirs
COPY favicons/ public/v1/favicons/
COPY favicons/ public/v2/favicons/
COPY favicons/ public/v3/favicons/
COPY favicons/ public/v4/favicons/
COPY favicons/ public/v5/favicons/
COPY favicons/ public/v6/favicons/
COPY favicons/ public/v8/favicons/
COPY favicons/ public/v9/favicons/
COPY favicons/ public/v10/favicons/
COPY favicons/ public/v11/favicons/
COPY favicons/ public/v12/favicons/
COPY favicons/ public/v14/favicons/

# buildwithray
COPY buildwithray/ public/buildwithray/

# Data volume for SQLite
VOLUME /data

EXPOSE 80
CMD ["node", "server.js"]
