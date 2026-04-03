FROM node:20-bullseye-slim

# Install latest chromium package and its dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    ca-certificates \
    fonts-liberation \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Skip Puppeteer's built-in chromium download, we use the system one installed above
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Install Node dependencies
RUN npm install

# Copy app source code
COPY . .

# Start the application
CMD [ "npm", "start" ]
