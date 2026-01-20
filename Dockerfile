FROM node:20-alpine

# Create app directory
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy app source
COPY . .

# Expose your app port
EXPOSE 3927

# Start the server
CMD ["node", "server.js"]
