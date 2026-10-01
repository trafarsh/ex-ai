#!/usr/bin/env python3
"""Terminal chat that texts like her, built from your real chat history.

Usage:
    python chat.py                      # uses data/chat.jsonl and OPENROUTER_API_KEY
    python chat.py --name Pragya --model meta-llama/llama-3.3-70b-instruct:free
    python chat.py --dry-run            # print the prompt instead of calling the API

In-chat commands: /reset  /model  /save  /quit
"""
import argparse
import json
import math
import os
import random
import re
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime

API = "https://openrouter.ai/api/v1"
# Free models change often; these are preferred when available, else any ":free" model is used.
PREFERRED = ["llama-3.3-70b", "deepseek-chat", "deepseek-v3", "qwen3", "gemma-3-27b", "mistral-small"]
SESSION_GAP_HOURS = 6
EMOJI_RE = re.compile("[\U0001F000-\U0001FAFF☀-➿]")
WORD_RE = re.compile(r"[a-z']+")
STOPWORDS = set("""a an the and or but if to of in on at for with is are was were be been am i you he she it
we they me my your our this that what so do did does not no yes just like have has had can will would
there here then than too very really get got go going its im youre dont its u ur""".split())


# ---------- data ----------

def load_env(path=".env"):
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                if v.strip():
                    os.environ.setdefault(k.strip(), v.strip())


def load_turns(path):
    """Group consecutive messages from the same sender into turns (lists of bubbles)."""
    if not os.path.exists(path):
        sys.exit(f"{path} not found. Run parse_snapchat.py first.")
    turns, last_ts = [], None
    with open(path, encoding="utf-8") as f:
        for line in f:
            m = json.loads(line)
            ts = parse_ts(m.get("ts"))
            new_session = bool(ts and last_ts and (ts - last_ts).total_seconds() > SESSION_GAP_HOURS * 3600)
            if turns and turns[-1]["sender"] == m["sender"] and not new_session:
                turns[-1]["bubbles"].append(m["text"])
            else:
                turns.append({"sender": m["sender"], "bubbles": [m["text"]], "new_session": new_session})
            last_ts = ts or last_ts
    return turns


def parse_ts(s):
    try:
        return datetime.fromisoformat(s) if s else None
    except ValueError:
        return None


def tokens(text):
    return [w for w in WORD_RE.findall(text.lower()) if w not in STOPWORDS and len(w) > 1]


# ---------- persona ----------

def style_profile(turns):
    her = [b for t in turns if t["sender"] == "her" for b in t["bubbles"]]
    if not her:
        sys.exit("No messages from her in the chat log.")
    lengths = sorted(len(b.split()) for b in her)
    her_turns = [t for t in turns if t["sender"] == "her"]
    emojis = Counter(e for b in her for e in EMOJI_RE.findall(b))
    words = Counter(w for b in her for w in WORD_RE.findall(b.lower()))
    mine = Counter(w for t in turns if t["sender"] == "me" for b in t["bubbles"] for w in WORD_RE.findall(b.lower()))
    # Words she uses a lot more than you do: her slang / verbal tics.
    tics = [w for w, c in words.most_common(400)
            if c >= 3 and c / (mine.get(w, 0) + 1) >= 2 and w not in STOPWORDS][:25]
    lower = sum(1 for b in her if b[:1].islower()) / len(her)
    ends_punct = sum(1 for b in her if b[-1:] in ".!?") / len(her)
    return {
        "messages": len(her),
        "median_words": lengths[len(lengths) // 2],
        "bubbles_per_turn": round(sum(len(t["bubbles"]) for t in her_turns) / len(her_turns), 1),
        "lowercase_pct": round(lower * 100),
        "ends_with_punct_pct": round(ends_punct * 100),
        "top_emojis": "".join(e for e, _ in emojis.most_common(10)) or "(rarely uses emojis)",
        "signature_words": ", ".join(tics) or "(none stand out)",
    }


def exchange_pairs(turns):
    """(my turn, her reply) pairs, used for retrieving relevant real examples."""
    pairs = []
    for a, b in zip(turns, turns[1:]):
        if a["sender"] == "me" and b["sender"] == "her":
            pairs.append(("\n".join(a["bubbles"]), "\n".join(b["bubbles"])))
    return pairs


class Retriever:
    """Tiny TF-IDF search over past exchanges, so she 'remembers' related things."""

    def __init__(self, pairs):
        self.pairs = pairs
        self.docs = [Counter(tokens(q + " " + a)) for q, a in pairs]
        df = Counter(w for d in self.docs for w in d)
        n = len(self.docs) or 1
        self.idf = {w: math.log(n / c) for w, c in df.items()}

    def search(self, query, k):
        q = set(tokens(query))
        if not q:
            return []
        scored = []
        for i, d in enumerate(self.docs):
            s = sum(self.idf.get(w, 0) for w in q if w in d)
            if s > 0:
                scored.append((s, i))
        scored.sort(reverse=True)
        return [self.pairs[i] for _, i in scored[:k]]


def system_prompt(name, profile, samples):
    sample_text = "\n".join(f"- {s}" for s in samples)
    return f"""You are {name}, texting a close friend on Snapchat. You are not an assistant. Reply exactly the way {name} texts, based on her real messages.

How {name} texts (measured from {profile['messages']} real messages):
- Typical message length: about {profile['median_words']} words. Keep it short like her.
- She sends about {profile['bubbles_per_turn']} separate messages in a row per reply.
- Starts messages in lowercase {profile['lowercase_pct']}% of the time; ends with punctuation {profile['ends_with_punct_pct']}% of the time.
- Emojis she uses most: {profile['top_emojis']}
- Words/slang she uses a lot: {profile['signature_words']}

Random real messages from her, for tone:
{sample_text}

Rules:
- Match her spelling, slang, casing, emoji use and energy. Never sound like an AI or write formally.
- Put each separate text bubble on its own line. Usually 1-3 lines.
- Only bring up facts that appear in the chat history. If you don't know something about her life, be vague or deflect the way she would instead of inventing details.
- Don't narrate actions or add quotes, labels, or your name."""


# ---------- OpenRouter ----------

def http_json(url, key, body=None, timeout=60):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body else None, headers={
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "X-Title": "ex-ai terminal chat",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def free_models(key):
    try:
        data = http_json(f"{API}/models", key)["data"]
    except Exception as e:
        sys.exit(f"Couldn't list OpenRouter models ({e}). Pass one with --model.")
    free = [m for m in data if m["id"].endswith(":free")]

    def rank(m):
        pref = next((i for i, p in enumerate(PREFERRED) if p in m["id"]), len(PREFERRED))
        return (pref, -(m.get("context_length") or 0))
    return [m["id"] for m in sorted(free, key=rank)]


def complete(key, models, messages):
    """Try models in order, moving on when one is rate limited or unavailable."""
    last_err = None
    for model in list(models):
        try:
            resp = http_json(f"{API}/chat/completions", key, {
                "model": model, "messages": messages, "temperature": 0.9, "max_tokens": 200,
            })
            if "choices" in resp and resp["choices"]:
                text = resp["choices"][0]["message"].get("content") or ""
                if text.strip():
                    # Remember what worked so later turns try it first.
                    models.remove(model)
                    models.insert(0, model)
                    return model, text
            last_err = resp.get("error", resp)
        except urllib.error.HTTPError as e:
            last_err = f"{e.code} {e.read().decode(errors='ignore')[:200]}"
            if e.code == 401:
                sys.exit("OpenRouter rejected the API key (401). Check OPENROUTER_API_KEY.")
        except Exception as e:
            last_err = e
    raise RuntimeError(f"All models failed. Last error: {last_err}")


def clean_reply(text, name):
    lines = []
    for line in text.strip().splitlines():
        line = re.sub(rf"^\s*{re.escape(name)}\s*:\s*", "", line, flags=re.I).strip()
        if line.startswith('"') and line.count('"') == 2:
            line = line.replace('"', "")
        if line:
            lines.append(line)
    return lines[:6]


# ---------- chat loop ----------

def build_messages(sys_prompt, history_turns, retriever, live, user_text, k):
    msgs = [{"role": "system", "content": sys_prompt}]
    related = retriever.search(user_text, k)
    if related:
        ex = "\n\n".join(f"Friend: {q}\nYou: {a}" for q, a in related)
        msgs[0]["content"] += f"\n\nReal past exchanges related to what your friend just said:\n{ex}"
    for t in history_turns:
        msgs.append({"role": "assistant" if t["sender"] == "her" else "user", "content": "\n".join(t["bubbles"])})
    msgs.extend(live)
    msgs.append({"role": "user", "content": user_text})
    return msgs


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--chat", default="data/chat.jsonl")
    ap.add_argument("--name", default="Pragya")
    ap.add_argument("--model", help="OpenRouter model id (default: auto-pick a free one)")
    ap.add_argument("--history", type=int, default=40, help="Recent real turns to include as context")
    ap.add_argument("--examples", type=int, default=6, help="Related past exchanges to retrieve per message")
    ap.add_argument("--dry-run", action="store_true", help="Print the prompt for a sample message and exit")
    args = ap.parse_args()
    load_env()

    turns = load_turns(args.chat)
    profile = style_profile(turns)
    her_msgs = sorted({b for t in turns if t["sender"] == "her" for b in t["bubbles"] if len(b) > 3})
    samples = random.Random(0).sample(her_msgs, min(25, len(her_msgs)))
    sys_prompt = system_prompt(args.name, profile, samples)
    retriever = Retriever(exchange_pairs(turns))
    recent = turns[-args.history:] if args.history else []
    # Chat APIs want the first non-system message to be from the user.
    while recent and recent[0]["sender"] == "her":
        recent = recent[1:]

    if args.dry_run:
        for m in build_messages(sys_prompt, recent, retriever, [], "hey what's up", args.examples):
            print(f"--- {m['role']} ---\n{m['content']}\n")
        return

    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        sys.exit("Set OPENROUTER_API_KEY (in .env or your shell). Free key: https://openrouter.ai/keys")
    model_env = args.model or os.environ.get("OPENROUTER_MODEL")
    models = [model_env] if model_env else free_models(key)
    if not models:
        sys.exit("No free models found on OpenRouter right now. Pass one with --model.")

    live = []
    print(f"\n💬 {args.name} (AI simulation from your chat history, not actually her)")
    print(f"   model: {models[0]}   commands: /reset /model /save /quit\n")
    while True:
        try:
            user = input("you: ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not user:
            continue
        if user == "/quit":
            break
        if user == "/reset":
            live = []
            print("(conversation reset)\n")
            continue
        if user == "/model":
            print(f"(using {models[0]}; fallbacks: {', '.join(models[1:4]) or 'none'})\n")
            continue
        if user == "/save":
            os.makedirs("data/sessions", exist_ok=True)
            path = f"data/sessions/{datetime.now():%Y%m%d-%H%M%S}.json"
            with open(path, "w", encoding="utf-8") as f:
                json.dump(live, f, ensure_ascii=False, indent=2)
            print(f"(saved to {path})\n")
            continue

        messages = build_messages(sys_prompt, recent, retriever, live, user, args.examples)
        try:
            _, reply = complete(key, models, messages)
        except RuntimeError as e:
            print(f"(error: {e})\n")
            continue
        bubbles = clean_reply(reply, args.name) or ["..."]
        for b in bubbles:
            time.sleep(min(0.4 + len(b) * 0.03, 2.0))
            print(f"{args.name.lower()}: {b}")
        print()
        live += [{"role": "user", "content": user}, {"role": "assistant", "content": "\n".join(bubbles)}]


if __name__ == "__main__":
    main()
