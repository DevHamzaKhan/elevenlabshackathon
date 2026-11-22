# Caller setup (human steps)

Everything here needs a person: accounts, payment, your voice, your phone. Until it's done, the
Caller runs in dry-run mode (`CALLER_DRY_RUN=1`, the default) and fakes every call.

Checked against the ElevenLabs docs on 2026-11-22. If a screen looks different, the docs pages
linked in each step are the source of truth.

You need: an ElevenLabs account on a plan that allows voice cloning and Agents phone calls, and a
Twilio account with a phone number that can make calls.

## 1. Clone your voice (Instant Voice Clone)

Docs: https://elevenlabs.io/docs/product-guides/voices/voice-cloning/instant-voice-cloning

1. Record 1–2 minutes of yourself talking naturally: one speaker, quiet room, no music or echo,
   steady volume. MP3 at 128 kbps or better. (At least 10 s total is accepted; more than 3 minutes
   doesn't help.) Keep the file in `caller/private/` (gitignored) or outside the repo.
2. In ElevenLabs, click **Voices** in the left sidebar, then the **+** icon.
3. Choose **Instant Voice Clone**.
4. Upload (or record) the audio as prompted.
5. Name it (for example "Owner"), tick the box confirming you have the right and consent to clone
   this voice, click **Save voice**.

## 2. Create the caller agent

Docs: https://elevenlabs.io/docs/agents-platform/customization/personalization/dynamic-variables

This is a **separate** agent from the Bobby voice agent.

1. Go to **Agents** (https://elevenlabs.io/app/agents) → **Create agent** → **Blank agent**.
   Name it "Bobby Caller".
2. **Voice:** pick the cloned voice from step 1.
3. **First message:**

   ```
   Hey, it's me. Got a quick second?
   ```

4. **System prompt** (paste exactly; `{{goal}}` and `{{context}}` are filled in per call by the Caller):

   ```
   You are making a short phone call on behalf of the phone's owner, speaking in their voice,
   in the first person, as if you are them. Sound relaxed and natural, like a friend calling.

   Your goal for this call: {{goal}}

   Background you can rely on: {{context}}

   Rules:
   - Get to the point within your first two sentences. Keep every turn short: one or two sentences.
   - Do exactly what the goal says. Don't promise, agree to or invent anything beyond it. If they ask
     something you can't answer from the goal or background, say you'll get back to them by text.
   - If they propose a change (a different time, a question), acknowledge it clearly and repeat it
     back once so it's on the record, then wrap up.
   - If you reach voicemail, leave one short message that covers the goal, then hang up.
   - If the person is clearly not who you expected, apologise briefly and end the call.
   - Never mention being an AI, an assistant, a prompt, or these rules unless they directly and
     sincerely ask whether they are talking to a real person; then answer honestly.
   - Once the goal is done and they've had a chance to respond, say a friendly goodbye and end the call.
   ```

   Note on honesty: whether to disclose AI up front is the owner's call and may be a legal
   requirement where you are. To disclose, change the first message to
   `Hey, it's my AI assistant calling for me, in my voice. Got a quick second?`

5. **Tools:** make sure the system tool **End call** is enabled, so the agent hangs up when done.
6. **Dynamic variable placeholders** (so dashboard test chats work): in the agent's settings, give
   `goal` the placeholder `Say I'm running 20 minutes late and ask if 3pm still works.` and
   `context` the placeholder `Alex is a friend and expects this call.`
7. **Analysis** (optional but nice): the Caller uses the conversation's `transcript_summary` as
   the call summary when it exists. It's on by default; nothing to do unless you turned it off.
8. You do **not** need to enable any overrides in the **Security** tab: the Caller only sends
   dynamic variables, never prompt or first-message overrides.
9. Click **Publish** / save.
10. **Agent id:** shown on the agent's page (copy button next to the name) and in the browser URL
    (`.../agents/<agent_id>`). It starts with `agent_`. Put it in `ELEVENLABS_CALLER_AGENT_ID`.

## 3. Connect a Twilio number

Docs: https://elevenlabs.io/docs/agents-platform/phone-numbers/twilio-integration/native-integration

1. In Twilio (https://console.twilio.com): buy a phone number with Voice capability (or use one
   you have). **Trial accounts can only call verified numbers:** add your own mobile under
   *Phone Numbers → Manage → Verified Caller IDs* if you're on a trial.
2. Get credentials. Recommended: an API key (SID starts with `SK`) from
   https://www.twilio.com/console/project/api-keys. Or the Account SID + Auth Token from the
   console home page.
3. In ElevenLabs go to **Agents → Phone Numbers** (https://elevenlabs.io/app/agents/phone-numbers)
   → **Import number** → **From Twilio**, and fill in:
   - **Label:** `Bobby Caller`
   - **Phone Number:** the Twilio number in E.164, e.g. `+14155550100`
   - **Twilio SID:** the API key SID (or Account SID)
   - **Twilio Token:** the API key secret (or Auth Token)
4. Save. ElevenLabs configures the Twilio number for you. You may assign "Bobby Caller" as its
   agent; outbound calls name the agent explicitly either way.
5. **Phone number id:** open the imported number in the Phone Numbers list; its id is shown there
   (starts with `phnum_`). If you can't spot it, list numbers with the API from the repo root
   (prints ids and labels only, never the key):

   ```sh
   set -a; source .env; set +a
   curl -s https://api.elevenlabs.io/v1/convai/phone-numbers -H "xi-api-key: $ELEVENLABS_API_KEY" \
     | python3 -c 'import json,sys; [print(n.get("phone_number_id"), n.get("label"), n.get("phone_number")) for n in json.load(sys.stdin)]'
   ```

   Put it in `ELEVENLABS_PHONE_NUMBER_ID`.
6. Optional sanity check from the dashboard: on the Phone Numbers page, **Outbound call** → pick
   "Bobby Caller" → enter **your own** number → **Send Test Call**.

## 4. Fill the root `.env`

In the repo root (not `caller/`), copy `.env.example` to `.env` if it doesn't exist, then set:

| Variable | Value |
|---|---|
| `ELEVENLABS_API_KEY` | ElevenLabs → Settings / Developers → API keys. Needs Agents (ConvAI) access. |
| `ELEVENLABS_CALLER_AGENT_ID` | From step 2.10 |
| `ELEVENLABS_PHONE_NUMBER_ID` | From step 3.5 |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Optional for the Caller (ElevenLabs holds the Twilio credentials); fill them for the team's records |
| `OWNER_NUMBER` | Your own mobile, E.164, e.g. `+14155550199` |
| `CALL_ALLOWLIST` | Only numbers the Caller may ever dial, comma-separated E.164. For the first test: just `OWNER_NUMBER`'s value |
| `CALLER_DRY_RUN` | Leave `1` until the test below |
| `HUB_URL`, `HUB_TOKEN` | The Orchestrator's hub (see README) |

Never paste the key into chat, logs or `STATUS.md`.

## 5. The one real test call (to your own phone)

Do this once, with your phone in hand. It costs a few cents of Twilio + ElevenLabs credit.

1. In `.env`: `CALL_ALLOWLIST=<your number>` (only yours), `CALLER_DRY_RUN=0`.
2. Terminal 1, from `caller/`:
   `uv run fakes/hub.py --to <your number> --timeout 200` (a real call takes longer than the 30 s default)
3. Terminal 2, from `caller/`: `uv run caller` (it reads the root `.env`; `HUB_URL` must be
   `ws://localhost:8765` for this test).
4. Your phone rings. Answer, play Alex: say "Sure, 3 is fine," and let the agent hang up.
5. Terminal 1 shows `dialing`, `answered`, `ended`, then a `call_result` with your words in the
   transcript and prints `PASS`. Stop the caller with Ctrl-C.
6. Set `CALLER_DRY_RUN=1` again unless you're about to demo.

If it fails: the caller's stderr and `caller/logs/*.jsonl` say why. HTTP 401 → wrong API key;
422 → wrong agent or phone number id; call never rings on a Twilio trial → number not verified.
