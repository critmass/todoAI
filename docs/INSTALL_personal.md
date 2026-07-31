# Installing todoAI on your phone — personal / alpha testing

*How to get the shipped app (through task 24) running on the S23 FE for your own daily use. This is the "I just want to run it" guide; `README_build.md` has the deeper toolchain notes and the gotchas behind each step.*

**What you're installing:** a debug build of the full app — the real product UI, the timer, coaching, the on-device 4B model, and the alarm. Everything runs locally; nothing leaves the phone.

---

## 0. One-time prerequisites (skip if the toolchain already builds)

You've built to the device before (tasks 6, 7, 12, 13, 24 all ran on it), so this is almost certainly already set up. If a fresh machine:

- **Node ≥ 22.11.0**, **JDK 17** with `JAVA_HOME` set at the system level (Windows won't set it for you — this is the #1 build-failure cause).
- **Android Studio** with SDK Platform 36, Build-Tools 36.0.0, NDK 27.1.12297006. `ANDROID_HOME` set, `platform-tools` on `PATH`.
- **USB debugging on** on the S23 FE; `adb devices` shows it as `device` (not `unauthorized` — if unauthorized, accept the prompt on the phone).

---

## 1. Install JS dependencies — **from PowerShell or cmd, NOT Git Bash**

```powershell
cd C:\Users\physi\Documents\projects\todoAI
npm install
```

**Why not Git Bash:** `llama.rn`'s postinstall shells out to `tar` to extract its prebuilt native libs, and Git Bash's GNU `tar` misreads the `C:\...` temp path as a remote host and dies silently — you'd get an install that looks fine but has no native libraries. Use PowerShell or cmd so `tar` resolves to Windows' `System32\tar.exe`.

**Confirm it worked:**
```powershell
dir node_modules\llama.rn\android\src\main\jniLibs
```
You should see `arm64-v8a` (and `x86_64`) folders. No folders = the tar problem above; delete `node_modules` and reinstall from PowerShell.

---

## 2. Get the model onto the phone

The app loads the 4B from **app-private external storage**. It must be there before the first session that uses the model (task capture, coaching). A timer-only session works without it, but you want it there.

```powershell
adb push ternary-bonsai-4b-tq1_0.gguf /sdcard/Android/data/com.todoai/files/
```

- **The path is not optional.** `/sdcard/Download/` and other shared locations fail to load with a silent-looking error on modern Android. It must be `/sdcard/Android/data/com.todoai/files/`.
- **The `com.todoai` app dir only exists after the app is installed once.** If the push fails with "no such directory," do step 3 first (install the app), then come back and push.
- **Which file:** Ternary-Bonsai-4B, **TQ1_0** quant (the community repack) — *not* Q1_0 (older 1-bit family) and not Q2_0 (fork-only). This is the file the whole build has been proven against. Filename may differ from the example; match what you have.

---

## 3. Build and install the app

Two terminals, both in the project root.

**Terminal 1 — Metro:**
```powershell
npm start
```

**Terminal 2 — build + install to the connected phone:**
```powershell
npm run android
```

First build is slow (native compile + codegen for the alarm module). When it finishes, the app launches on the phone and Metro's Fast Refresh is live.

### ⚠ If the alarm silently doesn't work (first build only)

There's a known first-build trap with the app's own alarm TurboModule: CMake can configure *before* codegen runs, cache the wrong flag, and the alarm resolves to `null` in JS — the app works, but block-end alarms never fire from the background. Task 24 lost a device session to this. If you notice no alarm firing (Settings will say the alarm "isn't available in this build"):

```powershell
rmdir /s /q android\app\.cxx
cd android
.\gradlew installDebug
cd ..
```

Confirm it took — this string should now appear in the ninja build file:
```
-DREACT_NATIVE_APP_MODULE_PROVIDER=
```
(in `android\app\.cxx\Debug\*\arm64-v8a\build.ninja`). After this, Settings should report the alarm as "set to fire exactly on time."

---

## 4. First-run sanity check

On the phone:

1. **App opens to the dashboard.** (First run, empty state = "Add task".)
2. **Add a task** via the "Add task" chat — type something like *"call the dentist for 10 minutes tomorrow"*. The model loads (~3 s the first time) and should ask a clarifying question, then let you save. This exercises the model, the grammar-constrained extraction, and the DB write all at once.
3. **Start a work session** → pick a length → energy check-in → it serves you a task with the timer. This is the core loop.
4. **Check the alarm:** start a short session, background the app, wait for the block to end. The alarm should fire (full-screen or heads-up). If it doesn't, see the §3 trap above.
5. **Settings → alarm status** should say it's set to fire exactly on time.

If all five work, you have the real app and can start using it.

---

## 5. Living with a debug build (what to expect)

This is a **debug** build, which is the right call for personal alpha — you get Fast Refresh and logs. Practical notes:

- **It depends on your machine for JS *only while Metro is running and connected.*** Once installed, the app runs standalone on the phone — you can unplug and use it all day. But a debug build loads its JS bundle from Metro on launch when it can reach it; if you relaunch far from your dev machine, it falls back to the last bundle. For truly untethered daily use, consider a **release build** (below) once you've settled in.
- **Logs:** `adb logcat | findstr todoai` (or ReactNativeJS) surfaces anything going wrong. Worth a look if a session behaves oddly.
- **The `src/dev/` harness screens still exist** behind a debug-only affordance — ignore them; the real app is what launches.
- **Crash recovery is real and confirmed** — if the app is killed mid-task, relaunching credits your time, writes no skip, and opens to a recovery screen. You can trust it.

### Optional: a standalone release build for daily carry

When you want it fully independent of your dev machine (recommended once alpha settles):

```powershell
cd android
.\gradlew assembleRelease
```
The APK lands in `android\app\build\outputs\apk\release\`. Install it with `adb install -r <path-to-apk>`. A release build bundles its own JS (no Metro dependency) and runs faster. *Note:* a release build needs signing config; the debug build is fine for the first stretch of personal use, so don't block on this.

---

## 6. When you hit something

- **Build fails on JDK/Gradle errors** → `JAVA_HOME` almost always. Set it at system level, point at JDK 17.
- **`npm audit` nags** → leave it. Do **not** run `npm audit fix --force`; it breaks the pinned RN/`llama.rn` set. Update deps one at a time, deliberately.
- **Model won't load** → check it's at `/sdcard/Android/data/com.todoai/files/` (not Download), and that the app has been installed at least once so that dir exists.
- **Model loads but output is garbage/loops** → that's the chat-template path, not a bad model. The app already uses the `messages` API correctly, so this shouldn't happen in the shipped build — but if you ever see it after a change, that's the cause.
- **Everything builds, alarm doesn't fire** → the §3 `.cxx` trap.

Full gotcha detail (with the *why* behind each) is in `README_build.md`.
