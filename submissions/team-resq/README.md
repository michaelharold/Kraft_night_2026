# Team Name: <replace-with-team-name>

## Members
| Name | Email | GitHub |
|------|-------|--------|
| Michael Harold Sony |  | [@michaelharold](https://github.com/michaelharold) |
|      |       |        |
|      |       |        |
|      |       |        |

## Project Name
ResQ — trusted local help, one tap away

## Goal / Problem Statement
When a pipe bursts, a fuse trips or an elderly parent needs a nurse, finding the right person nearby is slow and
uncertain: you ask around, call numbers from old WhatsApp forwards, and cannot see who is free right now, what they
will charge, or whether they can be trusted. Meanwhile skilled neighbours have spare hours and no simple way to find
local work. ResQ is a hyperlocal services marketplace where anyone can hire a verified neighbour (plumber,
electrician, carpenter, AC technician, cleaner, mechanic, doctor, nurse, caregiver) or earn from their own skills,
with transparent prices, live matching within 10 km, and an offline SMS path so workers with basic phones never miss
a job.

**What makes it different**
- **A local AI scopes the job before anyone travels.** It reads the customer's description (typed or spoken) and
  returns the tools needed, the time and skill level, and *which photos to take, from which angle* so the worker
  arrives prepared. It runs on the device through Ollama; nothing is sent to a cloud service.
- **Offline workers still get the work.** Matched providers who don't have the app open receive an SMS and claim the
  job with one reply, `ACCEPT 1234`. Their income doesn't depend on staying glued to an app.
- **Matching uses skills *and* tools.** MongoDB geo-queries find verified providers within 10 km whose declared tool
  kit covers what the AI says the job needs.
- **Trust is local:** phone sign-in, admin-verified ID badges, ratings, and each provider's own price range shown
  before booking.

## Tech Stack
Next.js 16 (App Router) · React 19 · TypeScript (strict) · Tailwind CSS 4 · MongoDB (users, jobs, GridFS for ID
proofs and job photos, GeoJSON `$near` matching) · Ollama running `llama3.1` locally (falls back to `qwen2.5:3b`) ·
Twilio (Verify for sign-in codes, SMS job alerts and one-reply acceptance) · Server-Sent Events for live updates ·
hand-built SVG map (no map SDK) · 90 unit tests.

## Source code
Full project repository: **https://github.com/michaelharold/resq**
(clone-and-run instructions are in its README).

## Demo Video
<Link to an unlisted YouTube/Drive video showing the project working>

## Screenshots
See the `photos/` folder in this directory:

| File | What it shows |
|---|---|
| `01-home-services-nearby.png` | Home: 11 services, how many providers are nearby and their price ranges |
| `02-booking-who-gets-it.png` | Booking a plumber: exactly who will receive the request, with ratings, verified badges, distance and price |
| `03-ai-job-analysis.png` | The local AI's job breakdown: tools, time, skill level, requested photos with angles, and questions |
| `04-worker-job-brief.png` | The worker who accepted by SMS: brief, tools, the customer's photo and answers, map and navigation |
| `05-admin-console.png` | Admin console: live requests, ID verification and audit log |

## How to Run (optional)
```bash
git clone https://github.com/michaelharold/resq.git && cd resq
npm install
mongod --dbpath ~/.local/mongodb-data --bind_ip 127.0.0.1 --fork --logpath /tmp/mongod.log
ollama serve & ollama pull qwen2.5:3b        # or llama3.1 for better scoping
cp .env.example .env.local                   # RESQ_SHOW_OTP_ON_SCREEN=1 lets you sign in without Twilio
npm run dev                                  # http://localhost:3000
```
Then open `http://localhost:3000/demo` and click **Open 4 users**: each window is a separate person, so one laptop
can act as a customer and several providers at once. 30 demo providers around TKMCE are created on first start.
Admin console: `/ops` with `coordinator` / `resq-ops`.
