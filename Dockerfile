FROM node:20-alpine
WORKDIR /app
COPY package.json server.js ./
RUN npm install --production
EXPOSE 8080 8081
CMD ["node", "server.js"]
