#define _GNU_SOURCE
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/mount.h>
#include <wait.h>
#include <fcntl.h>
#include <stdlib.h>
#include <stdio.h>
#include <unistd.h>
#include <string.h>
#include <sched.h>

#define ROOTDIR "/mnt"

static int fcopy(const char *fn1, const char *fn2) {
    char            buffer[BUFSIZ];
    size_t          n;

    FILE *f1 = fopen(fn1, "rb");
    FILE *f2 = fopen(fn2, "wb");

    while ((n = fread(buffer, sizeof(char), sizeof(buffer), f1)) > 0) {
        if (fwrite(buffer, sizeof(char), n, f2) != n) {
            return -1;
        }
    }

    fclose(f1);
    fclose(f2);

    return 0;
}

#define DOMOUNT(DIR, SRC, TYPE, FLAGS) { \
    if (mkdir(ROOTDIR DIR, 0755)) { \
        perror("mkdir_bind_" DIR); \
        return 1; \
    } \
    if (mount(SRC, ROOTDIR DIR, TYPE, (FLAGS) | MS_NODEV | MS_NOSUID, NULL)) { \
        perror("mount_bind_" DIR); \
        return 1; \
    } \
    if (mount(SRC, ROOTDIR DIR, TYPE, MS_REMOUNT | (FLAGS) | MS_NODEV | MS_NOSUID, NULL)) { \
        perror("mount_bind_" DIR); \
        return 1; \
    } \
}

#define BINDMOUNT_EX(SRC, DIR, FLAGS) { DOMOUNT(DIR, SRC, NULL, MS_BIND | (FLAGS)); }

#define BINDMOUNT(DIR) { BINDMOUNT_EX(DIR, DIR, MS_RDONLY); }

#define COPYFILE(FILE) { \
    if (fcopy(FILE, ROOTDIR FILE)) { \
        printf("Error copying file " FILE); \
        return 1; \
    } \
}

static int secure_me(int uid, int gid, const char *appdir) {
    if (unshare(CLONE_NEWUSER | CLONE_NEWPID)) {
        perror("CLONE_NEWUSER");
        return 1;
    }

    int fd = open("/proc/self/uid_map", O_WRONLY);
    if(fd < 0) {
        perror("uid_map_open");
        return 1;
    }
    if(dprintf(fd, "%d %d 1\n", uid, uid) < 0) {
        perror("uid_map_dprintf");
        return 1;
    }
    close(fd);

    fd = open("/proc/self/setgroups", O_WRONLY);
    if(fd < 0) {
        perror("setgroups_open");
        return 1;
    }
    if (dprintf(fd, "deny\n") < 0) {
        perror("setgroups_dprintf");
        return 1;
    }
    close(fd);

    fd = open("/proc/self/gid_map", O_WRONLY);
    if(fd < 0) {
        perror("gid_map_open");
        return 1;
    }
    if (dprintf(fd, "%d %d 1\n", gid, gid) < 0) {
        perror("gid_map_dprintf");
        return 1;
    }
    close(fd);

    if (unshare(CLONE_NEWNS)) {
        perror("CLONE_NEWNS");
        return 1;
    }

    if (mount("tmpfs", ROOTDIR, "tmpfs", MS_NOSUID | MS_NODEV, "size=1M")) {
        perror("mount_root");
        return 1;
    }

    if (mkdir(ROOTDIR "/etc", 0755)) {
        perror("mkdir_etc");
        return 1;
    }

    BINDMOUNT("/usr");
    BINDMOUNT("/bin");
    BINDMOUNT("/sbin");
    BINDMOUNT("/lib");
    BINDMOUNT("/lib64");

    BINDMOUNT_EX(appdir, "/app", 0);

    mkdir(ROOTDIR "/app/.tmp", 01777);
    chmod(ROOTDIR "/app/.tmp", 01777);
    symlink("/app/.tmp", ROOTDIR "/tmp");

    COPYFILE("/etc/resolv.conf");
    COPYFILE("/etc/hosts");
    COPYFILE("/etc/passwd");
    COPYFILE("/etc/group");

    const pid_t fpid = fork();
    if (fpid < 0) {
        perror("fork");
        return 1;
    } else if (fpid > 0) {
        waitpid(fpid, NULL, 0);
        exit(0);
        return 1;
    }

    DOMOUNT("/proc", "none", "proc", 0);

    mount("tmpfs", ROOTDIR, "tmpfs", MS_REMOUNT | MS_NODEV | MS_NOSUID | MS_RDONLY, NULL);

    if (chroot(ROOTDIR)) {
        perror("chroot");
        return 1;
    }

    if (chdir("/app")) {
        perror("chdir_root");
        return 1;
    }

    if (setresuid(uid, uid, uid)) {
        perror("setresuid");
        return 1;
    }

    if (setresgid(gid, gid, gid)) {
        perror("setresgid");
        return 1;
    }
}

int main(int argc, char *argv[]) {
    if (argc < 3) {
        printf("Usage: %s appdir program [args...]\n", argv[0]);
    }
    const int uid = getuid();
    const int gid = getgid();

    if (secure_me(uid, gid, argv[1])) {
        return 1;
    }

    return execvp(argv[2], argv + 2);
}