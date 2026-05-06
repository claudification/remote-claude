# Broker Backup & Restore

## Overview

`broker-cli backup` provides atomic SQLite snapshots of the broker's data volume
using `VACUUM INTO` (WAL-safe, zero writer blocking). Backups are compressed
tar.gz archives with SHA-256 checksums and version metadata.

## Commands

```bash
# Create a backup (inside container)
docker exec broker broker-cli backup create --dest /data/backups

# With tiered retention (default: 24h hourly + 7d daily)
docker exec broker broker-cli backup create --dest /data/backups --retain-hours 24 --retain-days 7

# Include ephemeral blobs (7-day TTL, usually not worth backing up)
docker exec broker broker-cli backup create --dest /data/backups --include-blobs

# List available backups
docker exec broker broker-cli backup list --dest /data/backups

# Restore (broker must be STOPPED first)
docker compose stop broker
docker exec broker broker-cli backup restore /data/backups/backup-20260506-120000.tar.gz
docker compose start broker
```

## What Gets Backed Up

| File | Type | Criticality |
|------|------|-------------|
| `store.db` | SQLite (VACUUM INTO) | HIGH - all conversations, transcripts, settings, shares, cost data |
| `analytics.db` | SQLite (VACUUM INTO) | LOW - tool-use analytics, non-critical |
| `projects.db` | SQLite (VACUUM INTO) | LOW - project URI registry |
| `auth.json` | File copy | CRITICAL - passkeys, users, sessions |
| `auth.secret` | File copy | CRITICAL - HMAC signing key |
| `sentinel-registry.json` | File copy | MEDIUM - sentinel host records |
| `blobs/` | File copy (opt-in) | OPTIONAL - 7-day TTL reaper |

## How It Works

1. **VACUUM INTO** each SQLite database to a temp directory. This creates a
   consistent, defragmented snapshot without blocking concurrent writers. The
   output is a single `.db` file (DELETE journal mode, no WAL/SHM sidecars).
2. **Strip derived artifacts** from the snapshot (currently: the
   `transcript_fts` FTS5 index over `transcript_entries.content` and its
   sync triggers). These are fully rebuildable from base tables, so backing
   them up wastes space. On next broker startup after restore, `createSchema()`
   recreates the FTS table + triggers and detects an empty index against
   non-empty source rows -- it then backfills with a single
   `INSERT INTO transcript_fts(rowid, content) SELECT id, content FROM transcript_entries`.
3. **Copy** flat config files alongside the database snapshots.
4. **Write manifest.json** with SHA-256 checksums, broker git hash, branch,
   build time, and hostname.
5. **tar + gzip** everything into `backup-YYYYMMDD-HHMMSS.tar.gz`.
6. **Prune** old backups per the tiered retention policy.

## Tiered Retention

Retention is controlled by `--retain-hours N` (default 24) and `--retain-days N`
(default 7):

- **Hourly tier**: All backups within the last N hours are kept.
- **Daily tier**: Beyond the hourly window, only the newest backup per calendar
  day is kept, for N days.
- Everything older is deleted.

With hourly backups, the defaults produce:
- Up to 24 hourly backups from the last day
- 1 daily backup for each of the preceding 7 days
- Maximum ~31 archives on disk

## Manifest

Every archive contains `manifest.json`:

```json
{
  "timestamp": "2026-05-06T05:50:21.339Z",
  "hostname": "studio",
  "version": {
    "gitHash": "8248a443ec12ab...",
    "gitHashShort": "8248a44",
    "branch": "main",
    "buildTime": "2026-05-06T05:18:54.281Z",
    "dirty": false
  },
  "files": [
    { "path": "store.db", "size": 121921536, "sha256": "abc123..." },
    ...
  ],
  "durationMs": 12130
}
```

Restore verifies every file's SHA-256 before overwriting.

## Restore Safety

- `broker-cli backup restore` **refuses** if the broker is running (checks
  `broker.pid` and sends signal 0 to verify the process is alive).
- Stop the broker first: `docker compose stop broker`.
- After restore, start the broker: `docker compose start broker`.

## Docker Volume Layout

```yaml
# docker-compose.yml
volumes:
  - concentrator-data:/data/cache        # live data (read-write)
  - ${BACKUP_DIR:-./backups}:/data/backups  # backup archives (bind-mount)
```

The bind-mount means backup archives are directly accessible on the host
filesystem for rsync, rclone, or any off-site replication.

## Automated Hourly Backup (Cron)

`scripts/backup-cron.sh` is a host-side wrapper:

```bash
# Add to crontab (host machine, not inside container)
0 * * * * /path/to/scripts/backup-cron.sh >> /var/log/broker-backup.log 2>&1
```

Override the container name with `BROKER_CONTAINER=my-broker` if needed.

## Sizing

| Database | Typical size | Compressed | Notes |
|----------|-------------|------------|-------|
| store.db | 50-500 MB | ~5-60 MB | Grows with conversation history |
| analytics.db | 50-500 MB | ~5-60 MB | Grows with tool-use tracking |
| projects.db | < 1 MB | < 100 KB | One row per project path |
| Flat files | < 100 KB | Negligible | auth, sentinel config |

Text-heavy SQLite data compresses ~89-96% with gzip. A 576 MB dataset
compresses to ~65 MB.

## Source

- Core logic: `src/broker/backup.ts`
- CLI handler: `src/broker/cli/backup-commands.ts`
- Cron script: `scripts/backup-cron.sh`
