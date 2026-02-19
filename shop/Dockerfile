FROM node:18-alpine

WORKDIR /app

# Create uploads directory
RUN mkdir -p /app/uploads

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy application files
COPY . .

# Create a non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S lobsty -u 1001 -G nodejs

# Change ownership of app directory
RUN chown -R lobsty:nodejs /app

# Switch to non-root user
USER lobsty

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/products', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

# Start the application
CMD ["npm", "start"]
