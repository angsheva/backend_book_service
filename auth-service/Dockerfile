FROM node:18-alpine
RUN apk add --no-cache postgresql-client
WORKDIR /app
COPY package*.json ./
# COPY yarn.lock ./
RUN npm install
COPY . .
EXPOSE 3001
CMD ["node", "app.js"]