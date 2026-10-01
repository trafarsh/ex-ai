# ex-ai

A terminal chat that texts like a specific friend, built from your real Snapchat history and run on free OpenRouter models. No dependencies beyond Python 3.9+.

> Only build this for someone who's said they're okay with it. Their messages stay on your machine: `data/`, `.env` and `*.zip` are gitignored, so keep them that way.

## 1. Export your Snapchat chats

1. Snapchat → Profile → ⚙️ Settings → **Privacy Controls → My Data** (or accounts.snapchat.com → My Data).
2. Select **Chat History** and turn on **Export JSON files**.
3. Choose "All time", submit, and wait for the email (usually under a day). Download the ZIP.

Snapchat only exports messages that are still on its servers, mainly ones saved in chat. Opened disappearing messages are gone. If the export is thin, you can type or OCR screenshots into a text file with one `Name: message` per line (see step 2).

## 2. Turn the export into a chat log

```bash
python parse_snapchat.py ~/Downloads/mydata.zip                    # lists usernames in the export
python parse_snapchat.py ~/Downloads/mydata.zip --friend her_username
# or, from a manual transcript:
python parse_snapchat.py chat.txt --txt --her Pragya
```

This writes `data/chat.jsonl`. Several hundred of her messages or more gives a much better impression.

## 3. Chat

```bash
cp .env.example .env        # paste your free key from https://openrouter.ai/keys
python chat.py --name Pragya
```

- Auto-picks a free OpenRouter model and falls back to the next one when a model is rate limited. Pin one with `--model <id>:free` or `OPENROUTER_MODEL`.
- `--dry-run` prints the full prompt without calling the API, which is useful for checking what the model sees.
- In-chat commands: `/reset`, `/model`, `/save` (to `data/sessions/`), `/quit`.

## How it imitates her

- **Style profile:** typical message length, how many bubbles she sends in a row, lowercase and punctuation habits, top emojis, and words she uses far more than you do.
- **Recent context:** the last 40 real turns go in as actual conversation history, so the model continues the thread in her voice.
- **Memory:** for each thing you say, a small TF-IDF search pulls up related real exchanges, so she reacts to topics the way she actually has before.
- **Multi-bubble replies:** each line of the reply prints as a separate message with a short typing delay.

It's still an imitation. It will get facts wrong and make things up, and free models vary a lot in quality. Try a few with `--model` to find the one that sounds most like her.
