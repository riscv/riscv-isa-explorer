# Stage 1: Build the React Application
FROM node:24-alpine as build

WORKDIR /app

# Copy package files first to leverage Docker cache for dependencies
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Build the app (produces a /dist or /build folder)
RUN npm run build

# Stage 2: Serve with Nginx
FROM nginx:alpine

# Copy the build output from Stage 1 to Nginx's html directory
# Note: If you use CRA, change '/app/dist' to '/app/build'
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
