/*
 * needle-line: a statically linked Needle 3 runner for hosts without a
 * dynamic loader (the Homey app container). Line protocol over stdio:
 *
 *   argv: needle-line <model.cact> <tools.json> <system.txt> [threads]
 *         threads > 0 sets the engine's thread pool size. The engine sizes it
 *         from std::thread::hardware_concurrency() (sysconf), which reports
 *         every core even under a cgroup CPU quota, and its worker threads
 *         spin-wait: N spinning threads on a smaller quota are catastrophic.
 *         Pinning with sched_setaffinity makes it worse, because the pool
 *         size does not follow the affinity. So sysconf itself is wrapped
 *         (link with -Wl,--wrap=sysconf).
 *   out:  DIAG {"affinity_cpus":N,"online_cpus":M,"loop1_ms":X,"loop4_ms":Y}
 *   out:  READY {"prefix_tokens":N,"load_ms":X,"init_ms":Y}
 *   in:   one query per line (UTF-8, no newlines inside)
 *   out:  OK <ms> <envelope JSON on one line>   |   ERR <message>
 *
 * Every query starts from needle_reset(): voice turns are independent.
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sched.h>
#include <pthread.h>
#include "needle.h"

static int forced_threads = 0;

long __real_sysconf(int name);
long __wrap_sysconf(int name) {
    if (forced_threads > 0 && (name == _SC_NPROCESSORS_ONLN || name == _SC_NPROCESSORS_CONF)) return forced_threads;
    return __real_sysconf(name);
}

static double now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1e3 + ts.tv_nsec / 1e6;
}

static char *slurp(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *buf = malloc(n + 1);
    if (buf && fread(buf, 1, n, f) != (size_t)n) { free(buf); buf = NULL; }
    if (buf) buf[n] = 0;
    fclose(f);
    return buf;
}

/* Fixed CPU work, identical per thread. Timing 1 thread vs 4 concurrent
   threads separates "the engine sees one CPU" (fixable) from "the host
   caps this process at one core" (loop4 ~ 4x loop1: a platform quota). */
static void *burn(void *arg) {
    volatile unsigned long long x = (unsigned long long)(size_t)arg + 1;
    for (unsigned long long i = 0; i < 120000000ULL; i++) x = x * 6364136223846793005ULL + 1442695040888963407ULL;
    return NULL;
}

static double burn_ms(int threads) {
    pthread_t t[8];
    double s = now_ms();
    for (int i = 0; i < threads; i++) pthread_create(&t[i], NULL, burn, (void *)(size_t)i);
    for (int i = 0; i < threads; i++) pthread_join(t[i], NULL);
    return now_ms() - s;
}

static void diagnose(void) {
    cpu_set_t set;
    CPU_ZERO(&set);
    int affinity = sched_getaffinity(0, sizeof set, &set) == 0 ? CPU_COUNT(&set) : -1;
    long online = sysconf(_SC_NPROCESSORS_ONLN);
    double one = burn_ms(1);
    double four = burn_ms(4);
    printf("DIAG {\"affinity_cpus\":%d,\"online_cpus\":%ld,\"loop1_ms\":%.1f,\"loop4_ms\":%.1f}\n", affinity, online, one, four);
}

int main(int argc, char **argv) {
    if (argc < 4) { fprintf(stderr, "usage: %s model.cact tools.json system.txt\n", argv[0]); return 2; }
    setvbuf(stdout, NULL, _IOLBF, 0);
    diagnose();
    if (argc > 4) forced_threads = atoi(argv[4]);

    double t0 = now_ms();
    int fd = open(argv[1], O_RDONLY);
    if (fd < 0) { printf("ERR cannot open model %s\n", argv[1]); return 1; }
    struct stat st;
    fstat(fd, &st);
    /* Mapped, not read: .cact is designed to be read in place, so the weights
       stay file-backed page cache instead of anonymous process memory. */
    void *cact = mmap(NULL, st.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
    if (cact == MAP_FAILED) { printf("ERR mmap failed\n"); return 1; }
    if (needle_load(cact, (unsigned long long)st.st_size) < 0) {
        printf("ERR needle_load: %s\n", needle_last_error() ? needle_last_error() : "?");
        return 1;
    }
    double t1 = now_ms();

    char *tools = slurp(argv[2]);
    char *system = slurp(argv[3]);
    if (!tools) { printf("ERR cannot read tools %s\n", argv[2]); return 1; }
    int prefix = needle_init(system ? system : "", tools, NULL);
    if (prefix < 0) {
        printf("ERR needle_init: %s\n", needle_last_error() ? needle_last_error() : "?");
        return 1;
    }
    double t2 = now_ms();
    printf("READY {\"prefix_tokens\":%d,\"load_ms\":%.1f,\"init_ms\":%.1f}\n", prefix, t1 - t0, t2 - t1);

    enum { OUT_CAP = 65536 };
    static char out[OUT_CAP];
    char *line = NULL;
    size_t cap = 0;
    ssize_t len;
    while ((len = getline(&line, &cap, stdin)) > 0) {
        while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r')) line[--len] = 0;
        if (len == 0) continue;
        needle_reset();
        double s = now_ms();
        int rc = needle_complete(line, 256, out, OUT_CAP);
        double e = now_ms();
        if (rc < 0) {
            printf("ERR needle_complete: %s\n", needle_last_error() ? needle_last_error() : "?");
            continue;
        }
        for (char *p = out; *p; p++) if (*p == '\n' || *p == '\r') *p = ' ';
        printf("OK %.1f %s\n", e - s, out);
    }
    return 0;
}
