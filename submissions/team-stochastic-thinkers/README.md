# Team Name: Team Stochastic Thinkers

## Members
| Name | Email | GitHub |
|------|-------|--------|
| Michael Harold Sony |  | [@michaelharold](https://github.com/michaelharold) |
| Navyasree A J |  |  |
| Shadha Mohamed Shareef |  |  |
| Afna V P |  |  |

## Project Name
**Sahaya** — Trusted Help, Right Around You

## Goal / Problem Statement
When a pipe bursts or a fuse trips, finding the right person nearby is slow and uncertain: you ask around, call
numbers from old WhatsApp forwards, and cannot see who is free right now, what they will charge, or whether they
can be trusted. Meanwhile skilled neighbours have spare hours and no simple way to find local work.

Sahaya is a hyperlocal marketplace for eight trades — plumber, electrician, carpenter, AC technician, appliance
repair, painter, cleaner, mechanic. Tap a trade, describe the problem **in your own language, out loud**, and
every matching provider within 10 km hears about it at once. The first to accept gets the job.

**Three things make it different.**

**1. It works across a language barrier, by voice.** A customer speaks Malayalam; the electrician who takes the
job may read only Tamil or English. Sahaya transcribes what was said, translates it, and **reads it aloud to the
other person in their own language** — a full turn takes about 4 seconds. Both halves are always on screen: the
translation you need, and the speaker's own words underneath, so nobody has to trust a machine's paraphrase of a
stranger's emergency. When translation fails it says so and shows the original rather than quietly inventing one.

**2. A local AI scopes the job before anyone travels.** It reads the description and works out the tools needed,
the time, the skill level, and *which photos to take, from which angle*, so the worker arrives prepared. This runs
on the laptop through Ollama — nothing leaves the machine.

**3. Offline workers still get the work.** Matched providers who do not have the app open get an SMS and claim the
job with one reply: `ACCEPT 1234`. Their income does not depend on staring at a screen.

Payment is built in: the worker names their charge, the customer pays by Razorpay, and the platform's commission
is taken from the **work only** — never from parts the worker bought out of their own pocket. If they had to buy a
tap mid-job, they photograph the receipt, an AI reads it, and the customer approves the amount before it is added.

## Tech Stack
Next.js 16 (App Router) · React 19 · TypeScript (strict) · Tailwind CSS 4 · MongoDB (GeoJSON `$near` matching,
GridFS for ID proofs, job photos and receipts) · **Sarvam AI** for Indian-language speech and translation ·
**Ollama** running locally for job scoping and receipt reading · Razorpay · Twilio (sign-in codes, SMS job alerts,
one-reply acceptance) · Server-Sent Events for live updates · hand-built SVG map, no map SDK · 168 unit tests.

## Demo Video
<Link to an unlisted YouTube/Drive video showing the project working>

## Screenshots
See the `photos/` folder in this directory.

| File | What it shows |
|---|---|
| `01-sign-in.png` | Sign in with a phone number; codes arrive by SMS |
| `02-home-every-trade-nearby.png` | Eight trades, how many providers are nearby and what they charge |
| `03-booking-who-gets-it.png` | Exactly who will receive the request — rating, ID badge, distance, price |
| `04-ai-job-analysis.png` | The local AI's breakdown: tools, time, and the photos to take, with angles |
| `05-desktop-layout.png` | The same app on a laptop — responsive from 360 px up |

## How to Run (optional)
The full source is in the `code/` folder beside this README, and also lives at
[github.com/michaelharold/Sahaya](https://github.com/michaelharold/Sahaya).

```bash
cd code            # or: git clone https://github.com/michaelharold/Sahaya.git && cd Sahaya
npm install
mongod --dbpath ~/.local/mongodb-data --bind_ip 127.0.0.1        # MongoDB 7+
ollama serve & ollama pull qwen2.5:3b                            # local AI for job scoping
cp .env.example .env.local                                       # add SARVAM_API_KEY for voice; the rest is optional
npm run dev                                                      # http://localhost:3000
```

Then open `http://localhost:3000/demo` and click **Open 4 users** — each window is a separate person, so one
laptop can act as a customer and several providers at once. 30 demo providers around TKMCE are created on first
start, deliberately speaking a mix of Malayalam, Tamil, Kannada, Telugu, Hindi and English so the translation is
visible. `RESQ_SHOW_OTP_ON_SCREEN=1` lets you sign in without Twilio. Admin console: `/ops`
(`coordinator` / `resq-ops`).

**Honest limitations.** Twilio is on a free trial, which only sends predefined message templates, so real job-alert
SMS needs a paid account — the code path is complete and proven, the delivery is not. Live request state is held in
memory, so a restart clears jobs in flight; accounts, payments and receipts survive in MongoDB. In-app payment runs
against Razorpay test keys.
