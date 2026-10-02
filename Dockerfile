FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs auth.mjs pcm-call.mjs wa.mjs ./
COPY public ./public
ENV HOST=0.0.0.0 CALLBACK_HOST=0.0.0.0 PORT=8787
EXPOSE 8787 1455
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8787/api/config').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.mjs"]
