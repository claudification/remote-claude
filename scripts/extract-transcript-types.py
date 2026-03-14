#!/usr/bin/env python3
"""
Extract field signatures from Claude Code JSONL transcript files.
Mines real data to discover entry types, field names, optionality, and value types.
Use this to detect new patterns when upstream changes transcript format.

Usage:
  python3 scripts/extract-transcript-types.py          # last 36 hours
  python3 scripts/extract-transcript-types.py 72       # last 72 hours
  python3 scripts/extract-transcript-types.py all       # all transcripts
"""

import json, os, glob, sys, time, collections

hours = float(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1] != 'all' else 36
use_all = len(sys.argv) > 1 and sys.argv[1] == 'all'

jsonl_files = glob.glob(os.path.expanduser("~/.claude/projects/*/*.jsonl"))
if use_all:
    recent = jsonl_files
else:
    cutoff = time.time() - hours * 3600
    recent = [f for f in jsonl_files if os.path.getmtime(f) > cutoff]

print(f"Scanning {len(recent)} transcript files ({'all' if use_all else f'last {hours}h'})\n")

type_fields = {}
type_counts = collections.Counter()

for fpath in recent:
    with open(fpath) as f:
        for line in f:
            try:
                e = json.loads(line)
            except:
                continue
            t = e.get('type', '?')
            type_counts[t] += 1
            if t not in type_fields:
                type_fields[t] = {}
            for k, v in e.items():
                if k not in type_fields[t]:
                    type_fields[t][k] = {'types': set(), 'count': 0, 'sample': None}
                type_fields[t][k]['count'] += 1
                type_fields[t][k]['types'].add(type(v).__name__)
                if type_fields[t][k]['sample'] is None and v is not None:
                    sample = v
                    if isinstance(v, str) and len(v) > 80:
                        sample = v[:80] + '...'
                    elif isinstance(v, (dict, list)):
                        s = json.dumps(v)
                        sample = s[:80] + '...' if len(s) > 80 else s
                    type_fields[t][k]['sample'] = sample

# Common fields
common_keys = set()
for k in ['type', 'timestamp', 'uuid', 'parentUuid', 'isSidechain', 'userType', 'cwd', 'sessionId', 'version', 'gitBranch', 'slug']:
    appearances = sum(1 for t in type_fields if k in type_fields[t])
    if appearances >= len(type_fields) * 0.5:
        common_keys.add(k)

print("=== COMMON FIELDS (>50% of types) ===")
for k in sorted(common_keys):
    all_types_for_field = set()
    for t in type_fields:
        if k in type_fields[t]:
            all_types_for_field.update(type_fields[t][k]['types'])
    print(f"  {k}: {sorted(all_types_for_field)}")

print(f"\n=== TYPE-SPECIFIC FIELDS ===\n")
for t, count in type_counts.most_common():
    specific = {k: v for k, v in type_fields[t].items() if k not in common_keys}
    if not specific:
        print(f"{t} ({count}x): (no type-specific fields)")
        continue
    print(f"{t} ({count}x):")
    for k in sorted(specific):
        info = specific[k]
        pct = info['count'] / count * 100
        ts = sorted(info['types'])
        sample = repr(info['sample'])[:60] if info['sample'] is not None else ''
        opt = '' if pct > 95 else f' ({pct:.0f}%)'
        print(f"  {k}{opt}: {ts}  {sample}")
    print()

# Sub-analysis: assistant.message and usage keys
print("=== ASSISTANT MESSAGE KEYS ===")
msg_keys = collections.Counter()
usage_keys = collections.Counter()
for fpath in recent:
    with open(fpath) as f:
        for line in f:
            try:
                e = json.loads(line)
            except:
                continue
            if e.get('type') == 'assistant' and isinstance(e.get('message'), dict):
                for k in e['message']:
                    msg_keys[k] += 1
                u = e['message'].get('usage')
                if isinstance(u, dict):
                    for k in u:
                        usage_keys[k] += 1
for k, c in msg_keys.most_common():
    print(f"  {k}: {c}")
print("\n=== ASSISTANT USAGE KEYS ===")
for k, c in usage_keys.most_common():
    print(f"  {k}: {c}")

# Queue operation values
ops = collections.Counter()
for fpath in recent:
    with open(fpath) as f:
        for line in f:
            try:
                e = json.loads(line)
            except:
                continue
            if e.get('type') == 'queue-operation':
                ops[e.get('operation', '?')] += 1
if ops:
    print("\n=== QUEUE-OPERATION VALUES ===")
    for k, c in ops.most_common():
        print(f"  {k}: {c}")
