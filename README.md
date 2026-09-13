# Duckey-Discord
Make your discord safer by using duckey to encrypt your private chats

# How does it looks

Once **Duckey** is installed, you'll get a **welcome screen**, depending on your **installed version**.

<p align=""><img src="https://i.postimg.cc/MpQ6NxqQ/image.png" width="560"></p>
---

You can **enable encryption** on a chat by just right clicking on it, and selecting the new option "**Encrypt with Duckey**"

<p align=""><img src="https://i.postimg.cc/yxxBPCvb/image.png" width="560"></p>
---

You will then need to **setup a password**, that will be your encryption key.
The person you're speaking with **need to setup the same**.

<p align=""><img src="https://i.postimg.cc/1R7yz4zz/image.png" width="560"></p>
---

And you will need to **re enter** your password for this chat each time you **relaunch Discord** fully or by a `ctrl+r`

## How does it works

Duckey hooks Discord's HTTP layer and DOM. When you enable encryption on a
channel, every message you send from that channel gets encrypted client-side
before it leaves your machine. When a message arrives, Duckey scans the DOM,
spots the ciphertext marker, and swaps it for plaintext.

Nothing about your password or your keys ever touches Discord's servers. The
only thing that hits their backend is the ciphertext blob. If Discord's
backend, or anyone watching the wire, or a backup they keep years from now
ever sees the message, all they get is base64 that's useless without the
password.

The other person needs Duckey running too, with the same password set on
the same channel. That's the whole handshake.

## The crypto

AES-256-GCM. Key derivation is PBKDF2-SHA256 with 150k iterations. IV is
12 random bytes per message, generated fresh from `crypto.getRandomValues`.
Salt is deterministic per channel so both sides derive the same key without
exchanging anything over the network.

```
password   ─┐
            ├──► PBKDF2-SHA256(iter=150000, salt=channelSalt)
channelId  ─┘              │
                           ▼
                    AES-256-GCM key (CryptoKey, memory-only)

channelSalt = SHA256("duckey/v1/" + channelId)[0:16]
```

Per-message encryption:

```
plaintext ──► AES-GCM(key, iv) ──► ciphertext + auth tag
                                    │
                                    ├──► iv       (12 bytes)
                                    └──► ct+tag   (n bytes)

packet = iv ‖ ciphertext ‖ tag
output = "DKY1:" + base64(packet)
```

Decryption is the reverse. If the auth tag doesn't verify (wrong password,
tampered ciphertext, truncated message), `crypto.subtle.decrypt` throws and
Duckey leaves the message as-is instead of rendering garbage.

## Wire format

```
DKY1:8Hf3mQ2pL9xW1nR6tY4vB7cN5jK8aZ0sE2dF6gH9jK3lM5nP7qR1tV4xZ8bC2dE5f
│    │
│    └── base64(iv ‖ ciphertext ‖ gcm_tag)
└── 5-byte magic. Tells Duckey "this is ours, decrypt it".
```

Why a magic prefix instead of a metadata field: Discord's message API only
accepts a plain `content` string. There's no room for a custom envelope, no
custom headers survive to the recipient. Prefix-stuffing is the only way to
carry the ciphertext through Discord's pipeline intact.

URLs are sent in the clear. If the whole message is just a link, Duckey
skips it so invite previews and embeds still work.

## What runs where

```
┌──────────────────── Browser / Electron renderer ─────────────────────┐
│                                                                      │
│  ┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐  │
│  │  XHR interceptor│    │  DOM scanner     │    │  Menu injector  │  │
│  │                 │    │                  │    │                 │  │
│  │  POST /messages │    │  walk text nodes │    │  right-click    │  │
│  │   → encrypt     │    │  find DKY1:...   │    │   → toggle      │  │
│  │     content     │    │   → decrypt      │    │     encryption  │  │
│  └────────┬────────┘    └────────┬─────────┘    └─────────────────┘  │
│           │                      │                                   │
│           ▼                      ▼                                   │
│      ┌────────────────────────────────┐                              │
│      │  key store (Map, in-memory)    │                              │
│      │  channelId → CryptoKey         │                              │
│      └────────────────────────────────┘                              │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    wss://gateway.discord.gg
                    (ciphertext only, untouched)
```

Outgoing: the XHR hook sees the `POST /channels/{id}/messages` call, parses
the JSON body, encrypts `content`, and re-sends. Discord receives ciphertext
and stores it like any other message.

Incoming: Discord renders the ciphertext into the DOM. A MutationObserver
fires on every render. The scanner walks text nodes, matches `DKY1:...`,
tries each unlocked key until one decrypts, and replaces the text in place.

## Install (Brower)

1. Open `https://discord.com`.
2. Open the Browser console → **paste duckey.js content**.
3. Enjoy!

Works in any browser. Also work in the desktop
app.

## Install (desktop app, permanent)

Drop `Duckey-Permanent.bat` next to `duckey.js` and run it once. It patches
the current Discord install:

```
resources/
├── app/
│   ├── index.js       ← shim: loads original.asar + injects duckey.js
│   ├── package.json
│   └── duckey.js      ← your payload
└── original.asar      ← the real Discord entry, renamed
```

Electron prefers a `resources/app/` folder over `resources/app.asar`, so
`app/index.js` becomes the entry point. It hooks `browser-window-created`,
waits for the `discord.com` window, and runs the payload in the renderer.
Then it `require()`s `original.asar` so Discord boots normally underneath.

Launch Discord any way you like — taskbar, Start menu, autostart. Duckey
loads every time. After a Discord update creates a new `app-<version>`
folder, run the bat once more.

To uninstall: delete `resources/app/` and rename `original.asar` back to
`app.asar`.

## Using it

- Right-click a channel or DM in the sidebar → **Encrypt with Duckey**.
- Set a password. The other person sets the same one on their side.
- Send messages normally. You see plaintext. They see plaintext. Discord
  sees ciphertext.
- Toggle: right-click again, or press **Ctrl+Shift+E** in the channel.
- Password is memory-only. Every Discord launch = re-enter per channel.

## What Duckey doesn't do

- **It doesn't hide metadata.** Discord still sees who, when, and how often
  you message someone. It only hides *what* you said.
- **It doesn't verify the other person.** If someone else guesses the
  password, they can read the channel. Use something that isn't `password`.
- **It doesn't protect against a compromised client.** If malware is on the
  machine running Duckey, it can read the messages after decryption. Same
  for anything running in the renderer.
- **It doesn't retroactively encrypt.** Only messages sent while the channel
  is unlocked get encrypted. History stays plaintext unless you scroll back
  and resend.

## Threat model

In scope:

- Discord's servers, backups, and any future breach where stored messages leak
- Passive network observers
- Discord employees with database access but no access to your device

Out of scope:

- Malware on your machine
- Discord itself if they decide to ship a client update that exfiltrates
  decrypted DOM contents (nothing stops that short of not using Discord)
- Someone who already has your password

## Versioning

Current: **2.2**

- `2.0` — DOM-based decryption (drop WebSocket hooking entirely)
- `2.1` — URL passthrough, badge removal, channel-menu detection
- `2.2` — inline menu injection, permanent desktop patcher

## Credits

Made by tordev.
