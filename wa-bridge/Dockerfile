FROM rust:1.96-bookworm AS build
# cmake builds libopus (group calls use standard Opus).
RUN apt-get update && apt-get install -y --no-install-recommends cmake && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY vendor ./vendor
RUN --mount=type=cache,id=wa-voice-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=wa-voice-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=wa-voice-target,target=/cache/target \
    CARGO_TARGET_DIR=/cache/target cargo build --release --locked && \
    mkdir -p /out && cp /cache/target/release/wa-voice-bridge /out/

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* && \
    useradd --system --create-home --uid 10001 wa && mkdir -p /data && chown wa /data
COPY --from=build /out/wa-voice-bridge /usr/local/bin/wa-voice-bridge
USER wa
VOLUME /data
EXPOSE 3340
HEALTHCHECK --interval=30s --timeout=3s CMD curl -fs http://127.0.0.1:3340/health || exit 1
ENTRYPOINT ["/usr/local/bin/wa-voice-bridge"]
