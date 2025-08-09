# Use official Node.js image
FROM node:20-alpine

# Set working directory
WORKDIR /app


# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Install git
RUN apk add --no-cache git

# Copy all source files
COPY . .


## Provide an optional remote via environment at runtime
# e.g., docker run -e GIT_REMOTE_URL=https://<token>@github.com/<user>/<repo>.git flowsync
ENV GIT_REMOTE_URL=""


# Start the app
CMD ["node", "sync.js"]
