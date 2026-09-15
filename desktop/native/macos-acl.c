/* Read-only macOS ACL bridge. See docs/MACOS-NATIVE-ACL.md.
 * No production injection switches, directory-service queries, or text ACL parser.
 */
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/acl.h>
#include <sys/kauth.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>

static int same(const struct stat *a, const struct stat *b) {
#ifdef __APPLE__
    if (a->st_ctimespec.tv_nsec != b->st_ctimespec.tv_nsec ||
        a->st_mtimespec.tv_nsec != b->st_mtimespec.tv_nsec) return 0;
#else
    /* Linux builds use only the explicitly synthetic test API. */
    if (a->st_ctim.tv_nsec != b->st_ctim.tv_nsec ||
        a->st_mtim.tv_nsec != b->st_mtim.tv_nsec) return 0;
#endif
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino &&
        a->st_mode == b->st_mode && a->st_uid == b->st_uid && a->st_gid == b->st_gid &&
        a->st_ctime == b->st_ctime && a->st_mtime == b->st_mtime;
}

static int path_ok(const char *p) {
    if (!p || p[0] != '/' || strlen(p) >= PATH_MAX) return 0;
    for (const unsigned char *c = (const unsigned char *)p; *c; c++)
        if (*c < 32 || *c == 127) return 0;
    if (!strcmp(p, "/")) return 1;
    const char *s = p + 1;
    for (const char *c = s;; c++) {
        if (*c != '/' && *c) continue;
        size_t n = (size_t)(c - s);
        if (!n || (n == 1 && *s == '.') || (n == 2 && s[0] == '.' && s[1] == '.')) return 0;
        if (!*c) return 1;
        s = c + 1;
    }
}

static int flags_ok(void *object, uint32_t expected, uint32_t known) {
    acl_flagset_t set = NULL;
    if ((expected & ~known) || acl_get_flagset_np(object, &set) != 0 || !set) return 0;
    /* Darwin's flag getter accepts a 32-bit mask, including unknown bits.
     * Check every bit, not just displayed/known fields. */
    for (unsigned bit = 0; bit < 32; bit++) {
        uint32_t mask = UINT32_C(1) << bit;
        int value = acl_get_flag_np(set, (acl_flag_t)mask);
        if (value != !!(expected & mask)) return 0;
    }
    return 1;
}

static int inspect(acl_t acl) {
    int result = 1, allow = 0;
    void *qualifier = NULL;
    struct kauth_filesec *ext = NULL;
    ssize_t size = acl_size(acl);
    if (size < (ssize_t)KAUTH_FILESEC_SIZE(0) || size > (ssize_t)KAUTH_FILESEC_SIZE(ACL_MAX_ENTRIES)) goto done;
    ext = calloc(1, (size_t)size);
    if (!ext || acl_copy_ext_native(ext, acl, size) != size || ext->fsec_magic != KAUTH_FILESEC_MAGIC ||
        ext->fsec_entrycount > ACL_MAX_ENTRIES || size != (ssize_t)KAUTH_FILESEC_SIZE(ext->fsec_entrycount)) goto done;
    if (!flags_ok(acl, ext->fsec_flags, ACL_FLAG_NO_INHERIT | ACL_FLAG_DEFER_INHERIT)) goto done;
    const acl_perm_t perms[] = { ACL_READ_DATA, ACL_WRITE_DATA, ACL_EXECUTE, ACL_DELETE,
        ACL_APPEND_DATA, ACL_DELETE_CHILD, ACL_READ_ATTRIBUTES, ACL_WRITE_ATTRIBUTES,
        ACL_READ_EXTATTRIBUTES, ACL_WRITE_EXTATTRIBUTES, ACL_READ_SECURITY,
        ACL_WRITE_SECURITY, ACL_CHANGE_OWNER, ACL_SYNCHRONIZE };
    acl_permset_mask_t known = 0;
    for (size_t i = 0; i < sizeof(perms)/sizeof(perms[0]); i++) known |= perms[i];
    acl_entry_t entry = NULL;
    for (unsigned i = 0; i < ext->fsec_entrycount; i++) {
        acl_tag_t tag;
        acl_permset_t set = NULL;
        acl_permset_mask_t mask = 0;
        if (acl_get_entry(acl, i ? ACL_NEXT_ENTRY : ACL_FIRST_ENTRY, &entry) != 0 || !entry ||
            acl_get_tag_type(entry, &tag) != 0 || (tag != ACL_EXTENDED_ALLOW && tag != ACL_EXTENDED_DENY)) goto done;
        qualifier = acl_get_qualifier(entry);
        if (!qualifier || memcmp(qualifier, &ext->fsec_ace[i].ace_applicable, sizeof(guid_t))) goto done;
        if (acl_free(qualifier) != 0) { qualifier = NULL; goto done; }
        qualifier = NULL;
        if (acl_get_permset(entry, &set) != 0 || !set || acl_get_permset_mask_np(entry, &mask) != 0 ||
            (mask & ~known) || mask != ext->fsec_ace[i].ace_rights) goto done;
        for (size_t j = 0; j < sizeof(perms)/sizeof(perms[0]); j++)
            if (acl_get_perm_np(set, perms[j]) != !!(mask & perms[j])) goto done;
        uint32_t flags = ext->fsec_ace[i].ace_flags;
        if ((flags & KAUTH_ACE_KINDMASK) != (uint32_t)tag ||
            !flags_ok(entry, flags & ~KAUTH_ACE_KINDMASK, ACL_ENTRY_INHERITED | ACL_ENTRY_FILE_INHERIT |
                ACL_ENTRY_DIRECTORY_INHERIT | ACL_ENTRY_LIMIT_INHERIT | ACL_ENTRY_ONLY_INHERIT)) goto done;
        if (tag == ACL_EXTENDED_ALLOW) allow = 1; /* Even read-only/inherit-only/root allows. */
    }
    /* Darwin returns 0 for an entry and -1/EINVAL both for EOF and invalid ACL.
     * Only exported, checked count proves completeness, never this error alone. */
    errno = 0;
    if (acl_get_entry(acl, ext->fsec_entrycount ? ACL_NEXT_ENTRY : ACL_FIRST_ENTRY, &entry) != -1 || errno != EINVAL) goto done;
    result = allow ? 2 : ext->fsec_entrycount ? 3 : 0;
done:
    if (qualifier && acl_free(qualifier) != 0) result = 1;
    free(ext);
    return result;
}

int main(int argc, char **argv) {
    alarm(2);
    int result = 1, fd = -1, present = -1;
    filesec_t sec = NULL;
    acl_t acl = NULL;
    struct stat before, snapshot, after, named;
    char canonical[PATH_MAX];
    uid_t owner; gid_t group; mode_t mode;
    if (argc != 2 || !path_ok(argv[1]) || !realpath(argv[1], canonical) || strcmp(canonical, argv[1]) ||
        lstat(argv[1], &before) || !S_ISDIR(before.st_mode)) goto done;
    fd = open(argv[1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0 || fstat(fd, &snapshot) || !same(&before, &snapshot)) goto done;
    sec = filesec_init();
    if (!sec || fstatx_np(fd, &snapshot, sec) != 0 || !same(&before, &snapshot) ||
        fpathconf(fd, _PC_EXTENDED_SECURITY_NP) != 1 ||
        filesec_get_property(sec, FILESEC_OWNER, &owner) != 0 || owner != before.st_uid ||
        filesec_get_property(sec, FILESEC_GROUP, &group) != 0 || group != before.st_gid ||
        filesec_get_property(sec, FILESEC_MODE, &mode) != 0 || mode != before.st_mode ||
        filesec_query_property(sec, FILESEC_ACL, &present) != 0 || present < 0) goto done;
    /* Apple returns a validity bitmask, not normalized 0/1. Negative retains
     * the unset/error sentinel; any positive value requires full ACL inspection. */
    /* A successful statx snapshot with populated metadata and an explicit absent
     * FILESEC_ACL is the absence proof. NULL acl_get_link_np is NEVER absence.
     * statx's historical allocation-error path can return zero without populating
     * filesec; the three required properties above reject that path. */
    if (!present) result = 0;
    else {
        if (filesec_get_property(sec, FILESEC_ACL, &acl) != 0 || !acl) goto done;
        result = inspect(acl);
    }
    if (fstat(fd, &after) || lstat(argv[1], &named) || !same(&before, &after) || !same(&before, &named)) result = 1;
done:
    if (acl && acl_free(acl) != 0) result = 1;
    if (sec) filesec_free(sec);
    if (fd >= 0 && close(fd) != 0) result = 1;
    const char *status = result == 0 ? "empty" : result == 3 ? "deny-only" : result == 2 ? "unsafe" : "error";
    if (printf("{\"version\":1,\"status\":\"%s\"}\n", status) < 0 || fflush(stdout)) return 1;
    return result == 3 ? 0 : result;
}
