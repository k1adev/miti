# Dockerfile
FROM node:20

WORKDIR /app

# Instala dependências do backend
COPY package*.json ./
RUN npm install

# Copia e faz build do frontend
COPY client ./client
WORKDIR /app/client
RUN npm install && npm run build

# Volta para a raiz e copia apenas o backend e arquivos necessários, sem sobrescrever o build
WORKDIR /app
COPY . .
# Remove o client copiado acima, mas mantém o build
RUN rm -rf client/node_modules client/public client/src

ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "server/index.js"] 