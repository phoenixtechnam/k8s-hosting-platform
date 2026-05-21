#!/usr/bin/env python3
"""
bench-shim: measure shim throughput + latency across backend types.

Runs from inside a benchmark Pod (same namespace as the shim) using
boto3. For each backend (S3 / SFTP-via-POSIX / CIFS-via-POSIX / NFS-
via-POSIX), captures:

  - PUT throughput: 100 KiB, 10 MiB, 1 GiB payloads (single-stream)
  - GET throughput: same payloads
  - LIST latency: 100 objects, 1000 objects
  - Concurrent PUT: 1, 4, 16 parallel uploaders × 10 MiB each
  - Aggregate throughput: total bytes / wall time

The shim's RSS is sampled separately by the harness driver via
kubectl top + /proc/<pid>/status. This script only does the I/O.

Output: one CSV line per measurement on stdout, plus a summary
markdown table to /tmp/bench-results-<backend>.md.
"""
import os, sys, time, hashlib, threading, queue, json
import boto3, botocore

ENDPOINT = os.environ['SHIM_ENDPOINT']      # http://backup-rclone-shim.platform.svc:9000
ACCESS   = os.environ['SHIM_ACCESS_KEY']
SECRET   = os.environ['SHIM_SECRET_KEY']
BUCKET   = os.environ.get('BENCH_BUCKET', 'system')
PREFIX   = os.environ.get('BENCH_PREFIX', f'bench-{int(time.time())}')
BACKEND  = os.environ.get('BACKEND_LABEL', 'unknown')

SIZES = {
    'small_100KiB':   100 * 1024,
    'medium_10MiB':   10 * 1024 * 1024,
    'large_1GiB':     1024 * 1024 * 1024,
}
CONCURRENCIES = [1, 4, 16]

def client():
    cfg = botocore.config.Config(
        retries={'max_attempts': 3, 'mode': 'adaptive'},
        s3={'addressing_style': 'path'},
        max_pool_connections=64,
    )
    return boto3.client('s3', endpoint_url=ENDPOINT,
                         aws_access_key_id=ACCESS,
                         aws_secret_access_key=SECRET,
                         region_name='us-east-1', config=cfg)

def emit(row):
    print(json.dumps(row), flush=True)

def make_payload(size, seed=b'x'):
    # Deterministic, low-overhead payload. Use a sha256-extended
    # pattern so the byte stream isn't all-zeros (some S3 backends
    # special-case sparse uploads).
    if size <= 1024 * 1024:
        h = hashlib.sha256(seed).digest()
        n = (size // len(h)) + 1
        return (h * n)[:size]
    # Larger: stream via generator to avoid 1 GiB allocations
    return None

def put_once(c, key, size, payload):
    t0 = time.monotonic()
    if payload is not None:
        c.put_object(Bucket=BUCKET, Key=key, Body=payload)
    else:
        # Streaming upload for large payloads
        from io import BytesIO
        h = hashlib.sha256(b'x').digest()
        n = (1024*1024 // len(h)) + 1
        block = (h * n)[:1024*1024]   # 1 MiB block
        nblocks = size // (1024*1024)
        # boto3 single PutObject would buffer it all; use multipart instead
        mp = c.create_multipart_upload(Bucket=BUCKET, Key=key)
        try:
            parts = []
            part_size = 16 * 1024 * 1024   # 16 MiB parts
            buf = bytearray()
            part_num = 1
            for _ in range(nblocks):
                buf += block
                if len(buf) >= part_size:
                    r = c.upload_part(Bucket=BUCKET, Key=key,
                                      UploadId=mp['UploadId'], PartNumber=part_num,
                                      Body=bytes(buf))
                    parts.append({'ETag': r['ETag'], 'PartNumber': part_num})
                    part_num += 1
                    buf = bytearray()
            if buf:
                r = c.upload_part(Bucket=BUCKET, Key=key,
                                  UploadId=mp['UploadId'], PartNumber=part_num,
                                  Body=bytes(buf))
                parts.append({'ETag': r['ETag'], 'PartNumber': part_num})
            c.complete_multipart_upload(Bucket=BUCKET, Key=key,
                                         UploadId=mp['UploadId'],
                                         MultipartUpload={'Parts': parts})
        except Exception:
            c.abort_multipart_upload(Bucket=BUCKET, Key=key, UploadId=mp['UploadId'])
            raise
    return time.monotonic() - t0

def get_once(c, key):
    t0 = time.monotonic()
    r = c.get_object(Bucket=BUCKET, Key=key)
    total = 0
    for chunk in r['Body'].iter_chunks(chunk_size=1024*1024):
        total += len(chunk)
    return time.monotonic() - t0, total

def list_latency(c, n_objs):
    # Pre-create N small placeholder keys, then time a single LIST
    prefix = f'{PREFIX}/list-{n_objs}'
    # Bulk-create — use small parallel pool for setup speed
    setup_payload = b'x'
    setup_q = queue.Queue()
    for i in range(n_objs):
        setup_q.put(f'{prefix}/obj-{i:06d}.bin')
    setup_done = threading.Event()
    def worker():
        cc = client()
        while True:
            try:
                k = setup_q.get_nowait()
            except queue.Empty:
                return
            cc.put_object(Bucket=BUCKET, Key=k, Body=setup_payload)
            setup_q.task_done()
    setup_t0 = time.monotonic()
    workers = [threading.Thread(target=worker, daemon=True) for _ in range(16)]
    for w in workers: w.start()
    for w in workers: w.join()
    setup_wall = time.monotonic() - setup_t0
    # Now time the LIST
    t0 = time.monotonic()
    keys = 0
    token = None
    while True:
        kwargs = {'Bucket': BUCKET, 'Prefix': f'{prefix}/', 'MaxKeys': 1000}
        if token: kwargs['ContinuationToken'] = token
        r = c.list_objects_v2(**kwargs)
        keys += len(r.get('Contents', []))
        if not r.get('IsTruncated'): break
        token = r.get('NextContinuationToken')
    list_wall = time.monotonic() - t0
    # Cleanup
    cleanup_q = queue.Queue()
    for i in range(n_objs):
        cleanup_q.put(f'{prefix}/obj-{i:06d}.bin')
    def cleanup_worker():
        cc = client()
        while True:
            try:
                k = cleanup_q.get_nowait()
            except queue.Empty:
                return
            try:
                cc.delete_object(Bucket=BUCKET, Key=k)
            except Exception:
                pass
            cleanup_q.task_done()
    workers = [threading.Thread(target=cleanup_worker, daemon=True) for _ in range(16)]
    for w in workers: w.start()
    for w in workers: w.join()
    return list_wall, setup_wall, keys

def run_concurrent_put(c_factory, size, conc):
    payload = make_payload(size)
    if payload is None:
        # Skip large payload for concurrent — would dominate test time
        return None
    keys = [f'{PREFIX}/conc-{conc}-{size}-{i}.bin' for i in range(conc)]
    durations = [None] * conc
    def worker(i):
        cc = c_factory()
        d = put_once(cc, keys[i], size, payload)
        durations[i] = d
    t0 = time.monotonic()
    threads = [threading.Thread(target=worker, args=(i,)) for i in range(conc)]
    for t in threads: t.start()
    for t in threads: t.join()
    wall = time.monotonic() - t0
    # Cleanup
    cc = c_factory()
    for k in keys:
        try: cc.delete_object(Bucket=BUCKET, Key=k)
        except Exception: pass
    total_bytes = size * conc
    return wall, total_bytes, durations

def main():
    print(f'# bench-shim — backend={BACKEND} endpoint={ENDPOINT}', flush=True)
    c = client()
    # Smoke check: bucket exists / can be created
    try:
        c.head_bucket(Bucket=BUCKET)
    except Exception:
        try: c.create_bucket(Bucket=BUCKET)
        except Exception: pass

    # ─── Single-stream PUT/GET for each size ──────────────────────────
    for size_name, size in SIZES.items():
        payload = make_payload(size)
        key = f'{PREFIX}/{size_name}.bin'
        put_t = put_once(c, key, size, payload)
        get_t, get_size = get_once(c, key)
        c.delete_object(Bucket=BUCKET, Key=key)
        put_mbps = (size / put_t) / (1024*1024)
        get_mbps = (get_size / get_t) / (1024*1024)
        emit({
            'backend': BACKEND, 'op': 'put', 'size': size_name,
            'bytes': size, 'wall_s': round(put_t, 3),
            'throughput_MiBps': round(put_mbps, 2),
        })
        emit({
            'backend': BACKEND, 'op': 'get', 'size': size_name,
            'bytes': size, 'wall_s': round(get_t, 3),
            'throughput_MiBps': round(get_mbps, 2),
        })

    # ─── LIST latency ────────────────────────────────────────────────
    for n in (100, 1000):
        try:
            lat, setup, keys = list_latency(c, n)
            emit({
                'backend': BACKEND, 'op': 'list', 'count': n,
                'setup_s': round(setup, 3), 'list_s': round(lat, 3),
                'keys_returned': keys,
            })
        except Exception as e:
            emit({'backend': BACKEND, 'op': 'list', 'count': n, 'error': str(e)})

    # ─── Concurrent PUT (medium size, scaling conc) ──────────────────
    for conc in CONCURRENCIES:
        r = run_concurrent_put(client, SIZES['medium_10MiB'], conc)
        if r is None: continue
        wall, total_bytes, durations = r
        agg_mbps = (total_bytes / wall) / (1024*1024)
        emit({
            'backend': BACKEND, 'op': 'concurrent_put',
            'concurrency': conc, 'per_op_bytes': SIZES['medium_10MiB'],
            'total_bytes': total_bytes, 'wall_s': round(wall, 3),
            'aggregate_throughput_MiBps': round(agg_mbps, 2),
            'per_op_wall_s_max': round(max(durations), 3),
            'per_op_wall_s_min': round(min(durations), 3),
        })

    print(f'# bench-shim done', flush=True)

if __name__ == '__main__':
    main()
