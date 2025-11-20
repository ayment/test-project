# Use official Node.js LTS
FROM node:20-alpine

# Create app directory
WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm install

# Copy app code
COPY . .

# Start the bot
CMD ["npm", "start"]
