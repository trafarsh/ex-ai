#!/usr/bin/env python3
"""Turn a Snapchat "My Data" export into a clean chat log for chat.py.

Usage:
    python parse_snapchat.py mydata.zip                 # lists your friends' usernames
    python parse_snapchat.py mydata.zip --friend pragya_xyz
    python parse_snapchat.py chat.txt --txt --her Pragya   # manual "Name: message" transcript

Writes data/chat.jsonl with one {"ts", "sender", "text"} object per line,
where sender is "her" or "me".
"""
import argparse
import json
import os
import re
import sys
import zipfile
from datetime import datetime, timezone


def load_json_from_export(path):
    """Find and load chat_history.json from a zip, a folder, or the file itself."""
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as zf:
            names = [n for n in zf.namelist() if n.endswith("chat_history.json")]
            if not names:
                sys.exit(no_json_help(zf.namelist()))
            return json.loads(zf.read(names[0]).decode("utf-8"))
    if os.path.isdir(path):
        for root, _, files in os.walk(path):
            if "chat_history.json" in files:
                with open(os.path.join(root, "chat_history.json"), encoding="utf-8") as f:
                    return json.load(f)
        sys.exit(no_json_help([]))
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def no_json_help(names):
    has_html = any("chat_history" in n and n.endswith(".html") for n in names)
    msg = "Couldn't find chat_history.json in the export."
    if has_html:
        msg += ("\nYour export only has HTML. Request it again from Snapchat > My Data"
                " with 'Export JSON files' turned ON.")
    return msg


def parse_time(msg):
    micros = msg.get("Created(microseconds)")
    if isinstance(micros, (int, float)) and micros > 0:
        # Snapchat calls this microseconds but it's usually milliseconds.
        scale = 1e6 if micros > 1e14 else 1e3
        return datetime.fromtimestamp(micros / scale, tz=timezone.utc).isoformat()
    created = msg.get("Created") or ""
    for fmt in ("%Y-%m-%d %H:%M:%S UTC", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(created, fmt).replace(tzinfo=timezone.utc).isoformat()
        except ValueError:
            pass
    return created


def is_text(msg):
    media = (msg.get("Media Type") or "TEXT").upper()
    return media in ("TEXT", "") and bool(text_of(msg))


def text_of(msg):
    return (msg.get("Content") or msg.get("Text") or "").strip()


def extract(data, friend):
    """Return (friends_available, messages) for either known export layout."""
    # Old layout: {"Received Saved Chat History": [...], "Sent Saved Chat History": [...]}
    if "Received Saved Chat History" in data or "Sent Saved Chat History" in data:
        received = data.get("Received Saved Chat History", [])
        sent = data.get("Sent Saved Chat History", [])
        friends = sorted({m.get("From") for m in received} | {m.get("To") for m in sent} - {None})
        if not friend:
            return friends, []
        msgs = [("her", m) for m in received if m.get("From") == friend]
        msgs += [("me", m) for m in sent if m.get("To") == friend]
        return friends, msgs

    # New layout: {"<username or group id>": [ {From, Content, IsSender, ...}, ... ]}
    friends = sorted(k for k, v in data.items() if isinstance(v, list))
    if not friend:
        return friends, []
    convo = data.get(friend)
    if convo is None:
        # Fall back to matching on the sender field across all conversations.
        convo = [m for v in data.values() if isinstance(v, list) for m in v
                 if m.get("From") == friend]
    msgs = [("me" if m.get("IsSender") else "her", m) for m in convo]
    return friends, msgs


def parse_txt(path, her_name):
    """Manual transcript: one 'Name: message' per line. Lines without a name continue the last message."""
    out = []
    pattern = re.compile(r"^\s*([^:]{1,40}):\s?(.*)$")
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            m = pattern.match(line)
            if m:
                sender = "her" if m.group(1).strip().lower() == her_name.lower() else "me"
                if m.group(2).strip():
                    out.append({"ts": "", "sender": sender, "text": m.group(2).strip()})
            elif line.strip() and out:
                out[-1]["text"] += "\n" + line.strip()
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("path", help="Snapchat export (.zip, folder, or chat_history.json), or a .txt with --txt")
    ap.add_argument("--friend", help="Her Snapchat username (run without it to list usernames)")
    ap.add_argument("--txt", action="store_true", help="Input is a 'Name: message' text transcript")
    ap.add_argument("--her", default="Pragya", help="Her name as written in the .txt transcript")
    ap.add_argument("--out", default="data/chat.jsonl")
    args = ap.parse_args()

    if args.txt:
        rows = parse_txt(args.path, args.her)
    else:
        friends, msgs = extract(load_json_from_export(args.path), args.friend)
        if not args.friend:
            print("Conversations in this export (pass one with --friend):")
            for f in friends:
                print("  ", f)
            return
        rows = [{"ts": parse_time(m), "sender": who, "text": text_of(m)}
                for who, m in msgs if is_text(m)]
        rows.sort(key=lambda r: r["ts"])

    if not rows:
        sys.exit("No text messages found. Check the --friend username.")

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    hers = sum(r["sender"] == "her" for r in rows)
    print(f"Wrote {len(rows)} messages ({hers} from her, {len(rows) - hers} from you) to {args.out}")
    if hers < 200:
        print("Heads up: under ~200 of her messages, the impression will be pretty rough.")


if __name__ == "__main__":
    main()
