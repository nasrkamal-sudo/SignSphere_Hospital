# SignSphere — live hospital sign-language interpreter

Patient signs into the camera → the app recognises the signs → shows the answer in English + Urdu → the patient
confirms → it appears on the staff dashboard in real time. Staff speak (or type) into the dashboard → the message
appears on the patient screen in large text → the patient replies with signs.

No mock data: everything is live and saved on this machine, and the sign recogniser is **your own VIBETALK pipeline**
(MediaPipe HandLandmarker → 63-d wrist-centred features → 12-frame sequence → DTW 1-nearest-neighbour with a confidence
gate that never guesses), ported to the browser. Your restaurant signs for *yes, no, help, confirm, cancel, one–five*
are reused.

## Run it

1. Install Node 18 or newer (https://nodejs.org). No `npm install` needed — there are no dependencies.
2. In this folder run `node server.js` (Windows: double-click `start.bat`; Mac/Linux: `./start.sh`).
3. Open **http://localhost:3000** in **Chrome or Edge**.
   - **Patient screen** and **Staff dashboard** can be two browser windows on the same computer (they sync instantly),
     or use **Side by side**.
   - Camera and microphone only work on `http://localhost` or HTTPS. To use the kiosk on a different computer,
     put the server behind HTTPS (reverse proxy or tunnel) and start it with `HOST=0.0.0.0 node server.js`.
4. Allow the camera (patient) and microphone (staff) when the browser asks.

## First thing to do: record the hospital signs

Only 10 of the 42 hospital signs are reused from your restaurant model. Open **Train signs**:

1. Pick a sign in the list, turn the camera on, press **Auto × 10** (3-2-1 countdown, then 1.3 s of signing, ten times).
   Vary your hand position a little between takes. About 10 recordings per sign is a good start.
2. Press **Train model** (runs in the browser, saves to `data/models/hospital-model.json`), then
   **Check accuracy** (leave-one-recording-out). Record more takes, or pick a more distinct gesture, for any weak sign.
3. **Live test** shows what the recogniser sees in real time, with confidence.

Recordings are stored as `data/dataset/<gloss>/session-NNN.json` and the model as a `dtw` artefact — the same layout
as VIBETALK, so your Python scripts can read them. The vocabulary is `data/hospital-vocabulary.json`.

## How a patient session works

Four questions (where / how long / how bad / other symptoms). The patient signs; recognised signs appear as chips and the
interpreted answer is shown in English and Urdu. **Confirm** by signing *yes* (or *confirm*) or press the button; sign
*no* / *cancel* or press **Redo** to clear. **Tap instead** is there if a sign is not recognised. SOS needs a 1.5-second
hold. Triage (critical vs non-urgent) and department routing are transparent rules in `public/js/logic.js` — not an AI
model. The doctor list and clinic hours are real public data (rimstrauma.net/doctor.html), with availability computed
from those hours; replace the roster with your hospital's own before real use.

## Doctor screen

Open **Doctor screen**, pick your name (or open `/?mode=doctor&doctor=d8`). On the **Staff screen**, press **Notify** next to the
recommended doctor, or any other doctor in the department. That doctor's screen instantly shows an alert (toast, beep, count
badge on the tab and in the page title), and lists the case with a red **CRITICAL** or **Non-urgent** marker, the triage reasons,
the patient summary and the patient's signed answers. **Acknowledge** tells the staff desk the doctor is on it (shown on the
Staff screen). The name picker is not a login — add authentication before real use.

## What you should know

- **Speech to text** uses the browser's Web Speech API (`ur-PK`, with an English switch). In Chrome/Edge the audio is sent
  to the browser vendor's online service, so it needs internet and is not private. It does not work in Firefox.
- **Not verified with real hardware:** the build was tested end-to-end in an automated browser with a fake camera and
  injected hand landmarks (full pipeline, MediaPipe loading, recording, training, recognition, sync), and the recogniser
  matches your Python implementation numerically (40/40 cases). It could not be tried with a real hand on a real webcam
  or with the real speech service. Expect to tune on your own recordings.
- **No login / encryption.** Anyone who can reach the server can read sessions. Use on a trusted network only, and add
  authentication, TLS and a retention policy before real patient use. Camera video is never recorded or stored; only hand
  landmarks (when you record training samples) and confirmed answers are saved.
- This is a communication aid, not a certified medical device. Always confirm key details with the patient.
- Fonts (IBM Plex Sans, Noto Nastaliq Urdu — SIL OFL) and MediaPipe (Apache-2.0) are bundled, so the app works offline
  except for speech recognition.

## Tests

`npm test`: parity with your Python DTW, live sign segmentation, and training.
