# Multi-stage build for rocksdb-secondary-checkpoint.
#
# librocksdb-sys 0.17.3 statically links librocksdb 10.4.2 + snappy + zlib +
# lz4 + zstd + bz2. The Rust binary still dynamic-links libc, libm,
# libpthread, libdl, libgcc_s, and libstdc++ (the C++ runtime that
# librocksdb's C++ core depends on).
#
# Why distroless/cc-debian12 for runtime:
#   It provides exactly those shared libs and nothing else (~22 MB vs the
#   ~85 MB of debian:trixie-slim). No shell, no apt, no package manager —
#   matches our "smallest feasible image" objective without going to
#   musl-static (which has known RocksDB-on-musl edge cases around atomic
#   intrinsics and we don't want to debug those).
#
# Why bookworm in the build stage:
#   glibc symbol versions matter — a binary built on trixie (glibc 2.41)
#   may require symbols that bookworm-based distroless (glibc 2.36) lacks
#   at runtime. Building on bookworm produces a binary that runs on
#   distroless/cc-debian12.

# ── build stage ────────────────────────────────────────────────────────
# rust:1.95-bookworm is the current stable Rust toolchain (released
# 2026-05-09) on Debian 12 (glibc 2.36). librocksdb-sys 0.17.3+10.4.2
# requires Rust ≥ 1.85; 1.95 satisfies that.
FROM rust:1.95-bookworm AS build

# librocksdb-sys compile-time deps. snappy/zlib/lz4/zstd/bz2 are linked in
# statically by the librocksdb-sys build script; we install the -dev headers.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      clang \
      libclang-dev \
      cmake \
      g++ \
      make \
      pkg-config \
      libsnappy-dev \
      liblz4-dev \
      libzstd-dev \
      libbz2-dev \
      zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY Cargo.toml Cargo.lock* ./
COPY src ./src

# Cargo's "fetch deps first" cache trick — separate fetch from compile.
RUN cargo fetch
RUN cargo build --release \
 && strip target/release/rocksdb-secondary-checkpoint

# ── runtime stage ──────────────────────────────────────────────────────
# distroless/cc-debian12 ≈ 22 MB and ships libc, libstdc++, libgcc_s,
# libm, libpthread, libdl — exactly what librocksdb-sys needs and
# nothing else. No shell, no package manager, no shell-injection
# surface; the binary is the only entrypoint.
FROM gcr.io/distroless/cc-debian12 AS runtime

COPY --from=build /build/target/release/rocksdb-secondary-checkpoint \
                  /usr/local/bin/rocksdb-secondary-checkpoint

ENTRYPOINT ["/usr/local/bin/rocksdb-secondary-checkpoint"]
