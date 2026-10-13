# carelink-bridge (Community-Fork NovaLux12, festgenagelt) + Waechter.
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /src
ARG CB_COMMIT=5e514f0
RUN git clone https://github.com/NovaLux12/carelink-bridge.git . && git checkout ${CB_COMMIT}
RUN npm ci && npm run build
# logindata.json/state.json in das Daten-Volume legen (Original: neben dist/)
RUN sed -i "s#path.join(__dirname, '..', 'logindata.json')#(process.env.CARELINK_LOGINDATA || path.join(__dirname, '..', 'logindata.json'))#" dist/login.js dist/doctor.js \
 && sed -i "s#path.join(__dirname, '..', '..', 'logindata.json')#(process.env.CARELINK_LOGINDATA || path.join(__dirname, '..', '..', 'logindata.json'))#" dist/carelink/client.js \
 && test "$(grep -l CARELINK_LOGINDATA dist/login.js dist/doctor.js dist/carelink/client.js | wc -l)" = 3

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /src/package.json /src/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /src/dist ./dist
COPY guard.sh /usr/local/bin/guard.sh
RUN chmod 755 /usr/local/bin/guard.sh && mkdir -p /data && chown node:node /data /app
USER node
ENTRYPOINT ["/usr/local/bin/guard.sh"]
CMD ["run"]
