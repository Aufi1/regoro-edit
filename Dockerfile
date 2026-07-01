FROM oven/bun:1.3
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --production

COPY src ./src

# Die zu bearbeitende Website wird als Volume nach /site gemountet.
# Die Auth-Datei einmalig im gemounteten Ordner erzeugen, damit das Secret
# NICHT ins Image gebacken wird:
#   docker run -v $(pwd)/meine-site:/site <image> bun src/cli.ts init /site --password-stdin
# Danach normal starten (CMD).
ENV PORT=8788
EXPOSE 8788
CMD ["bun", "src/cli.ts", "/site"]
