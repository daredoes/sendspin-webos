/*
 * audio_helper.c — Phase 1 spike for Sendspin background audio daemon (webOS TV)
 *
 * Goal of this spike: prove that a standalone native process can play PCM audio
 * in the BACKGROUND and have it MIXED with the live TV / HDMI audio by the
 * webOS PulseAudio server, instead of being ducked or stealing audio focus.
 *
 * What it does:
 *   - Opens a PulseAudio playback stream (pa_simple, blocking, in a dedicated
 *     thread that requests SCHED_FIFO real-time scheduling).
 *   - Sets the stream's media.role via the PULSE_PROP env var so we can probe
 *     how the webOS audio policy manager treats different roles.
 *   - Audio source is one of: a generated sine tone, a raw PCM file, stdin, or
 *     a named FIFO — so it can be driven standalone now and by the JS Service
 *     later (feed PCM into the FIFO/stdin).
 *
 * This is intentionally pa_simple (blocking write) rather than the async +
 * lock-free ring buffer design from the plan. The ring buffer is a Phase 2
 * concern; the ONLY question this spike answers is "does background audio mix
 * with live TV on the target firmware, and which media.role lets it?".
 *
 * Build: see CMakeLists.txt + README.md (cross-compiled against the webOS NDK).
 */

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <math.h>
#include <errno.h>
#include <signal.h>
#include <unistd.h>
#include <fcntl.h>
#include <pthread.h>
#include <sched.h>

#include <pulse/simple.h>
#include <pulse/error.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

/* ---- config from argv ---- */
typedef enum { SRC_TONE, SRC_FILE, SRC_STDIN, SRC_FIFO } src_kind_t;

typedef struct {
    uint32_t   rate;
    uint8_t    channels;
    int        use_f32;        /* 0 = s16le, 1 = f32le */
    const char *role;          /* media.role, e.g. "music" */
    src_kind_t src;
    const char *path;          /* for SRC_FILE / SRC_FIFO */
    double     tone_hz;
    double     duration_sec;   /* 0 = infinite (tone) */
    uint32_t   chunk_frames;   /* frames per write */
} cfg_t;

static volatile sig_atomic_t g_stop = 0;
static void on_signal(int sig) { (void)sig; g_stop = 1; }

static size_t bytes_per_frame(const cfg_t *c) {
    return (size_t)c->channels * (c->use_f32 ? 4 : 2);
}

static void usage(const char *prog) {
    fprintf(stderr,
"Usage: %s [options]\n"
"  --rate N          sample rate (default 48000)\n"
"  --channels N      channels (default 2)\n"
"  --f32             use float32 PCM (default s16le)\n"
"  --role NAME       PulseAudio media.role (default \"music\")\n"
"  --tone HZ         generate sine tone at HZ (default source)\n"
"  --duration SEC    tone duration, 0 = forever (default 0)\n"
"  --pcm FILE        play raw interleaved PCM from FILE (\"-\" = stdin)\n"
"  --fifo PATH       read raw PCM from named pipe PATH\n"
"  --chunk N         frames per write (default 1024)\n"
"\nSpike usage examples:\n"
"  %s --tone 440 --role music            # 440Hz beep, probe mixing\n"
"  %s --tone 440 --role notification     # probe a different policy role\n"
"  %s --fifo /tmp/sendspin.pcm           # JS service feeds PCM into FIFO\n",
        prog, prog, prog, prog);
}

/* Try to raise this thread to real-time. Best effort: log + continue on fail,
 * since Dev Mode may not grant RT scheduling. */
static void try_realtime(void) {
    struct sched_param sp;
    memset(&sp, 0, sizeof(sp));
    int maxp = sched_get_priority_max(SCHED_FIFO);
    sp.sched_priority = (maxp > 0) ? (maxp - 1) : 1;
    if (pthread_setschedparam(pthread_self(), SCHED_FIFO, &sp) == 0) {
        fprintf(stderr, "[helper] RT scheduling: SCHED_FIFO prio %d\n", sp.sched_priority);
    } else {
        fprintf(stderr, "[helper] RT scheduling unavailable (%s) — continuing at normal prio\n",
                strerror(errno));
    }
}

/* Fill `buf` with `frames` of sine tone. Advances *phase. */
static void gen_tone(const cfg_t *c, void *buf, uint32_t frames, double *phase) {
    const double step = 2.0 * M_PI * c->tone_hz / (double)c->rate;
    for (uint32_t i = 0; i < frames; i++) {
        double s = sin(*phase) * 0.25; /* -12 dBFS, easy on ears + speakers */
        *phase += step;
        if (*phase > 2.0 * M_PI) *phase -= 2.0 * M_PI;
        for (uint8_t ch = 0; ch < c->channels; ch++) {
            if (c->use_f32) {
                ((float *)buf)[i * c->channels + ch] = (float)s;
            } else {
                ((int16_t *)buf)[i * c->channels + ch] = (int16_t)(s * 32767.0);
            }
        }
    }
}

int main(int argc, char **argv) {
    cfg_t c = {
        .rate = 48000, .channels = 2, .use_f32 = 0, .role = "music",
        .src = SRC_TONE, .path = NULL, .tone_hz = 440.0,
        .duration_sec = 0.0, .chunk_frames = 1024,
    };

    for (int i = 1; i < argc; i++) {
        const char *a = argv[i];
        #define NEXT() (++i < argc ? argv[i] : (usage(argv[0]), exit(2), ""))
        if      (!strcmp(a, "--rate"))     c.rate = (uint32_t)atoi(NEXT());
        else if (!strcmp(a, "--channels")) c.channels = (uint8_t)atoi(NEXT());
        else if (!strcmp(a, "--f32"))      c.use_f32 = 1;
        else if (!strcmp(a, "--role"))     c.role = NEXT();
        else if (!strcmp(a, "--tone"))   { c.src = SRC_TONE; c.tone_hz = atof(NEXT()); }
        else if (!strcmp(a, "--duration")) c.duration_sec = atof(NEXT());
        else if (!strcmp(a, "--pcm"))    { const char *p = NEXT();
                                           if (!strcmp(p, "-")) c.src = SRC_STDIN;
                                           else { c.src = SRC_FILE; c.path = p; } }
        else if (!strcmp(a, "--fifo"))   { c.src = SRC_FIFO; c.path = NEXT(); }
        else if (!strcmp(a, "--chunk"))    c.chunk_frames = (uint32_t)atoi(NEXT());
        else if (!strcmp(a, "-h") || !strcmp(a, "--help")) { usage(argv[0]); return 0; }
        else { fprintf(stderr, "unknown arg: %s\n", a); usage(argv[0]); return 2; }
        #undef NEXT
    }

    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);
    signal(SIGPIPE, SIG_IGN);

    /* The whole point of the spike: tell PulseAudio our role so we can observe
     * how the webOS policy manager mixes/ducks us. libpulse reads PULSE_PROP. */
    char propbuf[128];
    snprintf(propbuf, sizeof(propbuf),
             "media.role=%s application.name=sendspin-helper", c.role);
    setenv("PULSE_PROP", propbuf, 1);

    pa_sample_spec ss = {
        .format   = c.use_f32 ? PA_SAMPLE_FLOAT32LE : PA_SAMPLE_S16LE,
        .rate     = c.rate,
        .channels = c.channels,
    };

    int err = 0;
    pa_simple *pa = pa_simple_new(
        NULL,                 /* default server */
        "sendspin-helper",    /* app name */
        PA_STREAM_PLAYBACK,
        NULL,                 /* default sink */
        "sendspin-music",     /* stream description */
        &ss,
        NULL,                 /* default channel map */
        NULL,                 /* default buffering — do NOT request exclusive */
        &err);
    if (!pa) {
        fprintf(stderr, "[helper] pa_simple_new failed: %s\n", pa_strerror(err));
        return 1;
    }
    fprintf(stderr, "[helper] stream open: %u Hz, %u ch, %s, role=%s\n",
            c.rate, c.channels, c.use_f32 ? "f32le" : "s16le", c.role);

    try_realtime();

    const size_t bpf = bytes_per_frame(&c);
    const uint32_t cf = c.chunk_frames;
    const size_t chunk_bytes = (size_t)cf * bpf;
    uint8_t *buf = malloc(chunk_bytes);
    if (!buf) { fprintf(stderr, "[helper] OOM\n"); pa_simple_free(pa); return 1; }

    int in_fd = -1;
    if (c.src == SRC_STDIN) in_fd = STDIN_FILENO;
    else if (c.src == SRC_FILE || c.src == SRC_FIFO) {
        in_fd = open(c.path, O_RDONLY);
        if (in_fd < 0) {
            fprintf(stderr, "[helper] open(%s) failed: %s\n", c.path, strerror(errno));
            free(buf); pa_simple_free(pa); return 1;
        }
    }

    double phase = 0.0;
    uint64_t frames_total = 0;
    const uint64_t frames_limit =
        (c.src == SRC_TONE && c.duration_sec > 0.0)
            ? (uint64_t)(c.duration_sec * c.rate) : 0;

    while (!g_stop) {
        uint32_t want = cf;
        if (frames_limit && frames_total + want > frames_limit)
            want = (uint32_t)(frames_limit - frames_total);
        if (want == 0) break;

        if (c.src == SRC_TONE) {
            gen_tone(&c, buf, want, &phase);
        } else {
            /* read exactly want*bpf bytes (PCM source) */
            size_t need = (size_t)want * bpf, got = 0;
            while (got < need && !g_stop) {
                ssize_t r = read(in_fd, buf + got, need - got);
                if (r > 0) { got += (size_t)r; continue; }
                if (r == 0) { g_stop = 1; break; }      /* EOF */
                if (errno == EINTR) continue;
                fprintf(stderr, "[helper] read error: %s\n", strerror(errno));
                g_stop = 1; break;
            }
            if (got == 0) break;
            want = (uint32_t)(got / bpf);
        }

        if (pa_simple_write(pa, buf, (size_t)want * bpf, &err) < 0) {
            fprintf(stderr, "[helper] pa_simple_write failed: %s\n", pa_strerror(err));
            break;
        }
        frames_total += want;
    }

    fprintf(stderr, "[helper] draining (%llu frames played)\n",
            (unsigned long long)frames_total);
    if (pa_simple_drain(pa, &err) < 0)
        fprintf(stderr, "[helper] drain failed: %s\n", pa_strerror(err));

    if (in_fd >= 0 && in_fd != STDIN_FILENO) close(in_fd);
    free(buf);
    pa_simple_free(pa);
    fprintf(stderr, "[helper] done\n");
    return 0;
}
