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
    if (mkdir("/opt" DIR, 0755)) { \
        perror("mkdir_bind_" DIR); \
        return 1; \
    } \
    if (mount(SRC, "/opt" DIR, TYPE, FLAGS, NULL)) { \
        perror("mount_bind_" DIR); \
        return 1; \
    } \
    if (mount(SRC, "/opt" DIR, TYPE, MS_REMOUNT | FLAGS, NULL)) { \
        perror("mount_bind_" DIR); \
        return 1; \
    } \
}

#define BINDMOUNT(DIR) { DOMOUNT(DIR, DIR, NULL, MS_BIND | MS_RDONLY); }

#define COPYFILE(FILE) { \
    if (fcopy(FILE, "/opt" FILE)) { \
        printf("Error copying file " FILE); \
        return 1; \
    } \
}

static int secure_me(int uid, int gid) {
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

    if (mount("tmpfs", "/opt", "tmpfs", 0, NULL)) {
        perror("mount_root");
        return 1;
    }

    if (mkdir("/opt/etc", 0755)) {
        perror("mkdir_etc");
        return 1;
    }

    BINDMOUNT("/usr");
    BINDMOUNT("/bin");
    BINDMOUNT("/sbin");
    BINDMOUNT("/lib");
    BINDMOUNT("/lib64");

    COPYFILE("/etc/resolv.conf");
    COPYFILE("/etc/hosts");

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

	if (chroot("/opt")) {
		perror("chroot");
		return 1;
	}

	if (chdir("/")) {
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
    if (argc < 2) {
        printf("Usage: %s program [args...]\n", argv[0]);
    }
	const int uid = getuid();
	const int gid = getgid();

    if (secure_me(uid, gid)) {
        return 1;
    }

    return execvp(argv[1], argv + 1);
}