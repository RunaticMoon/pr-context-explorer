/* Synthetic API/failure injection, compiled into tests ONLY, never shipped. */
#include <sys/acl.h>
#include <sys/kauth.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <unistd.h>
#include <errno.h>
struct fake_entry { uint32_t flags, perms; int tag; };
struct fake_acl { uint32_t flags; unsigned count, cursor; struct fake_entry entries[2]; };
struct fake_filesec { struct stat st; int populated; };
static char scenario[128];
static struct fake_acl *active;
static int is(const char *s) { return !strcmp(scenario,s); }
long fpathconf(int fd, int name) { (void)fd; (void)name; return is("security-support") ? 0 : is("security-support-error") ? -1 : 1; }
filesec_t filesec_init(void) { return calloc(1,sizeof(struct fake_filesec)); }
void filesec_free(filesec_t s) { free(s); }
int fstatx_np(int fd, struct stat *st, filesec_t s) {
    char link[64], path[4096];
#ifdef __APPLE__
    /* Real Darwin fixtures test real APIs; this synthetic model is Linux-only. */
    (void)link; (void)path; (void)fd; (void)st; (void)s; return -1;
#else
    snprintf(link,sizeof(link),"/proc/self/fd/%d",fd);
    ssize_t n=readlink(link,path,sizeof(path)-1); if(n<0)return -1; path[n]=0;
    snprintf(scenario,sizeof(scenario),"%s",strrchr(path,'/')+1);
    if(is("statx"))return -1;
    if(is("unpopulated"))return 0; /* Libc statx realloc failure before property population. */
    if(fstat(fd,st))return -1;
    s->st=*st; s->populated=1; return 0;
#endif
}
int filesec_query_property(filesec_t s,int prop,int *out) {
    (void)s; (void)prop; if(is("query"))return -1; *out=is("absent") ? 0 : 32; /* Apple FILESEC_ACL uses FS_VALID_ACL (1 << 5). */ return 0;
}
int filesec_get_property(filesec_t s,int prop,void *out) {
    if(!s->populated)return -1;
    if(prop==FILESEC_OWNER) { if(is("owner"))return -1; *(uid_t *)out=s->st.st_uid; }
    if(prop==FILESEC_GROUP) *(gid_t *)out=s->st.st_gid;
    if(prop==FILESEC_MODE) *(mode_t *)out=s->st.st_mode;
    if(prop==FILESEC_ACL) {
        if(is("property"))return -1;
        if(is("null")){*(acl_t *)out=NULL;return 0;}
        active=calloc(1,sizeof(*active)); active->count=is("empty")?0:2;
        for(unsigned i=0;i<2;i++) {
            active->entries[i].tag=(!strncmp(scenario,"allow",5) && (!is("allow-last") || i==1))?ACL_EXTENDED_ALLOW:is("unknown-tag")?7:ACL_EXTENDED_DENY;
            active->entries[i].perms=is("unknown-perm")?(1u<<30):ACL_DELETE;
            if (!strncmp(scenario,"allow-perm-",11)) active->entries[i].perms=1u<<atoi(scenario+11);
            if (is("allow-zero")) active->entries[i].perms=0;
            active->entries[i].flags=is("unknown-flag")?(1u<<30):ACL_ENTRY_INHERITED;
        }
        if(is("acl-flags"))active->flags=(1u<<30);
        *(acl_t *)out=active;
    }
    return 0;
}
ssize_t acl_size(acl_t a) {return is("size")?-1:(ssize_t)KAUTH_FILESEC_SIZE(a->count);}
ssize_t acl_copy_ext_native(void *out,acl_t a,ssize_t size) {
    if(is("copy"))return -1;
    struct kauth_filesec *e=out; memset(e,0,(size_t)size);
    e->fsec_magic=KAUTH_FILESEC_MAGIC; e->fsec_entrycount=is("count")?129:a->count; e->fsec_flags=a->flags;
    for(unsigned i=0;i<a->count;i++){e->fsec_ace[i].ace_flags=a->entries[i].flags|(uint32_t)a->entries[i].tag;e->fsec_ace[i].ace_rights=a->entries[i].perms;}
    return size;
}
int acl_get_entry(acl_t a,int id,acl_entry_t *e) {
    if(id==ACL_FIRST_ENTRY)a->cursor=0;
    if((is("first")&&a->cursor==0)||(is("next")&&a->cursor==1)){errno=EINVAL;return -1;}
    if(a->cursor>=a->count){if(is("end"))return 0;errno=EINVAL;return -1;}
    *e=&a->entries[a->cursor++];return 0;
}
int acl_get_tag_type(acl_entry_t e,acl_tag_t *tag){if(is("tag"))return -1;*tag=e->tag;return 0;}
void *acl_get_qualifier(acl_entry_t e){(void)e;return is("qualifier")?NULL:calloc(1,sizeof(guid_t));}
int acl_get_permset(acl_entry_t e,acl_permset_t *out){if(is("permset"))return -1;*out=&e->perms;return 0;}
int acl_get_permset_mask_np(acl_entry_t e,acl_permset_mask_t *out){if(is("mask"))return -1;*out=e->perms;return 0;}
int acl_get_perm_np(acl_permset_t s,acl_perm_t p){return is("perm")?-1:!!(*s & (uint32_t)p);}
int acl_get_flagset_np(void *e,acl_flagset_t *out){if(is("flagset"))return -1;*out=e==active?&active->flags:&((acl_entry_t)e)->flags;return 0;}
int acl_get_flag_np(acl_flagset_t s,acl_flag_t f){return is("flag")?-1:!!(*s & (uint32_t)f);}
int acl_free(void *p){free(p);return is("free")?-1:0;}
