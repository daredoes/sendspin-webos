# audio-helper — Phase 1 spike

Standalone native PulseAudio player. **Single question it answers:** can a background
process play audio that the webOS audio policy **mixes** with live TV / HDMI, and
which `media.role` allows it?

If this spike fails (audio gets ducked to silence or steals TV audio focus), the whole
background-daemon plan needs rethinking *before* any JS-Service porting. That's why it's first.

---

## What it is

`audio_helper.c` — opens a `pa_simple` playback stream in a thread that requests
`SCHED_FIFO`, sets `media.role` via `PULSE_PROP`, and plays either a generated sine
tone or raw PCM from a file / stdin / FIFO.

```
audio-helper --tone 440 --role music        # 440Hz tone, music role
audio-helper --fifo /tmp/sendspin.pcm        # JS service feeds PCM here later
audio-helper --pcm song.raw --rate 44100     # raw S16LE interleaved
```

---

## Build (cross-compile for the TV)

The binary must link against the **TV's** libpulse for its CPU (LG webOS TVs are ARM).
You need a sysroot that contains `libpulse-simple.so` + headers. Two routes:

### Route A — webOS OSE NDK (preferred)
1. Install the webOS OSE NDK / toolchain (`arm-webos-linux-gnueabi-*`).
2. Point CMake at its toolchain file:
   ```bash
   cmake -S . -B build \
     -DCMAKE_TOOLCHAIN_FILE=/path/to/webos-ndk/cmake/webos.cmake \
     -DCMAKE_BUILD_TYPE=Release
   cmake --build build
   ```
   The NDK sysroot must include the PulseAudio dev package. If `pkg-config` finds
   `libpulse-simple`, CMake uses it; otherwise it links `-lpulse-simple -lpulse` by name.

### Route B — build against a sysroot pulled from the device
If you don't have the NDK PulseAudio package, copy the libs/headers off a TV (Dev Mode
shell) into a sysroot dir and pass `--sysroot` via a small toolchain file. Needed files:
`libpulse-simple.so*`, `libpulse.so*`, and the `pulse/` headers (headers can come from the
matching upstream PulseAudio version).

> Host (macOS) build is **not** a useful test target — macOS has no PulseAudio sink and
> the policy behaviour we're probing only exists on the TV. Use the host only to
> syntax-check (`cmake` will fail at link without libpulse — that's expected).

---

## Deploy + run on the TV (Dev Mode)

```bash
# 1. Copy the binary onto the TV (Dev Mode SSH; port 9922, user 'prisoner')
scp -P 9922 build/audio-helper prisoner@<TV_IP>:/tmp/

# 2. Shell into the TV
ssh -p 9922 prisoner@<TV_IP>

# 3. On the TV: start playing a tone in the BACKGROUND, then switch the TV to
#    live TV / an HDMI input and listen.
/tmp/audio-helper --tone 440 --role music &
#    ...change input / open another app, confirm the tone keeps playing...
kill %1
```

To test PCM feeding (proves the JS-Service path):
```bash
mkfifo /tmp/sendspin.pcm
/tmp/audio-helper --fifo /tmp/sendspin.pcm --rate 48000 --channels 2 &
# feed any raw S16LE 48k stereo PCM into the FIFO, e.g. transcode on a host and scp,
# or cat a .raw file:  cat clip.raw > /tmp/sendspin.pcm
```

---

## The actual experiment — role matrix

Run the tone with each role and note what the policy manager does while live TV plays:

| `--role` | Tone audible alone? | Audible **with live TV**? | TV audio ducked? | Notes |
|---|---|---|---|---|
| `music` | | | | |
| `media` | | | | |
| `notification` | | | | |
| `alert` | | | | |
| (none/unset) | | | | |

**Success =** at least one role plays the tone **mixed** with live TV without killing
TV audio. Record which role(s) in the plan doc; that role goes into the production helper.

**If everything ducks/steals:** capture `LunaSend` audio-policy queries
(`luna-send -n 1 luna://com.webos.audio/...`) and the PulseAudio logs, then escalate —
we may need an explicit policy entry, a different sink, or to route through
`com.webos.media` instead (Option D in the plan).

---

## Known caveats

- **RT scheduling** may be denied in Dev Mode (`SCHED_FIFO unavailable`) — the helper
  logs and continues; underruns are acceptable for the spike, the ring buffer comes later.
- **Dev Mode** removes side-loaded apps after ~50h; a raw `/tmp` binary just needs re-`scp`.
- This spike uses blocking `pa_simple`; production uses async + lock-free ring buffer
  (Phase 2) so Node feed jitter can't cause dropouts.
